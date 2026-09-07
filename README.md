<div align="center">

# toris

**A local-first AI coding agent for your terminal.**

Turn a goal into planned, executed and verified work — with an evidence receipt for every run.

[![CI](https://github.com/torisKR/toris-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/torisKR/toris-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/toris-agent.svg)](https://www.npmjs.com/package/toris-agent)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](./package.json)

</div>

---

```console
$ toris run "add a health endpoint" --autonomy L3

Run run_kymt5ph09d7548

  Tasks (3)
  #  AGENT        STATUS   TITLE
  1  implementer  pending  Add GET /health endpoint returning service status JSON
  2  test-author  pending  Add automated tests covering the health endpoint
  3  doc-writer   pending  Document the health endpoint in README
```

`toris` is a terminal-native AI coding agent. It decomposes a goal into tasks, assigns each one to a
specialised agent profile, runs them through your existing **Claude Code** or **Codex** CLI (or an API
key), verifies the result with your project's own checks, and writes a receipt you can read, diff and
archive. Everything is local: every run, event and receipt is a plain file under `~/.toris`.

## Features

- **Chat-first TUI** — a clean, calm, open-webui-inspired terminal chat with a live slash-command
  palette, streaming responses and a compact status banner.
- **Plan → execute → verify** — a goal becomes ordered, verifiable tasks; nothing is "done" until your
  project's own `lint`/`test`/`build` actually pass.
- **Evidence receipts** — machine- and human-readable receipts (`toris receipt <runId> [--md]`) capture
  the goal, plan, per-task status, check exit codes, duration and cost.
- **Autonomy as a dial** — L1 plans and touches nothing; L5 commits and pushes. You choose per run, and
  anything above the line asks first.
- **Bring your own model** — Claude Code (`claude`) or Codex (`codex`) CLIs, or Anthropic/OpenAI API
  keys. toris decides *what* to do and *whether it worked*; your provider does the thinking.
- **Local-first & private** — no account, no server, no telemetry. State is plain files under `~/.toris`.
- **Zero runtime dependencies** — the entire runtime is Node's standard library.
- **Ships as a single binary** — standalone executables built with Node's Single Executable Application
  feature, installable with one command.

## Requirements

- **Node.js >= 22.6.0** — required to run from npm or source (the standalone binary bundles its own runtime).
- At least one model backend:
  - [Claude Code](https://claude.com/claude-code) CLI (`claude`) or an `ANTHROPIC_API_KEY`
  - [Codex CLI](https://developers.openai.com/codex/cli) (`codex`) or an `OPENAI_API_KEY`
- `git` — optional, but required for the commit/push autonomy levels.

## Install

### One-line install (standalone binary)

Downloads the prebuilt binary for your OS/arch from GitHub Releases, verifies its checksum and installs
it to `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/torisKR/toris-agent/main/scripts/install.sh | sh
```

Override the target directory or pin a version:

```bash
TORIS_INSTALL=/usr/local/bin TORIS_VERSION=v0.3.0 \
  curl -fsSL https://raw.githubusercontent.com/torisKR/toris-agent/main/scripts/install.sh | sh
```

Prebuilt binaries are published for `linux-x64`, `darwin-x64`, `darwin-arm64` and `win-x64`.

### From npm

```bash
npm install -g toris-agent
```

### From source

```bash
git clone https://github.com/torisKR/toris-agent.git
cd toris-agent
node bin/toris.js --help
```

## Quickstart

```bash
toris init            # create ~/.toris and a default config
toris doctor          # check runtime, providers, git and store
toris connect         # connect a model backend (CLI login or API key)
toris                 # open the interactive chat TUI
```

Or drive a goal end-to-end:

```bash
toris project add .                                   # register the current repo
toris run "fix the failing parser test" --autonomy L3 # plan and execute
toris runs                                            # list past runs
toris receipt <runId> --md > receipt.md               # archive the evidence
```

## Usage

A bare `toris` opens the interactive chat TUI when run at a terminal; otherwise it prints help.

| Command | Description |
| --- | --- |
| `toris init` | Create `~/.toris` and a default config. |
| `toris doctor` | Check runtime, providers, git and store. |
| `toris connect` | Connect a model backend (CLI login or API key). |
| `toris chat ["<message>"]` | Talk to a model with tools (REPL if no message). |
| `toris project add [path]` | Register a project (defaults to the current directory). |
| `toris project list \| inspect <id> \| remove <id>` | Manage registered projects. |
| `toris run "<goal>"` | Plan and execute a goal. |
| `toris runs` | List past runs. |
| `toris inspect <runId>` | Show a run in detail. |
| `toris receipt <runId> [--md]` | Evidence receipt for a run. |
| `toris logs <runId>` | Event log for a run. |
| `toris cancel <runId>` | Mark a run cancelled. |
| `toris approvals` / `approve <id>` / `reject <id>` | Review and decide approval requests. |
| `toris agents [--category <c>]` | Built-in agent profiles. |
| `toris skills` | Skill packages the model follows in chat. |
| `toris autonomy` | Autonomy levels and what each permits. |
| `toris update [--check]` | Update toris to the latest published version. |
| `toris version` | Print version. |

### Run options

```
-p, --project <ref>     Project id, name or unique prefix
    --autonomy <L1..L5>  How much may happen unattended
    --budget <usd>       Cost ceiling for this run
    --dry-run            Plan only; never edits files
    --provider <name>    claude | codex
```

### Global flags

```
--json        Machine-readable output on stdout (available on every command)
--home <dir>  Override ~/.toris
--no-color    Disable ANSI colour
--verbose     Stream events as they happen
-h, --help    Show help
```

### Exit codes

`0` ok · `1` failure · `2` usage · `3` verification failed · `4` approval denied · `5` daemon unavailable.

## Configuration

`toris init` writes `~/.toris/config.json` (override the home directory with `--home` or the
`TORIS_HOME` environment variable). The default config:

```jsonc
{
  "version": 1,
  "defaultAutonomy": "L3",   // recommended solo default
  "maxParallelAgents": 3,
  "maxDailyCostUsd": 20,
  "models": {
    "profiles": {},          // name -> { provider, model }
    "routing": {}            // role  -> profile name (e.g. { "chat": "main" })
  }
}
```

- **Model profiles start empty on purpose.** `toris connect` fills them in, or you can edit
  `models.profiles.<name>` and `models.routing.chat` by hand. Every error names the exact key to set.
- **API keys never live in the config file.** Export `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your
  environment; `toris doctor` reports which are set.

## Autonomy levels

Autonomy is chosen per run with `--autonomy`, and `defaultAutonomy` sets the baseline. Higher levels
widen what may happen without you; anything above the configured line asks for approval first.

| Level | Write | Commit | Push | Meaning |
| --- | --- | --- | --- | --- |
| **L1** | no | no | no | Plan only — nothing on disk changes. |
| **L2** | yes | no | no | Edit the working tree, ask before commit. |
| **L3** | yes | yes | no | Commit locally, ask before push. *(recommended solo default)* |
| **L4** | yes | yes | yes | Push to a side branch; your default branch is untouched. |
| **L5** | yes | yes | yes | Fully autonomous, including pushing to the default branch. |

## Development

```bash
npm run lint        # syntax-check every source file (node --check)
npm test            # run the node:test suite (node --test)
npm run build:sea   # build a standalone binary for the host platform (dist/sea/)
```

- **ESM only**, **zero runtime dependencies**, and **no lockfile** — do not add runtime deps. Build-only
  tooling (esbuild, postject) is invoked through `npx` and never installed.
- An optional Rust native module (`crates/toris-native`) speeds up process control, with a pure-JS
  fallback that is always correct. Build it with `npm run build:native`.
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for style and immutability conventions.

## License

[Apache-2.0](./LICENSE)
