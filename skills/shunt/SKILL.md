---
name: shunt-routing
description: Route bulk file reads and boilerplate code generation to a cheap worker subagent instead of the parent model. Use when a question spans multiple large files, or when generating tests/configs/type stubs from existing patterns. Avoid for debugging, architectural decisions, safety-critical code, or small reads where delegation latency exceeds savings.
---

# Shunt

Shunt routes the parent's I/O-heavy work to two cheap subagents so the parent model spends tokens on reasoning, not file plumbing.

Two workers, both shipped in this package:

- `pi-shunt.bulk-reader` — reads files, returns a bullet summary. Read-only.
- `pi-shunt.code-writer` — writes a single file matching a reference's style. Returns the path, not the body.

Both run as subagents through the installed `pi-subagents` package, which this package declares as a peer dependency.

## When to use which

| Situation | Worker | Why |
|---|---|---|
| A question spans 3+ files, each non-trivial | `bulk-reader` | Sum of parent reads > subagent + summary |
| Tests for an existing class with clear neighbours | `code-writer` | Pattern is local; output is mechanical |
| Config / type stub from a sibling file | `code-writer` | Same |
| Editing an existing file in place | none — edit normally | Shunt cannot delegate edits |
| Debugging a subtle bug | none — reason locally | Worker misses surface patterns |
| One small read | none | Delegation latency (10–30s) > savings |

If unsure, default to the parent's normal tools. Delegation is a win, not a rule.

## How to call

The `subagent` tool (from `pi-subagents`) takes the runtime name with the `package.` prefix:

```
subagent({ agent: "pi-shunt.bulk-reader", task: "<question>\n\n<paths>" })
subagent({ agent: "pi-shunt.code-writer", task: "<spec>\n\nreference: <path>\ntarget: <path>" })
```

Pass paths and the question/spec in the task string. Keep tasks small — one delegation per call.

## The gate

A `tool_call` extension in this package blocks oversized reads before they happen. When it blocks, the parent should call `bulk-reader` instead. Threshold and bypass:

- Threshold: `SHUNT_MIN_LINES` env var (default 350) or `--shunt-min-lines=<n>` flag if you re-implement.
- Bounded reads (`offset`/`limit` set, or `cat <file> | grep ...` style pipes) pass through; they are targeted.
- Workers' own reads are exempt — recursion would deadlock.

If the gate fires without a worker being available, it warns instead of blocking, and tells you how to configure.
## Configuration

The threshold, byte ceiling, and worker model can all be edited at runtime with the bundled slash command:

- `/shunt` — menu of settings
- `/shunt threshold 500` — set `SHUNT_MIN_LINES`
- `/shunt ceiling 131072` — set `SHUNT_BYTE_CEILING`
- `/shunt model` — pick from the registered models (or `/shunt model clear`)
- `/shunt show` — print current values
- `/shunt reset` — remove all shunt entries from settings
- `/shunt help` — quick reference

Edits persist to `~/.pi/agent/settings.json`. They take effect after `/reload` or a restart.

## When shunt does not apply

- Editing — workers do not return reliable line numbers.
- Reasoning — the cheap model misses subtle threads.
- Latency-sensitive paths — each call is 10–30s; one round-trip per delegation only.

See `references/routing-rules.md` for the full rule set and override knobs.
