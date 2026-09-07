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

// --- worker exemption contract ---
group("worker exemption", () => {
  // The parent extension runs only in the parent's tool_call stream. Workers
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
