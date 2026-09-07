# pi-shunt

Route the I/O-heavy parts of coding-agent work to a cheaper worker subagent.
Pi-native port of [Spotify's "shunt" idea](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90).

## What it does

Three layers, mirroring Spotify's design:

1. **Gate** (`extensions/shunt.ts`) — a `tool_call` listener that blocks oversized reads before they happen and tells the parent to delegate instead.
2. **Workers** (`agents/bulk-reader.md`, `agents/code-writer.md`) — two subagents, advertised to the parent, run through the `pi-subagents` package.
3. **Skill** (`skills/shunt/SKILL.md`) — describes when and how to invoke the workers.

The token-saving premise is the same as Spotify's: most of what the parent does is I/O. Send the bulk reads and boilerplate to a cheap model; keep the frontier model for reasoning.

## Install

```bash
pi install github:jaydentowork/pi-shunt
```

This pulls the package and registers the extension, skill, and two worker agents. Requires `pi-subagents` (peer dependency — install with `pi install npm:pi-subagents` if you do not already have it).

Then in any pi session:

```
> Ask the bulk-reader to summarise how user auth works across src/auth/*
```

The gate will block the parent from reading those files directly. The parent then calls `bulk-reader`, gets a bullet summary, and reasons on top of it.

## Configure

### Threshold

Default: 350 lines, 64 KB ceiling. Override per shell:

```bash
export SHUNT_MIN_LINES=500
pi
```

### Worker model

Default: `anthropic/claude-haiku-4-5`. Override per scope without editing installed files. In `~/.pi/agent/settings.json` (user) or `.pi/settings.json` (project, wins):

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

The shipped default is a sensible cheap model. Override to whatever you have credentials for — the workers will still bill tokens, just fewer than the parent.

## When not to use it

- **Editing existing files in place.** Workers do not return reliable line numbers; targeted reads with `offset`/`limit` are.
- **Debugging subtle bugs.** The cheap model misses surface patterns.
- **Latency-sensitive paths.** Each delegation is 10–30 s; the gate exists because small reads are not worth a round-trip.

The skill spells out the same rules in `skills/shunt/SKILL.md`.

## Self-check

```bash
npm run selfcheck
```

24 assertions covering threshold boundaries, bounded reads, missing/invalid config, worker exemption, bash routing, and mocked subagent response shapes. Pure Node — no transpiler, no external deps.

This does not exercise a real model provider. For a live smoke test, see `scripts/publish.md`.

## Attribution

Inspired by Dimitri Mazmanov's "Portal by Spotify cut my Claude Code token usage by 90%" (Spotify Engineering, Sep 2026). The original ships as a Claude Code plugin against Spotify's Portal/AiKA backend; this package re-implements the same shape inside pi, with subagents instead of a hosted backend.

## License

MIT.
