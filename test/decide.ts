/**
 * Pure decision function for the shunt gate.
 *
 * No fs, no I/O. The caller passes `fileSize` (bytes) when it has it; we use it
 * to enforce the byte ceiling. The extension handles stat lookups; the
 * selfcheck builds fixtures in memory.
 *
 * Decision shape:
 *   - "allow"      — call proceeds
 *   - "block"      — caller should return { block: true, reason }
 *   - "warn"       — caller should surface the message but allow the call
 *
 * "warn" exists for cases where we cannot prove the file is small but also
 * cannot prove it is large (missing stat, malformed input). We err on the side
 * of letting the call through with a hint, rather than deadlocking the parent.
 */

export type ShuntInput = {
  toolName: "read" | "bash";
  input: Record<string, unknown>;
  /** File size in bytes. `null` if unknown. */
  fileSize: number | null;
  /** Threshold from SHUNT_MIN_LINES env var. Default 350. */
  minLines: number;
};

export type ShuntDecision =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "warn"; reason: string };

const BYTE_CEILING = 65_536;

/** Approximate line count for a file of `byteSize` bytes. */
function estimateLines(byteSize: number): number {
  // Conservative: assume 80 chars/line on average. Real number is usually
  // smaller, so we may block a few extra times — that is acceptable.
  return Math.ceil(byteSize / 80);
}

function readLooksBounded(input: Record<string, unknown>): boolean {
  // A targeted read has either offset or limit set.
  return input.offset !== undefined || input.limit !== undefined;
}

function readFilePath(input: Record<string, unknown>): string | null {
  if (typeof input.path !== "string" || input.path.length === 0) return null;
  return input.path;
}

export function decideShunt({ toolName, input, fileSize, minLines }: ShuntInput): ShuntDecision {
  if (toolName === "read") {
    const path = readFilePath(input);
    if (!path) {
      return { action: "warn", reason: "shunt: read call has no path; allowing." };
    }
    if (readLooksBounded(input)) {
      return { action: "allow" };
    }
    if (fileSize === null) {
      return {
        action: "warn",
        reason: `shunt: cannot stat ${path}; allow and consider /skill:shunt for large-file delegation.`,
      };
    }
    if (fileSize > BYTE_CEILING) {
      return {
        action: "block",
        reason: `shunt: ${path} is ${fileSize}B (>${BYTE_CEILING}B ceiling). Use /skill:shunt -> bulk-reader.`,
      };
    }
    const estimated = estimateLines(fileSize);
    if (estimated > minLines) {
      return {
        action: "block",
        reason: `shunt: ${path} is ~${estimated} lines (>${minLines}). Use /skill:shunt -> bulk-reader. Pass offset/limit for a targeted read.`,
      };
    }
    return { action: "allow" };
  }

  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const target = typeof input.target === "string" ? input.target : null;
    if (!target) {
      // bash parsing gave up or target not extracted. Allow.
      return { action: "allow" };
    }
    if (fileSize === null) {
      return {
        action: "warn",
        reason: `shunt: cannot stat ${target}; allow and pipe via grep/head -N for targeted reads.`,
      };
    }
    const estimated = estimateLines(fileSize);
    if (estimated > minLines) {
      return {
        action: "block",
        reason: `shunt: bash read of ${target} is ~${estimated} lines. Pipe through head/grep for targeted reads, or use /skill:shunt -> bulk-reader.`,
      };
    }
    return { action: "allow" };
  }

  return { action: "allow" };
}

/** Exposed for the selfcheck and for downstream tools that want the same constants. */
export const SHUNT_CONSTANTS = {
  BYTE_CEILING,
  DEFAULT_MIN_LINES: 350,
} as const;
