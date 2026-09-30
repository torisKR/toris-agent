# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1] - 2026-09-30

### Fixed

- Solo initialization recognizes equivalent directory aliases and retains the existing project and its checks.
- Release and solo setup tests use canonical temporary directories, including macOS `/var` aliases.

## [0.5.0] - 2026-09-30

### Changed

- Toris is a terminal tool for solo developers. Start the TUI with `toris`, choose a role with `/agent`, and use CLI commands for runs, patches, knowledge, Android evidence, costs, daily briefs and daemon jobs.
- Help explains the fresh solo L2 preset and preserved configured autonomy. General initialization retains L3 defaults.

### Removed

- The web Studio, browser Design Mode, local HTTP API, Studio autostart service, `toris studio`, and TUI `/studio` shortcut. Their web-only exports, tests, screenshots and design assets have been removed. Existing files under `~/.toris/studio/` are left on disk.

### Added

- **Solo setup** — `toris init --solo` registers the current project, infers checks, and sets fresh L2 manual apply, one worker, a $20 daily run budget and knowledge retrieval without overwriting saved preferences.
- **Terminal workspace commands** — `/status`, `/plan`, `/run`, `/check`, `/diff` and `/receipt` connect project work, isolated edits and evidence. `toris --offline` supports local exploration with no model calls.
- **Portable release and Homebrew packaging** — versioned GitHub Release archives, SHA256 checksums and a generated formula for `torisKR/homebrew-tools`; a macOS Homebrew check gates publication.
- **English walkthrough** — real PTY screenshots, MP4 and asciicast demonstrate setup, offline planning, checks and receipts.
- **Opt-in knowledge starter packs** — `toris knowledge pack list` and `toris knowledge pack install` list and install shipped packs (`product-growth`, `flutter-expo-android`, `solo-revenue`, `toris-ops`) from `packs/knowledge/<slug>/`. They never auto-install on first run or `knowledge init`, and never write USER.md or MEMORY.md. Duplicate slugs require CLI `--force`. See `docs/KNOWLEDGE.md`.
- **Local daemon scheduling** — `toris daemon start|stop|status`, `toris daemon run`, and `toris daemon schedule` manage the local worker and cron jobs under `~/.toris/daemon/`. Submitting to an unavailable worker exits 5. See `docs/DAEMON.md`.
- **Secretary digest** — `toris brief` summarizes spend, today's runs, daemon schedules and knowledge headlines. See `docs/BRIEF.md`.
- **Chat knowledge retrieval** — each `toris chat` turn searches `~/.toris/knowledge/` and injects a bounded `[knowledge context]` of matching domain nodes and tacit notes. Retrieval is read-only. Disable with `knowledge.autoRetrieve: false` or `toris chat --no-knowledge`; `--json` and `--verbose` show a retrieval receipt. See `docs/KNOWLEDGE.md`.
- **Project-local agent profiles** — `.toris/agents/<id>.json` and optional `~/.toris/agents/` overlays share the built-in catalogue. Later sources win on id; new roles appear in `toris agents`, `--agent`, TUI `/agent`, and planner assignment. Invalid files report field errors. See `docs/AGENTS.md`.
- **Cross-run cost tracking** — `~/.toris/cost.json` records spend by local calendar day. `toris cost`, `toris cost today`, and `toris cost --json` list daily spend and recent runs. `maxDailyCostUsd` refuses runs once the daily ceiling is reached and skips work that would exceed the daily or `--budget` cap. Receipts include `budgetUsd`, `budgetNote`, and `dailyCostUsd`.
- **Secretary knowledge layer** — bounded USER.md and MEMORY.md, domain DAGs, tacit notes, the `toris knowledge` CLI, chat tools (`knowledge_search`, `memory_get`, `knowledge_write`, `domain_activate`), and opt-in `/reflect` use `~/.toris/knowledge/`.
- **Android evidence** — `toris android status|devices|screenshot|logcat|install` and the chat `android` tool use optional adb helpers. Doctor warns when adb or an emulator is missing. Artifacts land under `~/.toris/android/`.

### Fixed

- Provider and reviewer resolution respect configured binary paths and disabled providers.
- Planner CLI edits are isolated in disposable worktrees and discarded before execution. Task, check and review failures hold automatic apply, including runs with `--apply`.
- Settling live CLI chat edits ends the session so later requests cannot use a removed worktree.
- Concurrent daemon or terminal runs cannot redirect the current session's run checks, diff or receipt to another project.

## [0.4.0] - 2026-09-08

### Added

- Default **cross-model second pass**: after the implementer CLI finishes, the opposite provider (`claude` ↔ `codex`) reviews the isolated diff. A fail verdict holds auto-apply even at L3+. `--no-review` skips it.
- **Grok (xAI)** as a chat HTTP provider. `toris connect --provider grok`, `XAI_API_KEY` (or `GROK_API_KEY`), OpenAI-compatible `https://api.x.ai`. Coding runs still use `claude` / `codex`.

## [0.3.0] - 2026-09-08

### Added

- Isolated git worktrees so `claude`/`codex` write outside the original checkout, with `toris patches`, `apply`, `discard`, and `--apply`.
- Slack Socket Mode and Telegram long-poll via `toris bot` (`/run`, `/patches`, `/apply`, `/last`, `/workspace`, `/status`).
- Product-growth skills bundled under `skills/` (ASO, SEO/GEO, Flutter/Expo performance and interactive design, Play Store release).

### Changed

- L2 now asks before applying an isolated diff; L3+ auto-applies unless the original checkout changed during the run.

## [0.1.0] - 2026-07-29

Initial public release — the CLI foundation.

### Added

- **`toris` CLI** with `init`, `doctor`, `project` (add/list/inspect/remove), `run`, `runs`,
  `inspect`, `receipt`, `logs`, `cancel`, `approvals`, `approve`, `reject`, `agents`, `skills`,
  `daemon status` and `version` commands.
- **Planner** that decomposes a single goal into ordered, verifiable tasks, each bound to an agent
  profile.
- **Orchestrator** that runs independent tasks in parallel (default 3), retries failures
  (default 2 attempts) and falls back to the alternate provider before giving up.
- **Provider adapters** for the Claude Code (`claude`) and Codex (`codex`) CLIs, with binary
  overrides via `TORIS_CLAUDE_BIN` and `TORIS_CODEX_BIN`.
- **Autonomy levels L1–L5** gating writes, commits and pushes, with approval requests for anything
  above the configured ceiling.
- **Verification** that infers checks from the project's `package.json` scripts and runs them for
  real, stopping at the first failure.
- **Evidence receipts** in JSON and Markdown (`toris receipt <runId> [--md]`), covering goal, plan,
  per-task status, check exit codes, duration and cost.
- **Local JSON store** under `$TORIS_HOME` (default `~/.toris`): `config.json`, `projects.json`,
  `runs/*.json` and append-only `events/*.jsonl`.
- **Stable exit codes** — `0` ok, `1` failure, `2` usage, `3` verification failed,
  `4` approval denied, `5` daemon unavailable — plus `--json` output on every command.
- **Zero runtime dependencies**; requires Node.js >= 22.6.0.

[Unreleased]: https://github.com/torisKR/toris-agent/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/torisKR/toris-agent/releases/tag/v0.5.1
[0.5.0]: https://github.com/torisKR/toris-agent/releases/tag/v0.5.0
[0.4.0]: https://github.com/torisKR/toris-agent/releases/tag/v0.4.0
[0.3.0]: https://github.com/torisKR/toris-agent/releases/tag/v0.3.0
[0.1.0]: https://github.com/torisKR/toris-agent/releases/tag/v0.1.0
