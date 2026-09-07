# Routing rules

## Threshold

The default is 350 lines. Anything smaller is below the crossover: the round-trip
to the worker plus the returned summary costs more than the parent reading it.

Set `SHUNT_MIN_LINES` in the shell that launches pi to change it. The gate also
honors a 64 KB byte ceiling — extremely wide lines should not slip past.

## Read gate

`shunt.ts` registers a `tool_call` listener for `read` calls. It blocks if:

1. The file's line count exceeds the threshold, AND
2. The call is a full read (`offset` and `limit` both absent), AND
3. The path is not exempt.

Exempt paths:

- Anything inside the `pi-shunt` package itself (workers and gate).
- Files smaller than the threshold.
- The gate's own config file (so editing the threshold works).

## Bash gate

A second listener inspects `bash` commands. It blocks `cat`, `head`, `tail`,
`less`, and `more` reads of single files when those files exceed the threshold.
Piped commands (`cat f | grep x`, `head -100 f`) pass through — they are
targeted.

This is best-effort. Complex shell parsing is intentionally avoided; the gate is
not a security boundary.

## Worker exemption

Workers' own reads must not be gated. The gate keys exemption off the executing
session. Inside a subagent spawned via `pi-subagents`, `ctx.sessionInfo.role`
or equivalent carries the worker's identity. If the identity cannot be resolved,
the gate falls back to "warn but allow" rather than risk a deadlock.

## Bypass flags

When you need to read a large file directly — for example, to apply a targeted
edit at a known offset — pass `offset` and `limit` on the `read` call. The gate
respects this.

For bash, use a piped command. `head -200 big.txt` is fine; `cat big.txt` is
not.

## Override knobs

| Knob | Default | Where |
|---|---|---|
| `SHUNT_MIN_LINES` | 350 | env |
| Byte ceiling | 65536 | code constant |
| Worker model | `anthropic/claude-haiku-4-5` | agent frontmatter, overridable via `subagents.agentOverrides` in settings.json |

To override the worker model without editing package files, add to
`~/.pi/agent/settings.json`:

```json
{
  "subagents": {
    "agentOverrides": {
      "pi-shunt.bulk-reader": { "model": "openai/gpt-4o-mini" },
      "pi-shunt.code-writer": { "model": "openai/gpt-4o-mini" }
    }
  }
}
```

Project overrides in `.pi/settings.json` win over the user overrides.
