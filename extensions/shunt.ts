/**
 * pi-shunt extension: gate oversized reads in the parent session, route the
 * parent to bulk-reader via /skill:shunt.
 *
 * Pi does not have PreToolUse hooks. The supported interception point is
 * `pi.on("tool_call", ...)`. Returning `{ block: true, reason }` blocks the
 * call. Mutation of `event.input` in place is also supported (used here to
 * fall back to a bounded read on `read` calls with no limit).
 *
 * The decision function lives in src/decide.mjs so the selfcheck exercises
 * the exact same logic.
 *
 * Worker exemption: workers spawned by pi-subagents run in a separate
 * process; this listener is not invoked for their tool calls. There is
 * therefore no per-call exemption check inside this extension — the
 * recursion concern Spotify describes does not apply on pi.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decideShunt, resolveConfig } from "../src/decide.mjs";

type BashInput = { command?: unknown; target?: unknown; [k: string]: unknown };

/**
 * Best-effort: pull a single file path out of plain `cat|head|tail|less|more`
 * invocations. Anything more complex is left alone. This is not a security
 * boundary.
 */
function bashTargetFile(command: string): string | null {
  const trimmed = command.trim();
  if (/[<>|]/.test(trimmed)) return null;
  const match = trimmed.match(/^(?:cat|head|tail|less|more)\s+(?<path>\S+)$/);
  return match?.groups?.path ?? null;
}

function statOrNull(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

function resolveAgainst(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx: ExtensionContext) => {
    const config = resolveConfig({
      minLines: process.env.SHUNT_MIN_LINES,
      byteCeiling: process.env.SHUNT_BYTE_CEILING,
    });
    const notify = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    };

    if (event.toolName === "read") {
      const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
      const rawPath = typeof input.path === "string" ? input.path : null;
      if (!rawPath) return;
      const resolved = resolveAgainst(ctx.cwd, rawPath);
      const decision = decideShunt({
        toolName: "read",
        input: { path: resolved, offset: input.offset, limit: input.limit },
        fileSize: statOrNull(resolved),
        config,
      });

      if (decision.action === "allow") return;

      if (decision.action === "warn") {
        notify(decision.reason);
        return;
      }

      // block: hard-block the parent. The skill instructs the LLM to
      // delegate to bulk-reader instead. Silently truncating would hide
      // the cost we're trying to surface.
      notify(decision.reason);
      return { block: true, reason: decision.reason };
      return;
    }

    if (event.toolName === "bash") {
      const input = event.input as BashInput;
      const command = typeof input.command === "string" ? input.command : "";
      const target = bashTargetFile(command);
      if (!target) return;
      const resolved = resolveAgainst(ctx.cwd, target);
      const decision = decideShunt({
        toolName: "bash",
        input: { command, target: resolved },
        fileSize: statOrNull(resolved),
        config,
      });

      if (decision.action === "allow") return;
      if (decision.action === "warn") {
        notify(decision.reason);
        return;
      }
      notify(decision.reason);
      return { block: true, reason: decision.reason };
    }
  });
}
