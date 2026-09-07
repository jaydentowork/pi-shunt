# pi-shunt

Route the I/O-heavy parts of coding-agent work to a cheaper worker subagent.
Pi-native port of [Spotify's "shunt" idea](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90).

## Status

v0.1.1 is the first release with runtime validation. Earlier releases were
marked experimental because the selfcheck was testing duplicated code and the
package agent manifest was missing from `package.json`. Both issues are fixed.

What still needs live verification (open after install):

- That `pi install git:github:jaydentowork/pi-shunt` succeeds end-to-end.
- That the workers appear as `pi-shunt.bulk-reader` and `pi-shunt.code-writer`
  in `subagent({ action: "list" })`.
- That the gate fires when the parent reads a file past the threshold.

The selfcheck verifies decision logic. It does not boot pi or call any LLM.

## What it does

Three layers, mirroring Spotify's design:

1. **Gate** (`extensions/shunt.ts`) — a `tool_call` listener that blocks oversized reads before they happen and tells the parent to delegate instead.
2. **Workers** (`agents/bulk-reader.md`, `agents/code-writer.md`) — two subagents, registered as packaged agents and discoverable through `pi-subagents`.
3. **Skill** (`skills/shunt/SKILL.md`) — describes when and how to invoke the workers.

The token-saving premise is the same as Spotify's: most of what the parent does is I/O. Send the bulk reads and boilerplate to a cheap model; keep the frontier model for reasoning.

## Install

```bash
pi install git:github.com/jaydentowork/pi-shunt
```

This pulls the package and registers the extension, skill, and two worker agents. Requires `pi-subagents` as a peer dependency:

```bash
pi install npm:pi-subagents
```

Then in any pi session, run `/skill:shunt` to see the routing rules, or just ask a question that spans several large files. The gate will block the parent from reading those files directly. The parent then calls `pi-shunt.bulk-reader`, gets a bullet summary, and reasons on top of it.

## Configure

### Threshold

Default: 350 lines, 64 KB ceiling. Override per shell:

```bash
export SHUNT_MIN_LINES=500
pi
```

The ceiling can also be overridden, but it is rarely worth changing:

```bash
export SHUNT_BYTE_CEILING=131072
pi
```

Garbage values (`"350junk"`, `-1`, `NaN`) fall back to the defaults.

### Bounded reads

The gate lets a read through only when **both** `offset` and `limit` are set and `limit ≤ 200` (configurable in `src/decide.mjs`). A read with no limit is treated as full and gated; a read with only `offset` is also treated as full.

### Worker model


> **Note:** the shipped default `anthropic/claude-haiku-4-5` only resolves if you have an Anthropic provider configured. Override via the override block below, the `/shunt model` command, or your registry's `defaultProvider`. A spawn against an unknown model id fails.
Override per scope without editing installed files. In `~/.pi/agent/settings.json` (user) or `.pi/settings.json` (project, wins):

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

The shipped default is a sensible cheap model. Override to whatever you have credentials for — the workers will still bill tokens, just fewer than the parent. Note that the parent will still bill tokens for the gate's reason messages, the routing decisions, and any final answer derived from the worker's summary. This package does not eliminate frontier-model usage; it shifts a portion of it.

## When not to use it

- **Editing existing files in place.** Workers do not return reliable line numbers; targeted reads with `offset`/`limit` are.
- **Debugging subtle bugs.** The cheap model misses surface patterns.
- **Latency-sensitive paths.** Each delegation adds a network round-trip; the gate exists because small reads are not worth one.

The skill spells out the same rules in `skills/shunt/SKILL.md`.

## Self-check

```bash
npm run selfcheck
```

### Edit at runtime: `/shunt`

Run `/shunt` from any pi session for a menu, or call a subcommand directly:

```
/shunt threshold 500
/shunt ceiling 131072
/shunt model           # pick from your registered models
/shunt model clear
/shunt show
/shunt reset
/shunt help
```

Edits persist to `~/.pi/agent/settings.json` and take effect after `/reload` or a restart. Settings-driven overrides are honoured by the extension at startup, so the gate and the workers read the values without env vars being set in your shell.

## Self-check

```bash
npm run selfcheck
```

43 assertions covering threshold boundaries, bounded-read validation (offset alone is NOT bounded), missing/invalid configuration, garbage string handling, bash routing, settings round-trip (parse, apply, model override, removal), and the worker-exemption contract. Pure Node — no transpiler, no external deps, and the same `decide.mjs` and `settings.mjs` the extension uses.
## Attribution

Inspired by Dimitri Mazmanov's "Portal by Spotify cut my Claude Code token usage by 90%" (Spotify Engineering, Sep 2026). The original ships as a Claude Code plugin against Spotify's Portal/AiKA backend; this package re-implements the same shape inside pi, with subagents instead of a hosted backend.

## License

MIT.
