import { line, c } from './output.js';

export const USAGE = `${'toris'} - local-first multi-agent development harness

USAGE
  toris <command> [options]

COMMANDS
  init                      Create ~/.toris and a default config
  doctor                    Check runtime, providers, git and store
  chat ["<message>"]        Talk to a model with tools (REPL if no message)
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
  skills                    Skill packages the model follows in chat
  autonomy                  Autonomy levels and what each permits
  daemon status             Background daemon (not in 0.1.0)
  update [--check]          Update toris to the latest published version
  version                   Print version

RUN OPTIONS
  -p, --project <ref>       Project id, name or unique prefix
      --autonomy <L1..L5>   How much may happen unattended (default L2)
      --budget <usd>        Cost ceiling for this run
      --dry-run             Plan only; never edits files
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
  toris init && toris doctor
  toris project add .
  toris run "add a health endpoint" --dry-run
  toris run "fix the failing parser test" --autonomy L3
  toris receipt run_abc123 --md > receipt.md`;

export function printHelp() {
  line(USAGE);
}

export function printCommandList() {
  line(c.dim('Run `toris --help` for usage.'));
}
