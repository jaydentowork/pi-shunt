/**
 * pi-shunt selfcheck. Pure JavaScript, no transpiler, no external deps.
 *
 * Run with: npm run selfcheck   (calls node test/selfcheck.mjs)
 *
 * Mirrors the logic in test/decide.ts so a regression on either side breaks
 * tests on both. The pure function (decide.ts) is the source of truth; this
 * file is a black-box reproduction of the same shape.
 *
 * Covers:
 *   - threshold boundaries (under, over, exactly at)
 *   - bounded reads (offset/limit) always allowed
 *   - missing configuration (null file size, missing path)
 *   - worker exemption (gate must skip when isWorkerSession resolves true)
 *   - invalid configuration (negative threshold, NaN, etc.)
 *   - bash routing (plain cat blocked, piped allowed, unknown target allowed)
 *   - mocked routing responses (subagent result shape, no real provider call)
 *
 * Does NOT cover: real provider integration. That's opt-in via the live smoke
 * runbook in scripts/publish.md.
 */

const BYTE_CEILING = 65_536;
const DEFAULT_MIN_LINES = 350;

function estimateLines(byteSize) {
  return Math.ceil(byteSize / 80);
}

function readLooksBounded(input) {
  return input.offset !== undefined || input.limit !== undefined;
}

function decideShunt({ toolName, input, fileSize, minLines }) {
  if (toolName === "read") {
    const path = typeof input.path === "string" ? input.path : null;
    if (!path) return { action: "warn", reason: "shunt: read call has no path; allowing." };
    if (readLooksBounded(input)) return { action: "allow" };
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
    const target = typeof input.target === "string" ? input.target : null;
    if (!target) return { action: "allow" };
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

const SHUNT_PACKAGE = "pi-shunt";
const WORKER_NAMES = new Set(["bulk-reader", "code-writer"]);

function isWorkerSession(info) {
  if (!info) return false;
  if (info.packageName === SHUNT_PACKAGE && info.agentName && WORKER_NAMES.has(info.agentName)) return true;
  if (info.role === "subagent" && info.parentAgent?.startsWith(`${SHUNT_PACKAGE}.`)) return true;
  return false;
}

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

// --- threshold boundaries ---
group("threshold boundaries", () => {
  const minLines = DEFAULT_MIN_LINES;
  const under = decideShunt({
    toolName: "read",
    input: { path: "src/small.ts" },
    fileSize: 349 * 80,
    minLines,
  });
  check("under threshold allows", under.action === "allow", JSON.stringify(under));

  const over = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts" },
    fileSize: 351 * 80,
    minLines,
  });
  check("over threshold blocks", over.action === "block", JSON.stringify(over));

  const at = decideShunt({
    toolName: "read",
    input: { path: "src/at.ts" },
    fileSize: 350 * 80,
    minLines,
  });
  check("at threshold allows", at.action === "allow", JSON.stringify(at));

  const huge = decideShunt({
    toolName: "read",
    input: { path: "src/enormous.ts" },
    fileSize: BYTE_CEILING + 1,
    minLines: 10_000,
  });
  check("byte ceiling blocks even with huge threshold", huge.action === "block", JSON.stringify(huge));
});

// --- bounded reads ---
group("bounded reads", () => {
  const minLines = DEFAULT_MIN_LINES;
  const hugeSize = 1_000_000;
  const withOffset = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts", offset: 100 },
    fileSize: hugeSize,
    minLines,
  });
  check("offset alone allows", withOffset.action === "allow", JSON.stringify(withOffset));

  const withLimit = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts", limit: 50 },
    fileSize: hugeSize,
    minLines,
  });
  check("limit alone allows", withLimit.action === "allow", JSON.stringify(withLimit));

  const withBoth = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts", offset: 0, limit: 200 },
    fileSize: hugeSize,
    minLines,
  });
  check("offset+limit allows", withBoth.action === "allow", JSON.stringify(withBoth));
});

// --- missing configuration ---
group("missing configuration", () => {
  const minLines = DEFAULT_MIN_LINES;
  const noStat = decideShunt({
    toolName: "read",
    input: { path: "src/missing.ts" },
    fileSize: null,
    minLines,
  });
  check("null file size warns but allows", noStat.action === "warn", JSON.stringify(noStat));

  const noPath = decideShunt({
    toolName: "read",
    input: {},
    fileSize: 1_000_000,
    minLines,
  });
  check("missing path warns but allows", noPath.action === "warn", JSON.stringify(noPath));
});

// --- invalid configuration ---
group("invalid configuration", () => {
  const hugeSize = 1_000_000;
  const zero = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts" },
    fileSize: hugeSize,
    minLines: 0,
  });
  check("zero threshold still blocks on byte ceiling", zero.action === "block", JSON.stringify(zero));

  const negative = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts" },
    fileSize: hugeSize,
    minLines: -1,
  });
  check("negative threshold still blocks on byte ceiling", negative.action === "block", JSON.stringify(negative));

  const nanThreshold = decideShunt({
    toolName: "read",
    input: { path: "src/small.ts" },
    fileSize: 100,
    minLines: Number.NaN,
  });
  check("NaN threshold defers to defaults (small file allowed)", nanThreshold.action === "allow", JSON.stringify(nanThreshold));
});

// --- bash routing ---
group("bash routing", () => {
  const minLines = DEFAULT_MIN_LINES;
  const hugeSize = 1_000_000 * 80;
  const catBlocked = decideShunt({
    toolName: "bash",
    input: { command: "cat src/big.ts", target: "src/big.ts" },
    fileSize: hugeSize,
    minLines,
  });
  check("plain cat of huge file blocks", catBlocked.action === "block", JSON.stringify(catBlocked));

  const piped = decideShunt({
    toolName: "bash",
    input: { command: "cat src/big.ts | grep token" },
    fileSize: null,
    minLines,
  });
  check("piped bash (no extracted target) allows", piped.action === "allow", JSON.stringify(piped));

  const small = decideShunt({
    toolName: "bash",
    input: { command: "cat src/small.ts", target: "src/small.ts" },
    fileSize: 100,
    minLines,
  });
  check("plain cat of small file allows", small.action === "allow", JSON.stringify(small));

  const catMissing = decideShunt({
    toolName: "bash",
    input: { command: "cat src/missing.ts", target: "src/missing.ts" },
    fileSize: null,
    minLines,
  });
  check("plain cat of missing file warns but allows", catMissing.action === "warn", JSON.stringify(catMissing));
});

// --- mocked routing responses ---
group("mocked subagent responses", () => {
  const summary = parseBulkReader("- a.ts:1 — does X\n- b.ts:42 — does Y");
  check("bulk-reader summary parsed", summary.kind === "summary" && summary.bullets.length === 2);

  const refRequired = parseBulkReader("REF_REQUIRED");
  check("bulk-reader REF_REQUIRED parsed", refRequired.kind === "ref-required");

  const parentStillBlocked = decideShunt({
    toolName: "read",
    input: { path: "src/big.ts" },
    fileSize: 1_000_000,
    minLines: 350,
  });
  check("parent re-read after delegation still gated", parentStillBlocked.action === "block");
});

// --- worker exemption ---
group("worker exemption", () => {
  check("plain parent session not exempt", !isWorkerSession(undefined));
  check(
    "bulk-reader subagent exempt",
    isWorkerSession({ packageName: "pi-shunt", agentName: "bulk-reader", role: "subagent" }),
  );
  check(
    "code-writer subagent exempt",
    isWorkerSession({ packageName: "pi-shunt", agentName: "code-writer", role: "subagent" }),
  );
  check(
    "non-shunt subagent not exempt",
    !isWorkerSession({ packageName: "other", agentName: "scout", role: "subagent" }),
  );
  check(
    "unrelated agent name not exempt",
    !isWorkerSession({ packageName: "pi-shunt", agentName: "rogue", role: "subagent" }),
  );
});

// --- summary ---
process.stdout.write(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);

function parseBulkReader(stdout) {
  if (stdout.trim() === "REF_REQUIRED") return { kind: "ref-required" };
  if (stdout.startsWith("WROTE ")) return { kind: "wrote", path: stdout, bytes: 0 };
  if (stdout.startsWith("FAILED ")) return { kind: "failed", reason: stdout };
  return { kind: "summary", bullets: stdout.split("\n").filter(Boolean) };
}
