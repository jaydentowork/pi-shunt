/**
 * pi-shunt extension: gate oversized reads in the parent session, route the
 * parent to bulk-reader via /skill:shunt. Also exposes a /shunt command for
 * editing the threshold, byte ceiling, and worker model without touching env
 * vars or settings files by hand.
 *
 * Pi does not have PreToolUse hooks. The supported interception point is
 * `pi.on("tool_call", ...)`. Returning `{ block: true, reason }` blocks the
 * call.
 *
 * Worker exemption: workers spawned by pi-subagents run in a separate
 * process; this listener is not invoked for their tool calls. There is
 * therefore no per-call exemption check inside this extension.
 *
 * /shunt command subcommands:
 *   threshold <int>   set SHUNT_MIN_LINES
 *   ceiling <int>     set SHUNT_BYTE_CEILING
 *   model [clear]     pick a worker model from the registry
 *   show              print current values
 *   reset             remove all shunt entries from settings
 * No args -> menu.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decideShunt, resolveConfig } from "../src/decide.mjs";
import {
  applyEdits,
  formatSnapshot,
  parsePositiveInt,
  parseSettings,
  readCommonWorkerModel,
  readEnvOverrides,
} from "../src/settings.mjs";

// --- gate ----------------------------------------------------------------

const ENV_MIN_LINES = "SHUNT_MIN_LINES";
const ENV_BYTE_CEILING = "SHUNT_BYTE_CEILING";

type BashInput = { command?: unknown; target?: unknown; [k: string]: unknown };

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

// --- /shunt command helpers ---------------------------------------------

function settingsPath(ctx: ExtensionContext): string {
  // ctx.cwd is the project cwd; the user agent dir lives at ~/.pi/agent.
  // Project-local settings win when present (not currently exposed here).
  const agentDir = (ctx as unknown as { getAgentDir?: () => string }).getAgentDir?.();
  if (typeof agentDir === "string" && agentDir.length > 0) {
    return path.join(agentDir, "settings.json");
  }
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent", "settings.json");
}

function loadSettings(filePath: string): { settings: Record<string, unknown>; existed: boolean } {
  let raw = "";
  let existed = false;
  try {
    raw = fs.readFileSync(filePath, "utf8");
    existed = true;
  } catch {
    existed = false;
  }
  return { settings: parseSettings(raw), existed };
}

function saveSettings(filePath: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function snapshot(settings: Record<string, unknown>) {
  return {
    minLines: readEnvOverrides(settings, ENV_MIN_LINES),
    byteCeiling: readEnvOverrides(settings, ENV_BYTE_CEILING),
    workerModel: readCommonWorkerModel(settings),
  };
}

function listAvailableModels(registry: ExtensionContext["modelRegistry"]): { id: string; label: string }[] {
  const registryAny = registry as unknown as {
    getAll?: () => Array<{ provider: string; id: string; name?: string }>;
    getAvailable?: () => Array<{ provider: string; id: string; name?: string }>;
  };
  const get = registryAny.getAll ?? registryAny.getAvailable;
  if (typeof get !== "function") return [];
  const all = get.call(registry) ?? [];
  const unique = new Map<string, { id: string; label: string }>();
  for (const m of all) {
    if (!m || typeof m.provider !== "string" || typeof m.id !== "string") continue;
    const label = `${m.provider}/${m.id}${m.name ? `  ${m.name}` : ""}`;
    if (!unique.has(label)) unique.set(label, { id: `${m.provider}/${m.id}`, label });
  }
  return Array.from(unique.values()).sort((a, b) => a.label.localeCompare(b.label));
}

async function editThreshold(args: string, ctx: ExtensionContext, filePath: string) {
  const { settings } = loadSettings(filePath);
  const trimmed = args.trim();
  let next: number | null;
  if (trimmed.length === 0) {
    const raw = await ctx.ui.input("SHUNT_MIN_LINES", "350");
    if (raw === undefined) return;
    next = parsePositiveInt(raw);
  } else {
    next = parsePositiveInt(trimmed);
  }
  if (next === null) {
    ctx.ui.notify(`Invalid value: "${trimmed}". Must be a positive integer.`, "error");
    return;
  }
  const updated = applyEdits(settings, { envKey: ENV_MIN_LINES, envValue: String(next) });
  saveSettings(filePath, updated);
  // Apply to the live process so the gate picks it up immediately for this
  // session, without waiting for a reload.
  process.env[ENV_MIN_LINES] = String(next);
  ctx.ui.notify(`SHUNT_MIN_LINES set to ${next}. Applies now.`, "info");
}

async function editCeiling(args: string, ctx: ExtensionContext, filePath: string) {
  const { settings } = loadSettings(filePath);
  const trimmed = args.trim();
  let next: number | null;
  if (trimmed.length === 0) {
    const raw = await ctx.ui.input("SHUNT_BYTE_CEILING", "65536");
    if (raw === undefined) return;
    next = parsePositiveInt(raw);
  } else {
    next = parsePositiveInt(trimmed);
  }
  if (next === null) {
    ctx.ui.notify(`Invalid value: "${trimmed}". Must be a positive integer.`, "error");
    return;
  }
  const updated = applyEdits(settings, { envKey: ENV_BYTE_CEILING, envValue: String(next) });
  saveSettings(filePath, updated);
  process.env[ENV_BYTE_CEILING] = String(next);
  ctx.ui.notify(`SHUNT_BYTE_CEILING set to ${next}. Applies now.`, "info");
}

async function editModel(args: string, ctx: ExtensionContext, filePath: string) {
  const { settings } = loadSettings(filePath);
  const trimmed = args.trim().toLowerCase();

  if (trimmed === "clear" || trimmed === "reset" || trimmed === "none") {
    const updated = applyEdits(settings, { modelId: null });
    saveSettings(filePath, updated);
    ctx.ui.notify("Worker model override cleared. Default in package applies.", "info");
    return;
  }

  const models = listAvailableModels(ctx.modelRegistry);
  if (models.length === 0) {
    ctx.ui.notify("No models in the registry. Add a provider with /login first.", "error");
    return;
  }

  const current = readCommonWorkerModel(settings);
  const choices = [...models.map((m) => m.label), "(clear override — use package default)"];
  const pick = await ctx.ui.select("Worker model (both bulk-reader and code-writer)", choices);
  if (!pick) return;

  if (pick.startsWith("(")) {
    const updated = applyEdits(settings, { modelId: null });
    saveSettings(filePath, updated);
    ctx.ui.notify("Worker model override cleared. Default in package applies.", "info");
    return;
  }

  const match = models.find((m) => m.label === pick);
  if (!match) return;
  const updated = applyEdits(settings, { modelId: match.id });
  saveSettings(filePath, updated);
  ctx.ui.notify(
    `Worker model set to ${match.id}${current ? ` (was ${current})` : ""}. Restart pi (or /reload) to apply.`,
    "info",
  );
}

function show(ctx: ExtensionContext, filePath: string) {
  const { settings } = loadSettings(filePath);
  const lines = [`Settings file: ${filePath}`, formatSnapshot(snapshot(settings))];
  ctx.ui.notify(lines.join("\n"), "info");
}

function reset(ctx: ExtensionContext, filePath: string) {
  const { settings, existed } = loadSettings(filePath);
  let updated = applyEdits(settings, { envKey: ENV_MIN_LINES, envValue: null });
  updated = applyEdits(updated, { envKey: ENV_BYTE_CEILING, envValue: null });
  updated = applyEdits(updated, { modelId: null });
  saveSettings(filePath, updated);
  delete process.env[ENV_MIN_LINES];
  delete process.env[ENV_BYTE_CEILING];
  ctx.ui.notify(
    existed
      ? "Shunt entries cleared from settings.json and live env."
      : "No settings file yet; nothing to clear.",
    "info",
  );
}
async function mainMenu(ctx: ExtensionContext, filePath: string) {
  const pick = await ctx.ui.select("shunt — pick a setting to edit", [
    "show current values",
    "SHUNT_MIN_LINES",
    "SHUNT_BYTE_CEILING",
    "worker model",
    "reset all shunt entries",
    "cancel",
  ]);
  if (!pick || pick === "cancel") return;
  switch (pick) {
    case "show current values":
      return show(ctx, filePath);
    case "SHUNT_MIN_LINES":
      return editThreshold("", ctx, filePath);
    case "SHUNT_BYTE_CEILING":
      return editCeiling("", ctx, filePath);
    case "worker model":
      return editModel("", ctx, filePath);
    case "reset all shunt entries":
      return reset(ctx, filePath);
  }
}

// --- entry point --------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // /shunt command — also covers configuration UI.
  pi.registerCommand("shunt", {
    description: "Configure shunt: threshold, byte ceiling, worker model",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/shunt needs a UI session. Use the env vars instead.", "error");
        return;
      }
      const filePath = settingsPath(ctx);
      const trimmed = args.trim();
      if (trimmed.length === 0) return mainMenu(ctx, filePath);
      const [sub, ...rest] = trimmed.split(/\s+/);
      const restArgs = rest.join(" ");
      switch (sub) {
        case "threshold":
        case "min-lines":
          return editThreshold(restArgs, ctx, filePath);
        case "ceiling":
        case "byte-ceiling":
          return editCeiling(restArgs, ctx, filePath);
        case "model":
          return editModel(restArgs, ctx, filePath);
        case "show":
        case "status":
          return show(ctx, filePath);
        case "reset":
        case "clear":
          return reset(ctx, filePath);
        case "help":
        case "--help":
        case "-h":
          ctx.ui.notify(
            [
              "Usage:",
              "  /shunt                       menu",
              "  /shunt threshold <int>       set SHUNT_MIN_LINES",
              "  /shunt ceiling <int>         set SHUNT_BYTE_CEILING",
              "  /shunt model [clear]         set worker model",
              "  /shunt show                  show current values",
              "  /shunt reset                 remove all shunt entries",
            ].join("\n"),
            "info",
          );
          return;
        default:
          ctx.ui.notify(`Unknown subcommand: "${sub}". Try /shunt help.`, "error");
      }
    },
  });

  // Tool-call gate for oversized reads.
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
      notify(decision.reason);
      return { block: true, reason: decision.reason };
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
