import { line, c } from './output.js';

export const USAGE = `${'toris'} - local-first multi-agent development harness

USAGE
  toris                     Open the interactive chat TUI (at a terminal)
  toris --agent <id>        Open that agent in the TUI
  toris <command> [options]

COMMANDS
  init                      Create ~/.toris and a default config
  doctor                    Check runtime, providers, git and store
  connect                   Connect a model backend (CLI login or API key)
  chat ["<message>"]        Talk to a model with tools (REPL if no message)
      --agent <id>          Chat as a named agent (see toris agents)
      --no-knowledge        Skip automatic secretary retrieval this session
  project add [path]        Register a project (defaults to cwd)
  project list              List registered projects
  project inspect <id>      Show one project
  project remove <id>       Unregister a project
  run "<goal>"              Plan and execute a goal
  runs                      List past runs
  inspect <runId>           Show a run in detail
  receipt <runId> [--md]    Evidence receipt for a run
  cost [today]              Cross-run spend vs maxDailyCostUsd
  brief [today]             Local secretary digest (spend, runs, daemon, knowledge)
  logs <runId>              Event log for a run
  cancel <runId>            Mark a run cancelled
  approvals                 List approval requests
  approve <id> | reject <id>
  agents [--category <c>]   Agent profiles (builtins + .toris/agents/*.json)
  skills                    Skill packages the model follows in chat
  autonomy                  Autonomy levels and what each permits
  daemon start|stop|status  Local background worker (pid/lock under ~/.toris)
  daemon run "<goal>"       Queue a run for the local daemon (exit 5 if down)
  daemon schedule           Local cron: list | add | remove | enable | disable
  studio                    Local GUI on 127.0.0.1:5824 (review + /agent + /design + /patches + /knowledge + /daemon + /brief + /android)
  studio --open             Start or attach Studio and open the loopback URL
  studio service <action>   Install, status, restart or uninstall autostart
  android status|devices|screenshot|logcat|install
                            Optional adb helpers for Android verify evidence
  knowledge                 Local secretary knowledge (domains, DAG, tacit)
  knowledge init            Create ~/.toris/knowledge and seed starter domains
  knowledge search <query>  Keyword + tag recall across USER/MEMORY/domains
  knowledge reflect [runId] Propose a tacit note from a verified run (does not write)
  bot                       Listen for Slack and Telegram commands
  patches                   Isolated diffs waiting to be applied
  diff <patchId>            Show one stored patch
  apply <patchId>           Apply a patch to the original repo
  discard <patchId>         Drop a patch and its worktree
  update [--check]          Update toris to the latest published version
  version                   Print version

RUN OPTIONS
  -p, --project <ref>       Project id, name or unique prefix
      --autonomy <L1..L5>   How much may happen unattended (default L3)
      --budget <usd>        Cost ceiling for this run
      --dry-run             Plan only; never edits files
      --apply               Apply an isolated L2 diff without asking
      --no-review           Skip the opposite-provider second pass
      --provider <name>     claude | codex

GLOBAL
      --json                Machine-readable output on stdout
      --home <dir>          Override ~/.toris
      --no-color            Disable ANSI colour
      --verbose             Stream events as they happen
  -h, --help                Show this help

EXIT CODES
  0 ok   1 failure   2 usage   3 verification failed   4 approval denied   5 daemon unavailable

EXAMPLES
  toris                     # TUI chat
  toris --agent implementer
  toris studio              # GUI; agent room at /agent, Design Mode at /design, patches at /patches, knowledge at /knowledge, daemon at /daemon, brief at /brief, android at /android
  toris studio --open       # same, then open the loopback URL in the browser
  toris android status      # adb/emulator presence (optional)
  toris knowledge init      # USER.md, MEMORY.md, starter domain packs
  toris knowledge search flutter
  toris knowledge reflect run_abc123 --json
  toris init && toris doctor
  toris project add .
  toris run "add a health endpoint" --dry-run
  toris run "fix the failing parser test" --autonomy L3
  toris bot
  toris apply pat_abc
  toris connect --provider grok --model <grok-model-id>
  toris cost                   # today vs maxDailyCostUsd, recent days
  toris cost today --json
  toris brief                  # one-screen digest; safe for cron
  toris brief today --json
  toris daemon start
  toris daemon run "add a health endpoint" --dry-run
  toris daemon schedule add "@daily" "add a health endpoint" --dry-run
  toris daemon status --json
  toris receipt run_abc123 --md > receipt.md`;

export function printHelp() {
  line(USAGE);
}

export function printCommandList() {
  line(c.dim('Run `toris --help` for usage.'));
}
