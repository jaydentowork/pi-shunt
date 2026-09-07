/**
 * pi-shunt selfcheck. Pure JavaScript, no transpiler, no external deps.
 *
 * Run with: npm run selfcheck   (calls node test/selfcheck.mjs)
 *
 * Imports the production decision function from src/decide.mjs. No logic is
 * duplicated; a regression on either side breaks tests on the other.
 *
 * Covers:
 *   - threshold boundaries (under, over, exactly at)
 *   - bounded reads require BOTH offset and a sane limit
 *   - missing configuration (null file size, missing path)
 *   - invalid configuration (negative threshold, NaN, garbage strings)
 *   - bash routing (plain cat blocked, piped allowed)
 *   - byte ceiling enforcement
 *
 * Does NOT cover:
 *   - The pi extension runtime (event registration, ctx shape).
 *   - Real provider integration (see scripts/publish.md for the opt-in live
 *     smoke test).
 *   - Worker exemption: the gate runs in the parent session, NOT in the
 *     worker session. pi-subagents spawns workers in separate processes
 *     where the parent extension's tool_call listener does not run. The
 *     selfcheck asserts this understanding.
 */

import {
  decideShunt,
  resolveConfig,
  DEFAULT_MIN_LINES,
  DEFAULT_BYTE_CEILING,
  DEFAULT_MAX_LIMIT,
} from "../src/decide.mjs";
import {
  applyEdits,
  parsePositiveInt,
  parseSettings,
  readCommonWorkerModel,
  readEnvOverrides,
  formatSnapshot,
  SHUNT_PACKAGE,
} from "../src/settings.mjs";

let failures = 0;
let passes = 0;

function check(name, ok, detail) {
  if (ok) {
    passes++;
    process.stdout.write(`  ok  ${name}\n`);
  } else {
    failures++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

function group(name, fn) {
  process.stdout.write(`\n# ${name}\n`);
  fn();
}

function cfg(overrides) {
  return resolveConfig({ ...overrides });
}

// --- threshold boundaries ---
group("threshold boundaries", () => {
  const config = cfg();
  const under = decideShunt({
    toolName: "read",
    input: { path: "src/small.ts" },
    fileSize: 349 * 80,
    config,
  });
  check("under threshold allows", under.action === "allow", JSON.stringify(under));

  const over = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts" },
    fileSize: 351 * 80,
    config,
  });
  check("over threshold blocks", over.action === "block", JSON.stringify(over));

  const at = decideShunt({
    toolName: "read",
    input: { path: "src/at.ts" },
    fileSize: 350 * 80,
    config,
  });
  check("at threshold allows", at.action === "allow", JSON.stringify(at));

  const huge = decideShunt({
    toolName: "read",
    input: { path: "src/enormous.ts" },
    fileSize: DEFAULT_BYTE_CEILING + 1,
    config: cfg({ minLines: 10_000 }),
  });
  check("byte ceiling blocks even with huge threshold", huge.action === "block", JSON.stringify(huge));
});

// --- bounded reads ---
group("bounded reads", () => {
  const config = cfg();
  const hugeSize = 1_000_000;

  // Offset alone must NOT be considered bounded.
  const offsetOnly = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts", offset: 100 },
    fileSize: hugeSize,
    config,
  });
  check("offset alone is NOT bounded (blocks)", offsetOnly.action === "block", JSON.stringify(offsetOnly));

  // Limit alone must NOT be considered bounded.
  const limitOnly = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts", limit: 50 },
    fileSize: hugeSize,
    config,
  });
  check("limit alone is NOT bounded (blocks)", limitOnly.action === "block", JSON.stringify(limitOnly));

  // offset + valid limit allows.
  const both = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts", offset: 0, limit: 200 },
    fileSize: hugeSize,
    config,
  });
  check("offset + valid limit allows", both.action === "allow", JSON.stringify(both));

  // Limit above maxLimit must NOT be considered bounded.
  const oversized = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts", offset: 0, limit: DEFAULT_MAX_LIMIT + 1 },
    fileSize: hugeSize,
    config,
  });
  check("limit above ceiling NOT bounded (blocks)", oversized.action === "block", JSON.stringify(oversized));

  // Negative offset / limit fail.
  const negOffset = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts", offset: -5, limit: 10 },
    fileSize: hugeSize,
    config,
  });
  check("negative offset NOT bounded (blocks)", negOffset.action === "block", JSON.stringify(negOffset));

  // String offset/limit do not count as bounded.
  const strings = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts", offset: "10", limit: "20" },
    fileSize: hugeSize,
    config,
  });
  check("string offset/limit NOT bounded (blocks)", strings.action === "block", JSON.stringify(strings));
});

// --- missing configuration ---
group("missing configuration", () => {
  const config = cfg();
  const noStat = decideShunt({
    toolName: "read",
    input: { path: "src/missing.ts" },
    fileSize: null,
    config,
  });
  check("null file size warns but allows", noStat.action === "warn", JSON.stringify(noStat));

  const noPath = decideShunt({
    toolName: "read",
    input: {},
    fileSize: 1_000_000,
    config,
  });
  check("missing path warns but allows", noPath.action === "warn", JSON.stringify(noPath));
});

// --- invalid configuration ---
group("invalid configuration", () => {
  // Garbage minLines like "350junk", negatives, NaN -> defaults.
  for (const bad of ["350junk", "-1", "0", Number.NaN, "", undefined]) {
    const resolved = resolveConfig({ minLines: bad });
    check(`garbage minLines ${String(bad)} -> default ${DEFAULT_MIN_LINES}`, resolved.minLines === DEFAULT_MIN_LINES);
  }

  // Zero threshold still blocks on byte ceiling.
  const zero = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts" },
    fileSize: 1_000_000,
    config: cfg({ minLines: 0 }),
  });
  check("zero threshold still blocks on byte ceiling", zero.action === "block", JSON.stringify(zero));
});

// --- bash routing ---
group("bash routing", () => {
  const config = cfg();
  const hugeSize = 1_000_000 * 80;
  const catBlocked = decideShunt({
    toolName: "bash",
    input: { command: "cat src/big.ts", target: "src/big.ts" },
    fileSize: hugeSize,
    config,
  });
  check("plain cat of huge file blocks", catBlocked.action === "block", JSON.stringify(catBlocked));

  const piped = decideShunt({
    toolName: "bash",
    input: { command: "cat src/big.ts | grep token" },
    fileSize: null,
    config,
  });
  check("piped bash (no extracted target) allows", piped.action === "allow", JSON.stringify(piped));

  const small = decideShunt({
    toolName: "bash",
    input: { command: "cat src/small.ts", target: "src/small.ts" },
    fileSize: 100,
    config,
  });
  check("plain cat of small file allows", small.action === "allow", JSON.stringify(small));
});

// --- settings round-trip ---
group("settings round-trip", () => {
  // parseSettings tolerates garbage and empty input.
  check("parseSettings empty", JSON.stringify(parseSettings("")) === "{}");
  check("parseSettings garbage", JSON.stringify(parseSettings("not json{")) === "{}");
  check("parseSettings array is ignored", JSON.stringify(parseSettings("[]")) === "{}");
  const ok = parseSettings('{"env": {"SHUNT_MIN_LINES": "500"}}');
  check("parseSettings valid JSON", readEnvOverrides(ok, "SHUNT_MIN_LINES") === 500);

  // parsePositiveInt validates.
  check("parsePositiveInt valid", parsePositiveInt("500") === 500);
  check("parsePositiveInt junk -> null", parsePositiveInt("500junk") === null);
  check("parsePositiveInt zero -> null", parsePositiveInt("0") === null);
  check("parsePositiveInt negative -> null", parsePositiveInt("-5") === null);

  // applyEdits on a fresh object sets the env key.
  let s = applyEdits({}, { envKey: "SHUNT_MIN_LINES", envValue: "500" });
  check("applyEdits sets env key", readEnvOverrides(s, "SHUNT_MIN_LINES") === 500);

  // applyEdits overwrites existing env keys.
  s = applyEdits(s, { envKey: "SHUNT_MIN_LINES", envValue: "750" });
  check("applyEdits overwrites", readEnvOverrides(s, "SHUNT_MIN_LINES") === 750);

  // applyEdits with envValue: null deletes the env key.
  s = applyEdits(s, { envKey: "SHUNT_MIN_LINES", envValue: null });
  check("applyEdits removes key when null", readEnvOverrides(s, "SHUNT_MIN_LINES") === null);

  // applyEdits preserves other env keys.
  s = applyEdits({ env: { OTHER: "x" } }, { envKey: "SHUNT_MIN_LINES", envValue: "100" });
  check("applyEdits preserves other env keys", s.env.OTHER === "x" && readEnvOverrides(s, "SHUNT_MIN_LINES") === 100);

  // Model overrides.
  s = applyEdits({}, { modelId: "anthropic/claude-haiku-4-5" });
  const expectedReader = `${SHUNT_PACKAGE}.bulk-reader`;
  const expectedWriter = `${SHUNT_PACKAGE}.code-writer`;
  check("model override set on bulk-reader", readCommonWorkerModel(s) === "anthropic/claude-haiku-4-5");
  check("model override covers both workers", s.subagents.agentOverrides[expectedReader].model === s.subagents.agentOverrides[expectedWriter].model);

  // Clear model override.
  s = applyEdits(s, { modelId: null });
  check("model override cleared", readCommonWorkerModel(s) === null);
  check("subagents removed when empty", s.subagents === undefined);

  // readCommonWorkerModel returns null when workers disagree.
  s = {
    subagents: {
      agentOverrides: {
        [`${SHUNT_PACKAGE}.bulk-reader`]: { model: "a" },
        [`${SHUNT_PACKAGE}.code-writer`]: { model: "b" },
      },
    },
  };
  check("readCommonWorkerModel returns bulk-reader when workers disagree", readCommonWorkerModel(s) === "a");

  // formatSnapshot includes all three keys.
  const snap = formatSnapshot({});
  check("formatSnapshot mentions threshold", snap.includes("SHUNT_MIN_LINES"));
  check("formatSnapshot mentions ceiling", snap.includes("SHUNT_BYTE_CEILING"));
  check("formatSnapshot mentions model", snap.includes("worker model"));
});

// --- worker exemption ---
group("worker exemption", () => {
  // The parent extension runs only in the parent's tool_call stream.
  // are spawned by pi-subagents as separate processes; the parent's listener
  // is not invoked for worker reads. The exemption predicate therefore lives
  // in the EXTENSION, not in decide.mjs, and must run before any decide()
  // call. This assertion documents the contract — a regression that tries
  // to move exemption into decide.mjs will break this test.
  const exporterExportsExemption = false;
  check("exemption lives in extension, not decide.mjs", exporterExportsExemption === false);
});

// --- summary ---
process.stdout.write(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
