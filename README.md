<div align="center">

# toris-agent

**A local-first, multi-agent development harness.**
Turn a goal into planned, executed and verified work — with an evidence receipt for every run.

[![CI](https://github.com/toriskr/toris-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/toriskr/toris-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/toris-agent.svg)](https://www.npmjs.com/package/toris-agent)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-success.svg)](./package.json)

</div>

---

```console
$ toris run "add a health endpoint" --autonomy L3

Run run_kymt5ph09d7548

  Tasks (3)
  #  AGENT        STATUS   TITLE
  1  implementer  pending  Add GET /health endpoint returning service status JSON
  2  test-author  pending  Add automated tests covering the health endpoint
  3  doc-writer   pending  Document the health endpoint in README and API docs
```

`toris` decomposes a goal into tasks, assigns each one to a specialised agent profile, runs them
through your existing **Claude Code** or **Codex** CLI, verifies the result with your project's own
checks, and writes a receipt you can read, diff and archive.

It is a *harness*, not a model. Your provider CLI does the thinking; toris decides **what** gets
thought about, **in what order**, **how much may happen without you**, and **whether it actually worked**.

## Why

Agent tools are easy to start and hard to trust. toris is built around four opinions:

| Opinion | What it means in practice |
| --- | --- |
| **Local-first** | Every run, event and receipt is a plain file under `~/.toris`. No account, no server, no telemetry, no network calls of its own. |
| **Evidence over vibes** | A run is not "done" because an agent said so. It is done when the project's own `lint`/`test`/`build` pass — and the receipt shows the exit codes. |
| **Autonomy is a dial** | L1 plans and touches nothing. L5 commits and pushes. You choose per run, and anything above the line asks first. |
| **Zero dependencies** | The entire runtime is Node's standard library. Nothing in your supply chain but you and your provider CLI. |

## Requirements

- **Node.js >= 22.6.0** (`node --version`)
- At least one provider CLI on your `PATH`:
  - [Claude Code](https://claude.com/claude-code) — `claude`
  - [Codex CLI](https://developers.openai.com/codex/cli) — `codex`
- `git` (optional, but required for commit/push autonomy levels)

## Install

```bash
# One-off, no install
npx toris-agent doctor

# Global CLI (recommended)
npm install -g toris-agent
toris --help

# From source
git clone https://github.com/toriskr/toris-agent.git
cd toris-agent
npm link          # no `npm install` needed — there are no dependencies
toris doctor
```

## Quickstart

**1. Check your environment.** `doctor` tells you exactly what is missing before you waste a run:

```console
$ toris doctor
toris doctor

  PASS  node               v24.16.0 (requires >= 22.6.0)
  PASS  provider:claude    /usr/local/bin/claude
  PASS  provider:codex     /usr/local/bin/codex
  PASS  providers          at least one agent CLI available
  PASS  git                /usr/bin/git
  WARN  config             not created yet, run: toris init
  PASS  store              /Users/you/.toris
  PASS  cwd-git            /Users/you/projects/my-app

All required checks passed.
```

**2. Initialise and register a project.**

```bash
toris init                 # creates ~/.toris and a default config
toris project add .        # register the repo you are standing in
```

**3. Plan without touching anything.** `--dry-run` never writes a file:

```bash
toris run "add a health endpoint" --dry-run
```

**4. Let it work.** Raise the dial when you trust the plan:

```bash
toris run "add a health endpoint" --autonomy L3 --budget 2.00
```

**5. Read the evidence.**

```bash
toris runs                            # every run, newest first
toris inspect run_kymt5ph09d7548      # tasks, checks, timings
toris receipt run_kymt5ph09d7548 --md > receipt.md
```

## How a run works

```
   goal
     │
     ▼
┌──────────┐   plan     ┌──────────────┐  dispatch  ┌───────────────┐
│ planner  │──────────▶ │ orchestrator │──────────▶ │ agent profile │
└──────────┘  tasks +   └──────────────┘  parallel  │  implementer  │
              agents +         │          (max 3)   │  test-author  │
              order            │                    │  reviewer ... │
                               │                    └───────┬───────┘
                               │                            │ provider CLI
                               │                            ▼
                               │                    ┌───────────────┐
                               │  retry / fallback  │ claude │ codex│
                               │ ◀──────────────────└───────────────┘
                               ▼
                        ┌──────────────┐
                        │   verifier   │  npm run lint / test / build
                        └──────┬───────┘  → real exit codes
                               ▼
                        ┌──────────────┐
                        │   receipt    │  JSON + Markdown, on disk
                        └──────────────┘
```

- **Planner** turns one sentence into ordered tasks, each bound to an agent profile.
- **Orchestrator** runs independent tasks in parallel (default 3), retries failures
  (default 2), and falls back to the *other* provider before giving up.
- **Verifier** infers checks from your `package.json` scripts and runs them for real. It stops at
  the first failure so a broken build does not burn the rest of your budget.
- **Receipt** records goal, plan, per-task status, check exit codes, duration and cost.
  Exit code `3` means verification failed — CI can gate on it.

## Autonomy levels

Every run has a ceiling. Anything above it becomes an approval request instead of an action.

```console
$ toris skills
Autonomy levels

  LEVEL  WRITE  COMMIT  PUSH  MEANING
  L1     no     no      no    plan only
  L2     yes    no      no    edit working tree, ask before commit
  L3     yes    yes     no    commit locally, ask before push
  L4     yes    yes     yes   push to a branch
  L5     yes    yes     yes   fully autonomous
```

Default is **L2**. Pending requests queue up until you decide:

```bash
toris approvals              # what is waiting
toris approve apr_7x2k9d     # let it through
toris reject  apr_7x2k9d     # exit code 4, run stops
```

## Agent profiles

Eleven built-in profiles across four categories. `WRITES` marks the ones allowed to modify files.

```console
$ toris agents
Agent profiles (11)

  ID                 CATEGORY  WRITES  SUMMARY
  planner            plan      no      Decomposes a goal into ordered, verifiable tasks.
  architect          plan      no      Chooses structure, boundaries and trade-offs before code exists.
  researcher         plan      no      Finds prior art, libraries and API facts before implementing.
  implementer        build     yes     Writes the code for exactly one task.
  test-author        build     yes     Writes failing tests first, then keeps them honest.
  refactorer         build     yes     Removes duplication and dead code without changing behaviour.
  code-reviewer      review    no      Reviews a diff for correctness, clarity and contract drift.
  security-reviewer  review    no      Audits for secrets, injection, authz and unsafe file/network use.
  verifier           verify    no      Runs the project checks and reports pass/fail with evidence.
  doc-writer         ship      yes     Updates README, changelog and usage docs to match reality.
  release-manager    ship      yes     Prepares version bumps, changelogs and release notes.
```

Filter with `toris agents --category build`.

## Receipts

Every run produces an auditable record. Markdown for humans, JSON for machines.

```markdown
# Run receipt `run_kymt9dy9c5017d`

**Goal** — add a health endpoint

| Field | Value |
| --- | --- |
| Status | `succeeded` |
| Autonomy | L3 |
| Provider | claude |
| Duration | 25.4s |
| Cost | $0.0000 |

## Tasks (4/4 succeeded)

- ✅ Add /health endpoint route handler _(implementer)_
- ✅ Write unit tests for health payload builder _(test-author)_
- ✅ Add integration test for the /health HTTP route _(test-author)_
- ✅ Document the health endpoint in README _(doc-writer)_
```

```bash
toris receipt <runId>          # JSON on stdout
toris receipt <runId> --md     # Markdown, ready to paste into a PR
toris logs <runId>             # raw JSONL event stream
```

## Command reference

```
init                      Create ~/.toris and a default config
doctor                    Check runtime, providers, git and store
project add [path]        Register a project (defaults to cwd)
project list              List registered projects
project inspect <id>      Show one project
project remove <id>       Unregister a project
run "<goal>"              Plan and execute a goal
runs                      List past runs
inspect <runId>           Show a run in detail
receipt <runId> [--md]    Evidence receipt for a run
logs <runId>              Event log for a run
cancel <runId>            Mark a run cancelled
approvals                 List approval requests
approve <id> | reject <id>
agents [--category <c>]   Built-in agent profiles
skills                    Autonomy levels and what each permits
daemon status             Background daemon (not in 0.1.0)
version                   Print version
```

**Run options**

| Flag | Meaning |
| --- | --- |
| `-p, --project <ref>` | Project id, name or unique prefix |
| `--autonomy <L1..L5>` | How much may happen unattended (default `L2`) |
| `--budget <usd>` | Cost ceiling for this run |
| `--dry-run` | Plan only; never edits files |
| `--provider <name>` | `claude` or `codex` |

**Global options**

| Flag | Meaning |
| --- | --- |
| `--json` | Machine-readable output on stdout |
| `--home <dir>` | Override `~/.toris` |
| `--no-color` | Disable ANSI colour |
| `--verbose` | Stream events as they happen |

## Scripting

`--json` makes every command pipeable, and exit codes are stable:

| Code | Meaning |
| --- | --- |
| `0` | ok |
| `1` | failure |
| `2` | usage error |
| `3` | verification failed |
| `4` | approval denied |
| `5` | daemon unavailable |

```bash
# Fail a CI job if the agent's work does not pass the project checks
toris run "$GOAL" --autonomy L3 --json > run.json || exit $?

# Attach the receipt to a pull request
toris receipt "$(jq -r .run.id run.json)" --md >> "$GITHUB_STEP_SUMMARY"
```

## Configuration

State lives under `$TORIS_HOME` (default `~/.toris`) and is all plain text:

```
~/.toris
├── config.json                       # settings below
├── projects.json                     # registered projects
├── runs/run_kymt9dy9c5017d.json      # one file per run
└── events/run_kymt9dy9c5017d.jsonl   # append-only event log
```

`config.json` defaults:

```json
{
  "version": 1,
  "defaultAutonomy": "L2",
  "maxParallelAgents": 3,
  "maxDailyCostUsd": 20,
  "maxRetriesPerTask": 2,
  "providerTimeoutMs": 900000,
  "defaultProvider": "claude",
  "providers": {
    "claude": { "bin": "claude", "enabled": true },
    "codex": { "bin": "codex", "enabled": true }
  }
}
```

Unknown keys are preserved, so a newer config survives an older binary.

**Environment variables**

| Variable | Effect |
| --- | --- |
| `TORIS_HOME` | Override the state directory |
| `TORIS_CLAUDE_BIN` | Path to the `claude` executable |
| `TORIS_CODEX_BIN` | Path to the `codex` executable |
| `TORIS_DEBUG` | Verbose internal logging |
| `NO_COLOR` | Disable ANSI colour (respects the [standard](https://no-color.org)) |

## Project layout

```
bin/toris.js         # executable entry point
src/
├── cli/             # arg parsing, help, output formatting, commands/
└── core/
    ├── planner.js       goal → tasks
    ├── orchestrator.js  parallel execution, retries, fallback
    ├── providers.js     claude / codex adapters
    ├── verifier.js      runs project checks, collects exit codes
    ├── receipt.js       JSON + Markdown evidence
    ├── autonomy.js      L1..L5 gating
    ├── agents.js        the 11 profiles
    ├── store.js         local JSON persistence
    └── config.js        defaults, merge, paths
test/                # node:test, one file per module
docs/
├── CONTRACT.md      # frozen v0.1.0 interface contract
└── specs/           # per-module specifications
```

## Development

No install step — there are no dependencies.

```bash
git clone https://github.com/toriskr/toris-agent.git
cd toris-agent
npm test                          # node --test test/
npm run lint                      # syntax check
node bin/toris.js doctor          # run the CLI from source
node --test test/planner.test.js  # a single suite
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow and the rules around
[the frozen interface contract](./docs/CONTRACT.md).

## Roadmap

`0.1.0` is the CLI foundation. Next up:

- [ ] Background daemon (`toris daemon start`) for long-running and scheduled goals
- [ ] Git worktree isolation so parallel writers never collide
- [ ] Cost tracking and budget enforcement across runs, not just within one
- [ ] More provider adapters
- [ ] Custom agent profiles from a project-local file

Ideas and complaints both welcome in [issues](https://github.com/toriskr/toris-agent/issues).

## Contributing

Pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) first. For vulnerabilities, follow
[SECURITY.md](./SECURITY.md) rather than opening a public issue.

## License

[Apache-2.0](./LICENSE) © toris
