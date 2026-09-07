/**
 * pi-shunt extension: gate oversized reads, route the parent to bulk-reader.
 *
 * Pi does not have PreToolUse hooks. The supported interception point is
 * `pi.on("tool_call", ...)`. Returning `{ block: true, reason }` blocks the call.
 *
 * The decision function lives in `test/decide.ts` so the selfcheck can call
 * it directly without booting the extension runtime.
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decideShunt, SHUNT_CONSTANTS } from "../test/decide.js";

type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

type BlockResult = { block: true; reason: string };

type SessionLike = {
  agentName?: string;
  packageName?: string;
  role?: string;
  parentAgent?: string;
};

type CtxLike = {
  ui?: { notify: (msg: string, level?: string) => void };
  sessionInfo?: SessionLike;
  hasUI?: boolean;
};

const SHUNT_PACKAGE = "pi-shunt";
const WORKER_NAMES = new Set(["bulk-reader", "code-writer"]);

function isWorkerSession(ctx: CtxLike | undefined): boolean {
  const info = ctx?.sessionInfo;
  if (!info) return false;
  if (info.packageName === SHUNT_PACKAGE && info.agentName && WORKER_NAMES.has(info.agentName)) {
    return true;
  }
  if (info.role === "subagent" && info.parentAgent?.startsWith(`${SHUNT_PACKAGE}.`)) {
    return true;
  }
  return false;
}

function notify(ctx: CtxLike, message: string): void {
  if (ctx.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(message, "warn");
  }
}

function statOrNull(path: string): number | null {
  try {
    return fs.statSync(path).size;
  } catch {
    return null;
  }
}

function bashTargetFile(command: string): string | null {
  // Best-effort: plain `cat file`, `head file`, `tail file`, `less file`,
  // `more file` only. Anything with pipes, redirects, or flags that change
  // the read shape is left alone. This is not a security boundary.
  const trimmed = command.trim();
  if (/[<>|]/.test(trimmed)) return null;
  const match = trimmed.match(/^(?:cat|head|tail|less|more)\s+(?<path>\S+)$/);
  return match?.groups?.path ?? null;
}

function resolveMinLines(): number {
  const raw = process.env.SHUNT_MIN_LINES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SHUNT_CONSTANTS.DEFAULT_MIN_LINES;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event: ToolCallEvent, ctx: CtxLike): Promise<BlockResult | void> => {
    // Worker sessions are exempt; recursion would deadlock the worker.
    if (isWorkerSession(ctx)) return;

    const minLines = resolveMinLines();

    if (event.toolName === "read") {
      const path = typeof event.input.path === "string" ? event.input.path : null;
      if (!path) return;
      const decision = decideShunt({
        toolName: "read",
        input: event.input,
        fileSize: statOrNull(path),
        minLines,
      });
      if (decision.action === "block") {
        notify(ctx, decision.reason);
        return { block: true, reason: decision.reason };
      }
      if (decision.action === "warn") {
        notify(ctx, decision.reason);
      }
      return;
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const target = bashTargetFile(command);
      if (!target) return;
      const decision = decideShunt({
        toolName: "bash",
        input: { command, target },
        fileSize: statOrNull(target),
        minLines,
      });
      if (decision.action === "block") {
        notify(ctx, decision.reason);
        return { block: true, reason: decision.reason };
      }
      if (decision.action === "warn") {
        notify(ctx, decision.reason);
      }
    }
  });
}
