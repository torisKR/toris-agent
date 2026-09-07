# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-07

Product pivot — **toris is now a focused local-first AI coding agent for the terminal.** The marketing
/ social-media "Studio" surface has been removed entirely. This is a **breaking change**.

### Removed (breaking)

- **Toris Studio** — the local marketing/social-media content studio: `src/studio/**` (web UI + render
  pipeline), the `python/auto_shorts/**` short-form video render/publish engine, `docs/STUDIO.md` and the
  Studio design system (`DESIGN.md`).
- The **`studio` CLI command** (and `studio service <action>`) plus all its dispatch, help and
  launchd/service-manager wiring.
- All `studio-*` tests and every TikTok/Zernio/klipy/social/publish/render reference tied to marketing.
- `python` from the npm `files` list.

### Added

- **Standalone single-file binaries** built with Node 22's Single Executable Application (SEA) feature
  (`npm run build:sea`, `scripts/build-sea.js`) for `linux-x64`, `darwin-x64`, `darwin-arm64` and
  `win-x64` — no third-party packager, preserving the zero-dependency ethos.
- **One-line installer** `scripts/install.sh` (POSIX sh): detects OS/arch, downloads the matching
  release binary, verifies its SHA-256 checksum and installs to a PATH bin dir.
- **GitHub Releases distribution** — the release workflow now builds the SEA binaries per platform,
  generates checksums and attaches them plus the installer to the tagged release.
- `src/core/version.js` — a single, SEA-aware source of truth for the running version.

### Changed

- **Open-webui-inspired TUI redesign** — a calmer, modern dark palette (cool sky-blue accent), a minimal
  rounded wordmark on first run, a `local ai agent` banner tagline, and rebranded copy throughout.
- Bumped `version` to `0.3.0` and realigned `optionalDependencies` version pins.
- Trimmed `docs/CONTRACT.md` to match the post-pivot surface.

### Fixed

- Turn timeouts in the warm and cold provider paths are no longer `unref()`'d, so a hung CLI is actually
  killed and reported instead of the process draining first (which had cascaded into cancelled tests).

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

[Unreleased]: https://github.com/torisKR/toris-agent/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/torisKR/toris-agent/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/torisKR/toris-agent/releases/tag/v0.1.0
