# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/torisKR/toris-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/torisKR/toris-agent/releases/tag/v0.1.0
