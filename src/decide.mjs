/**
 * Pure decision logic for the shunt gate.
 *
 * Source of truth. Imported by both the extension (via jiti's `.js` -> `.mjs`
 * resolution) and the selfcheck (plain `node`). No I/O, no fs.
 *
 * Shapes:
 *   - input.fileSize: byte size if known, otherwise null
 *   - input.minLines: configured threshold (already parsed as a positive int,
 *     or 0 to mean "use default")
 *   - input.byteCeiling: configured byte ceiling
 *
 * Returns one of:
 *   - { action: "allow" }                 — proceed
 *   - { action: "block", reason }         — caller returns { block: true, reason }
 *   - { action: "warn", reason }          — caller surfaces a hint but allows
 *
 * "warn" exists when we cannot prove the file is large but also cannot prove
 * it is small (stat failed, malformed input). The gate errs on the side of
 * letting the call through, with a hint, rather than deadlocking the parent.
 */

export const DEFAULT_MIN_LINES = 350;
export const DEFAULT_BYTE_CEILING = 65_536;
export const DEFAULT_MAX_LIMIT = 200;

/**
 * Estimate line count from byte size using 80 chars/line as a conservative
 * average. Real files average lower, so this may block a few extra cases —
 * acceptable.
 */
export function estimateLinesFromBytes(byteSize) {
  return Math.ceil(byteSize / 80);
}

function asPositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * A read is bounded only when BOTH offset and limit are valid positive
 * integers within the configured ceiling. An offset alone is NOT bounded —
 * a huge offset still triggers a huge read.
 */
export function isReadBounded(input, opts) {
  const maxLimit = opts?.maxLimit ?? DEFAULT_MAX_LIMIT;
  const offset = input.offset;
  const limit = input.limit;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || limit > maxLimit) {
    return false;
  }
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) {
    return false;
  }
  return true;
}

function parseMinLines(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MIN_LINES;
  return n;
}

/**
 * Resolve configuration from raw inputs. Centralises validation: junk like
 * "350abc" becomes the default; negatives become the default.
 */
export function resolveConfig({ minLines, byteCeiling } = {}) {
  return {
    minLines: parseMinLines(minLines ?? DEFAULT_MIN_LINES),
    byteCeiling: asPositiveInt(byteCeiling, DEFAULT_BYTE_CEILING),
    maxLimit: DEFAULT_MAX_LIMIT,
  };
}

/**
 * Decide whether to allow a tool call.
 *
 * @param {object} args
 * @param {"read"|"bash"} args.toolName
 * @param {Record<string, unknown>} args.input
 * @param {number|null} args.fileSize   bytes if known, else null
 * @param {object} args.config          output of resolveConfig
 */
export function decideShunt({ toolName, input, fileSize, config }) {
  const cfg = config ?? resolveConfig({});

  if (toolName === "read") {
    const path = typeof input.path === "string" ? input.path : null;
    if (!path) {
      return { action: "warn", reason: "shunt: read call has no path; allowing." };
    }
    if (isReadBounded(input, cfg)) {
      return { action: "allow" };
    }
    if (fileSize === null) {
      return {
        action: "warn",
        reason: `shunt: cannot stat ${path}; allow and consider /skill:shunt-routing for large-file delegation.`,
      };
    }
    if (fileSize > cfg.byteCeiling) {
      return {
        action: "block",
        reason: `shunt: ${path} is ${fileSize}B (>${cfg.byteCeiling}B ceiling). Use /skill:shunt-routing -> bulk-reader.`,
      };
    }
    const estimated = estimateLinesFromBytes(fileSize);
    if (estimated > cfg.minLines) {
      return {
        action: "block",
        reason: `shunt: ${path} is ~${estimated} lines (>${cfg.minLines}). Use /skill:shunt-routing -> bulk-reader. Pass offset+limit (limit <= ${cfg.maxLimit}) for a targeted read.`,
      };
    }
    return { action: "allow" };
  }

  if (toolName === "bash") {
    const target = typeof input.target === "string" ? input.target : null;
    if (!target) return { action: "allow" };
    if (fileSize === null) {
      return {
        action: "warn",
        reason: `shunt: cannot stat ${target}; allow and pipe via grep/head -N for targeted reads.`,
      };
    }
    const estimated = estimateLinesFromBytes(fileSize);
    if (estimated > cfg.minLines) {
      return {
        action: "block",
        reason: `shunt: bash read of ${target} is ~${estimated} lines. Pipe through head/grep for targeted reads, or use /skill:shunt-routing -> bulk-reader.`,
      };
    }
    return { action: "allow" };
  }

  return { action: "allow" };
}
