/**
 * Pure helpers for reading and writing the user settings file.
 *
 * Source of truth: `~/.pi/agent/settings.json`. Used by the /shunt command to
 * persist threshold, byte ceiling, and worker model edits without editing
 * installed package files. Pure: no I/O, no fs. The caller passes the file
 * path so the same module works in tests.
 */

export const SHUNT_PACKAGE = "pi-shunt";
export const WORKER_NAMES = ["bulk-reader", "code-writer"];

/**
 * Deep-clone via structuredClone. Standalone helper so older Node versions
 * without the global still work after one polyfill import (none required on
 * Node 18+).
 */
export function clone(value) {
  return structuredClone(value);
}

/**
 * Read a JSON file path. Returns the parsed object, or an empty object when
 * the file is missing or malformed. The caller handles `null`/missing.
 */
export function parseSettings(text) {
  if (typeof text !== "string" || text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Read the current SHUNT_MIN_LINES and SHUNT_BYTE_CEILING from the env block
 * of settings. Returns `null` when the value is missing or not a positive
 * integer.
 */
export function readEnvOverrides(settings, key) {
  const env = settings && typeof settings.env === "object" && settings.env !== null ? settings.env : {};
  const raw = env[key];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Read the current worker model from `subagents.agentOverrides.<runtime>`.
 * Returns the string id, or null when unset.
 */
export function readWorkerModel(settings, agentRuntime) {
  const overrides = path(settings, ["subagents", "agentOverrides"]);
  if (!overrides || typeof overrides !== "object") return null;
  const entry = overrides[agentRuntime];
  if (!entry || typeof entry !== "object") return null;
  const model = entry.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

/**
 * Read the worker model for both workers. Returns the value if they agree,
 * otherwise the bulk-reader value (or null).
 */
export function readCommonWorkerModel(settings) {
  const a = readWorkerModel(settings, `${SHUNT_PACKAGE}.${WORKER_NAMES[0]}`);
  const b = readWorkerModel(settings, `${SHUNT_PACKAGE}.${WORKER_NAMES[1]}`);
  if (a !== null && b !== null && a === b) return a;
  return a;
}

/**
 * Build a fresh settings object with the requested edits merged in.
 *
 * - `envKey`: which env var to set (e.g. "SHUNT_MIN_LINES")
 * - `envValue`: string value to set, or null to remove
 * - `modelId`: provider/model-id to set for both workers, or null to remove
 *
 * Mutates a deep clone; returns the clone. Caller writes the result.
 */
export function applyEdits(settings, { envKey, envValue, modelId }) {
  const next = clone(settings);

  // Editors who set env values must end up with an `env` object.
  if (envKey) {
    const env = next.env && typeof next.env === "object" && !Array.isArray(next.env) ? next.env : {};
    if (envValue === null || envValue === undefined) {
      delete env[envKey];
    } else {
      env[envKey] = envValue;
    }
    next.env = env;
  }

  if (modelId !== undefined) {
    const overrides = path(next, ["subagents", "agentOverrides"]);
    const base =
      overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {};
    if (modelId === null || modelId === "") {
      for (const name of WORKER_NAMES) {
        const key = `${SHUNT_PACKAGE}.${name}`;
        if (base[key] && typeof base[key] === "object") {
          delete base[key].model;
          if (Object.keys(base[key]).length === 0) delete base[key];
        }
      }
    } else {
      for (const name of WORKER_NAMES) {
        const key = `${SHUNT_PACKAGE}.${name}`;
        const entry = base[key] && typeof base[key] === "object" ? base[key] : {};
        entry.model = modelId;
        base[key] = entry;
      }
    }
    if (Object.keys(base).length === 0) {
      delete next.subagents;
    } else {
      next.subagents = { ...(next.subagents || {}), agentOverrides: base };
    }
  }

  return next;
}

function path(obj, segments) {
  let cur = obj;
  for (const seg of segments) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Validate a candidate integer. Returns the integer when valid, null when
 * garbage. Matches `parseMinLines` semantics from decide.mjs.
 */
export function parsePositiveInt(value) {
  // Strict: digits only, no leading sign except for the optional +. We
  // explicitly reject "500junk" because Number.parseInt silently parses it.
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  if (!/^\+?\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Format a settings snapshot as a small block for the `/shunt show` output.
 * Kept short on purpose.
 */
export function formatSnapshot(snapshot) {
  const lines = [];
  lines.push(`SHUNT_MIN_LINES:    ${snapshot.minLines ?? "(default 350)"}`);
  lines.push(`SHUNT_BYTE_CEILING: ${snapshot.byteCeiling ?? "(default 65536)"}`);
  lines.push(`worker model:       ${snapshot.workerModel ?? "(default anthropic/claude-haiku-4-5)"}`);
  return lines.join("\n");
}
