# Publishing pi-shunt

## Pre-flight

```bash
npm run selfcheck   # must show "24 passed, 0 failed"
```

Verify the staged diff contains no secrets:

```bash
git diff --cached
```

Verify `gh` auth:

```bash
gh auth status
```

## First release

The repo lives at `github.com/jaydentowork/pi-shunt`. If you have not created the remote yet:

```bash
gh repo create jaydentowork/pi-shunt --public --source=. --remote=origin
```

Push:

```bash
git push -u origin main
```

Tag and release:

```bash
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 --generate-notes
```

## Subsequent releases

```bash
# bump version in package.json
git diff package.json
git add package.json
git commit -m "chore: bump version to 0.X.Y"
git tag v0.X.Y
git push origin main --follow-tags
gh release create v0.X.Y --generate-notes
```

## Live smoke test (opt-in, costs tokens)

The selfcheck does not hit a real provider. To confirm a real delegation round-trip:

1. Install the package locally: `pi install /absolute/path/to/pi-shunt`.
2. In a session, ask a question that touches several large files:

   ```
   > Use bulk-reader to summarise src/auth/* and src/billing/*
   ```

3. Watch the gate fire, the worker spawn, and the summary come back.

If the worker errors with "model not configured", your provider is missing the default `anthropic/claude-haiku-4-5`. Override via `subagents.agentOverrides` as documented in the README.

## What NOT to publish to npm

This package is a pi-package, not a generic npm library. Do not `npm publish` unless you also want generic JS consumers — they will need to provide their own pi runtime.
