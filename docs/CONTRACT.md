# Toris Agent — Interface Contract

> **Breaking change (v0.3.0).** This document was previously a *frozen* coordination artifact for a
> planned multi-package TypeScript workspace, including a marketing/social-media "Studio" surface. The
> v0.3.0 pivot removed Studio entirely and refocused the project as a single-package, ESM,
> zero-dependency **local-first AI coding agent**. The contract below has been trimmed to describe the
> surface that actually ships. The old package graph and Studio methods are intentionally gone.

## Runtime baseline

- Node **>= 22.6.0**, **ESM only** (`"type": "module"`), **zero runtime dependencies**, no lockfile.
- All relative imports use explicit `.js` extensions.
- Public entrypoint: `src/index.js` (types in `src/index.d.ts`). CLI entry: `bin/toris.js`.
- Tests are `node:test` files under `test/*.test.js`. Canonical checks: `npm run lint`, `npm test`.

## Home directory layout

Home resolution: `--home <dir>` → `$TORIS_HOME` → `~/.toris`.

- `~/.toris/config.json` — user config (see README → Configuration).
- `~/.toris/projects.json` — registered projects.
- `~/.toris/runs/*.json` — run records and receipts.
- `~/.toris/events/*.jsonl` — append-only event logs.

## CLI command surface

Binary: `toris`. A bare `toris` opens the chat TUI at a terminal, otherwise prints help. Every command
supports `--json` for machine-readable output.

```
toris init                                  # scaffold ~/.toris and config.json
toris doctor                                # runtime, providers, git, store, chat checks (exit 1 on FAIL)
toris connect                               # connect a model backend (CLI login or API key)
toris chat ["<message>"]                    # chat with tools (REPL if no message)
toris project add [path] | list | inspect <id> | remove <id>
toris run "<goal>" [-p <ref>] [--autonomy L1..L5] [--budget <usd>] [--dry-run] [--provider claude|codex]
toris runs                                  # list past runs
toris inspect <runId>                       # run detail
toris receipt <runId> [--md]                # evidence receipt
toris logs <runId>                          # event log
toris cancel <runId>
toris approvals | approve <id> | reject <id>
toris agents [--category <c>]               # built-in agent profiles
toris skills                                # skill packages the model follows in chat
toris autonomy                              # autonomy levels and what each permits
toris daemon status                         # background daemon (not yet available)
toris update [--check]                      # update to the latest published version
toris version
```

Global flags: `--json`, `--home <dir>`, `--no-color`, `--verbose`, `-h/--help`.

Exit codes: `0` ok · `1` failure · `2` usage · `3` verification failed · `4` approval denied ·
`5` daemon unavailable.

## Rules every contributor must follow

1. **Immutability** — state transitions return new objects; never mutate inputs.
2. **Errors** — no silent catch. Throw typed errors (`TorisError` and friends) or return `{ok:false, …}`.
   User-facing messages must be actionable and name the exact config key to set.
3. **Zero runtime dependencies** — do not add runtime deps. Build-only tooling runs via `npx`.
4. **ESM + `.js` extensions** on every relative import.
5. **Tests** — `node:test`, descriptive names; keep `npm run lint` and `npm test` green.
