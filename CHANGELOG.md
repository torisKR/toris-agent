# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Studio knowledge pin on Patch Review** — a pin set on `/knowledge` is now read, forwarded, and consumed by `POST /api/patches/:id/review` (same `localStorage` key and `{ domain, nodeId }` shape as `/agent`, Design Mode, and `/android`). Unknown pin is HTTP 400 (no model, no write). A failed send leaves the pin in place.
- **Studio knowledge pin on `/android`** — a pin set on `/knowledge` is now read, forwarded, and consumed by the `/android` turn client (same `localStorage` key and `{ domain, nodeId }` shape as `/agent` and Design Mode). A failed send leaves the pin in place.

### Added

- **Studio `/knowledge` link nodes** — a small **Link** form (from id, to id, existing DAG kind) writes one edge through `KnowledgeStore.link`. It does not create a node. Unknown from/to is HTTP 404; duplicate edge is HTTP 409; missing Origin/session token is HTTP 403. None of those write. After success the panel reloads the existing DAG GET. GET does not write. See `docs/KNOWLEDGE.md` and `docs/STUDIO.md`.
- **Studio `/knowledge` create domain** — a small **Create** form (required slug, optional title/description) writes one domain through `KnowledgeStore.addDomain` (`DOMAIN.md`, empty `dag.json`, folders). Invalid slug is HTTP 400; duplicate slug is HTTP 409; missing Origin/session token is HTTP 403. None of those write. After success the list refreshes and the empty domain can be selected. GET does not write. Does not seed starter packs or write USER.md / MEMORY.md. See `docs/KNOWLEDGE.md` and `docs/STUDIO.md`.
- **Studio `/knowledge` edit node** — when a DAG node is selected, the detail panel shows editable title and body (kind stays read-only). **Save** writes that one node through `KnowledgeStore.updateNode`. Empty title is HTTP 400; unknown domain/node is HTTP 404; missing Origin/session token is HTTP 403. None of those write. Node id is unchanged. After a successful save the panel reloads the existing DAG GET. See `docs/KNOWLEDGE.md` and `docs/STUDIO.md`.
- **Studio `/knowledge` pin-to-turn** — each DAG node has **use on next turn**. The next `POST /api/agent/turn` sends that domain + node id; the server prepends a capped title/kind/excerpt block from `KnowledgeStore`. Unknown id is HTTP 400 (no model, no write). Unchecked turns are unchanged. Auto-retrieve ranking is unchanged. See `docs/KNOWLEDGE.md` and `docs/STUDIO.md`.
- **Studio `/knowledge` DAG panel** — read-only nested list of the selected domain's nodes (title/kind) and `dag.json` edges. Click a node for a short body. Empty domains stay quiet. `GET /api/knowledge/domains/:slug/dag` is the same-origin JSON read (`inspectDomain`); it does not write. No graph library. See `docs/KNOWLEDGE.md` and `docs/STUDIO.md`.
- **Studio `/knowledge` reflect accept** — the latest verified-run tacit proposal (goal, short outcome, domain guess) on `/knowledge`. `GET /api/knowledge/reflect` is read-only. Authenticated **Accept** writes that one note via the existing `acceptReflections` / `addTacit` path (`toris knowledge reflect --write` / `/reflect accept`). **Dismiss** does not write. Failed or unverified receipts stay hidden. See `docs/KNOWLEDGE.md` and `docs/STUDIO.md`.
- **Studio `/android` attach-to-turn** — select recent files under `~/.toris/android/` and send one instruction on the existing `POST /api/agent/turn` (canonical screenshot path and/or a short logcat excerpt). Same Origin + session token as Design Mode. Traversal is rejected. No second turn endpoint.
- **Studio `/android`** — loopback device-evidence page for the same optional adb helpers as `toris android` (`GET /android`, `GET /api/android`, artifacts, screenshot/logcat). Missing adb is a quiet 200. Mutations need Origin + session token. Image media stays under `~/.toris/android/`. `install` remains CLI-only. See `docs/STUDIO.md`.
- **Studio `/brief`** — loopback read-only page for the same local secretary digest as `toris brief` (`GET /brief`, `GET /api/brief`). Spend, today's runs, daemon status/next due, knowledge headlines. Quiet empty sections. No mutations. See `docs/STUDIO.md`.
- **`toris brief`** — local secretary digest for today: spend vs `maxDailyCostUsd`, bounded runs (id / goal / status / verify), daemon running + next schedule, and 3–5 tacit/node headlines. `--json` for machines. Knowledge is omitted when the store is missing. The daemon still only runs coding jobs — `daemon schedule add "09:00" "toris brief"` is refused; put `toris brief` on host cron. See `docs/BRIEF.md`.
- **Receipt-aware secretary reflect** — `toris knowledge reflect [runId]` / `--from-run <id>` (or the latest verified run) proposes one tacit draft from goal, plan titles, check exit codes, and the verdict. Failed or unverified receipts do not propose a success note. `--json` returns the proposal without writing; `--write` / `/reflect accept` is the only accept path. A quiet `reflectHint` line on a passing receipt points at the command. See `docs/KNOWLEDGE.md`.
- **Studio `/daemon`** — loopback page for worker status, local schedules, recent jobs, and a **Queue run** form (`POST /api/daemon/run`) that drops the same inbox job as `toris daemon run`. Origin + session token. HTTP 503 when the worker is down (CLI exit 5). Does not start or stop the worker. See `docs/STUDIO.md`.
- **Chat auto-retrieves secretary knowledge** — each `toris chat` turn and Studio agent turn keyword/tag-searches `~/.toris/knowledge/` and injects a bounded `[knowledge context]` of matching domain nodes and tacit notes (read-only; never writes tacit). Disable with `knowledge.autoRetrieve: false` or `toris chat --no-knowledge`. `--json` / `--verbose` surface a small receipt. See `docs/KNOWLEDGE.md`.
- **Local daemon scheduler** — `toris daemon schedule list|add|remove|enable|disable` stores one JSON file per schedule under `~/.toris/daemon/schedules/`. The running worker evaluates due items on its heartbeat (local timezone) and enqueues the same inbox `run` jobs as `daemon run`. Supported expressions: 5-field cron, `@hourly`/`@daily`/`@weekly`/`@monthly`, `@every <n>m|h`, and `HH:MM` weekday forms. Same schedule does not double-fire while a prior job is queued or running. `daemon status` reports count and next due. Local-only: no cloud calendar. See `docs/DAEMON.md`.
- **Local background daemon** — `toris daemon start|status|stop` owns `~/.toris` via `daemon.lock` / `daemon.json` (pid, uptime, heartbeat, home). Double-start is refused; `stop` SIGTERMs the lock pid. `toris daemon run "<goal>"` queues a durable `run` job through `daemon/inbox/` while the worker is up (exit `5` if it is not). `--json` on every subcommand. Local-only: no `daemon.sock` RPC, no remote multi-machine, no cloud.
- **Project-local agent profiles** from `.toris/agents/<id>.json` (optional `~/.toris/agents/` overlay). Same catalogue as builtins: later source wins on id, new ids show in `toris agents`, `--agent`, TUI `/agent`, Studio, and planner assignment. Invalid files fail with a field error. See `docs/AGENTS.md`.
- **Cross-run cost tracking** under `~/.toris/cost.json` (local calendar day, no telemetry). `toris cost`, `toris cost today`, and `toris cost --json` list spend by day and recent runs. `maxDailyCostUsd` now refuses a new run when today's ceiling is already reached, and skips remaining tasks (plus the second-pass review) when the daily or `--budget` cap would be exceeded. Receipts carry additive `budgetUsd` / `budgetNote` / `dailyCostUsd`; Studio `GET /api/health` includes today's spend.
- Studio agent turns stream over SSE when `POST /api/agent/turn` sends `Accept: text/event-stream` (`text` / `tool-start`, then `done`). JSON remains the default. The `/agent` room shows progressive text, Stop, Enter-to-send, and a per-agent `localStorage` transcript.
- `toris studio --open` starts or attaches to the loopback GUI and opens it in the OS browser. TUI `/studio` jumps to the same URL.
- **Studio Patch Review** at `http://127.0.0.1:5824/patches`: list pending isolated diffs from the existing `toris patches` store, read a bounded unified diff, apply/discard with Origin + session token, or send a review note/hunk back as an implementer turn.
- **Design Mode annotation tray**: queue multiple element captures with per-element notes, persist `tray.json` under `~/.toris/studio/design/`, and send the tray plus one instruction in a single agent turn.
- Patch Review implementer turns run in the isolated worktree and refresh the stored `.diff` before apply, so review edits are what get applied.
- **Design Mode** at `http://127.0.0.1:5824/design`: pick a DOM element (iframe proxy, sample page, or bookmarklet) and attach selector, computed styles, bounded outerHTML, and a screenshot to the Studio agent turn.
- **Secretary knowledge layer** at `~/.toris/knowledge/`: bounded USER.md / MEMORY.md, domain packs as a DAG, tacit notes, `toris knowledge` CLI, chat tools (`knowledge_search`, `memory_get`, `knowledge_write`, `domain_activate`), opt-in `/reflect`, and Studio `/knowledge`.
- **`toris android`** (`status`, `devices`, `screenshot`, `logcat`, `install`) plus optional `adb`/`emulator` doctor warnings and a chat `android` tool for device evidence. Artifacts land under `~/.toris/android/`.
- TUI `/agent` and `/studio` commands, plus `toris --agent <id>`, so a chat session can pick a role and jump to the local GUI.
- Studio agent room at `http://127.0.0.1:5824/agent` with the same profile catalogue and a localhost chat turn API.
- English, product-led root README with live Studio screenshots, a Design Mode demo, and an architecture diagram generated from this implementation.

### Changed

- `toris --help` now reports the real default autonomy (**L3**), matching `defaultAutonomy` in `src/core/config.js`.

### Fixed

- Studio `GET /api/android` stays HTTP 200 when `adb devices` fails, and `/android` loads artifacts independently of status so local screenshots remain browsable.
- Studio `POST /api/daemon/run` attaches the registered project for Studio's cwd (same checks as `toris daemon run`) and rejects unknown autonomy levels with HTTP 400 instead of queueing a job that later fails.

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

[Unreleased]: https://github.com/torisKR/toris-agent/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/torisKR/toris-agent/releases/tag/v0.4.0
[0.3.0]: https://github.com/torisKR/toris-agent/releases/tag/v0.3.0
[0.1.0]: https://github.com/torisKR/toris-agent/releases/tag/v0.1.0
