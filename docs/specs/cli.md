## `toris-agent` — terminal command surface

Binary: `toris`, dispatched by `src/cli/index.js`; built-in help lives in
`src/cli/help.js`. Configuration is `<home>/config.json`, with `~/.toris` as the
default home. `--home <dir>` overrides `TORIS_HOME` and the default.

Global flags: `--json`, `--home <dir>`, `--no-color`, `--verbose`, `-h`/`--help`,
and `-v`/`--version`. JSON output disables ANSI colour. Finite commands emit their
result as a JSON object; for a chat result use `toris chat "<message>" --json`.
`bot` and `daemon start --foreground` remain running after their JSON readiness
output.

Bare `toris` opens the chat TUI when both stdin and stdout are terminals and
`--json` is absent. `toris --agent <id>` selects its initial role. The first
interactive chat can guide model connection when no profiles exist. With no
command in a pipe or CI, Toris prints help and exits `2`; with `--json`, it
prints the usage and command list and exits `0`. Help is global: `toris --help`
prints it and exits `2`, while `toris run --help` prints the same help and exits
`0`. `toris --version` and `toris version` print the version.

```text
toris                                      # interactive chat TUI
toris --agent <id>                         # start the TUI as a catalogue role
toris init [--solo]                        # config.json, store and starter knowledge
toris doctor                              # runtime/provider/git/store checks; exit 1 on FAIL
toris connect [--provider <id>] [--model <id>] [--name <profile>]
toris chat ["<message>"] [--agent <id>] [--profile <name>] [--no-knowledge]
toris project add [path]                   # defaults to cwd
toris project list
toris project inspect <id>
toris project remove <id>
toris run "<goal>" [run-options]
toris runs [--status <s>] [--project <id>] [--limit <n>]
toris inspect <runId>
toris receipt <runId> [--md]
toris cost [today]                         # cross-run spend vs maxDailyCostUsd
toris brief [today]                        # spend, runs, daemon and knowledge digest
toris logs <runId>                         # saved event log
toris cancel <runId>                       # mark the stored run cancelled
toris approvals [--run <id>]
toris approve <id> [--reason <text>]
toris reject <id> [--reason <text>]
toris agents [--category <c>]
toris skills
toris autonomy
toris patches [--status <s>]
toris diff <patchId>
toris apply <patchId>
toris discard <patchId>
toris daemon [status]
toris daemon start [--foreground]
toris daemon stop
toris daemon run "<goal>" [run-options]
toris daemon schedule [list]
toris daemon schedule add <expr> "<goal>" [run-options] [--disabled]
toris daemon schedule remove|enable|disable <id>
toris android [status]
toris android devices
toris android screenshot [--serial <serial>]
toris android logcat [--serial <serial>] [--lines <n>]
toris android install <apk> [--serial <serial>]
toris knowledge [status]                   # detailed subcommands below
toris memory [status]                      # alias for toris knowledge
toris bot                                 # Slack Socket Mode / Telegram listener
toris update [--check]
toris version
```

Run options shared by `run`, `daemon run` and `daemon schedule add`:

```text
-p, --project <ref>       Registered project id, name or unique prefix
    --autonomy <L1..L5>   Override the configured autonomy level
    --budget <usd>        Run cost ceiling
    --dry-run             Plan without executing tasks
    --apply               Apply an isolated L2 diff without asking
    --no-review           Skip the opposite-provider second pass
    --provider <name>     claude | codex
```

`connect` reuses a provider CLI's login or an API key from the environment, saves
a model profile, and routes chat to it. Provider ids are `claude-cli`,
`codex-cli`, `anthropic`, `openai` and `grok`. API providers need a concrete
`--model <id>`; CLI providers can use `auto`. `connect --json` is noninteractive
and requires `--provider`.

`agents` lists the effective builtin, home and project catalogue. Create, edit
or remove overlay JSON files in `~/.toris/agents/` or `<repo>/.toris/agents/`,
then inspect them with `toris agents`. In the TUI, `/agent` lists roles and
`/agent <id>` switches roles. Other session commands include `/status`,
`/plan <goal>`, `/run <goal>`, `/check`, `/diff [id]`, `/receipt [runId]`,
`/model [profile]`, `/autonomy [L1-L5]`, `/knowledge [query]`,
`/reflect [runId|accept]`, `/patches`, `/apply [id]` and `/discard [id]`.
`/help` shows the full session command list.

`patches` lists stored isolated diffs. Inspect one with `diff`, apply it to its
original repository with `apply`, or discard it and its worktree with `discard`.
The daemon is a local pid/lock worker with a file inbox; `daemon run` exits `5`
if it is unavailable. Schedules are local cron expressions or supported cron
aliases such as `@daily`, evaluated in the host timezone while the daemon runs.

Android helpers are optional and use `adb`. Screenshot and logcat evidence is
saved under `<home>/android/screenshots/` and `<home>/android/logs/`. Use
`--serial` when choosing a device; `android status` reports tool and device
availability without requiring a model connection.

### Knowledge and memory

`knowledge` and the top-level `memory` alias share this implemented surface.
For example, `toris memory search flutter` means `toris knowledge search
flutter`; `toris knowledge memory get` reads `MEMORY.md`.

```text
toris knowledge init
toris knowledge status
toris knowledge domains [list]
toris knowledge domains add <slug> [--title <text>] [--when <text>] [--anti <text>] [--body <text>]
toris knowledge domains inspect <slug>
toris knowledge node list <domain>
toris knowledge node get <domain> <id>
toris knowledge node add <domain> --title <text> [--id <id>] [--tags <tags>] [--body <text>]
toris knowledge node link <domain> <from> <to> [--kind <kind>]
toris knowledge tacit list [<domain>]
toris knowledge tacit add [<domain>] --title <text> [--tags <tags>] [--body <text>] [--inbox]
toris knowledge tacit promote <id> --domain <slug>
toris knowledge search <query> [--domain <slug>] [--kind <kind>] [--limit <n>]
toris knowledge reflect [runId] [--domain <slug>] [--write]
toris knowledge memory [get]
toris knowledge memory append|set --text <text>
toris knowledge user [get]
toris knowledge user append|set --text <text>
toris knowledge pack [list]
toris knowledge pack install <slug> [--force]
```

`domain` is an alias for `domains`; `memory add` and `user add` alias `append`.
Node edge kinds are `prerequisite`, `supports`, `conflicts` and `derived-from`
(the default is `supports`). Domain and node additions and links target home
knowledge by default; `--project` selects the project source in the current
directory. `--project-knowledge --project <path>` selects another project
knowledge directory.

`reflect` proposes notes without writing by default, including with `--json`.
It can use a verified run (`runId` or `--from-run <id>`), the latest eligible
run when no input is supplied, or supplied text (`--text <text>` or
`--file <path>`). `--write` explicitly accepts proposals; `--yes` is also
accepted by this subcommand. Pack listing is read-only, and installation copies
an opt-in shipped pack into home knowledge.

Exit codes: `0` success, `1` generic failure, `2` usage error,
`3` verification failed, `4` approval denied/timeout, `5` daemon unavailable.

## Solo terminal workflow

`init --solo` fills missing solo preferences and registers the current Git root (or current directory outside Git), preserving existing settings and project checks. A fresh setup uses L2 manual apply, one agent, a $20 daily run cap, knowledge retrieval, and an available CLI profile. Initialization detects binaries without making model calls.

`toris --offline` or `toris chat --offline` opens local operations without a provider or authentication. Prose and `/run` are refused. `/plan <goal>` uses a deterministic fallback. CLI automation can use `toris run "<goal>" --offline --dry-run`; offline execution without `--dry-run` is a usage error.

The TUI adds `/status`, `/plan <goal>`, `/run <goal>`, `/check` (`/verify`), `/diff [id]`, and `/receipt [runId]`. `/receipt` defaults to the latest run. Local command errors return to the prompt. `/check` follows the live editing worktree or the latest pending run after `/run`, reports the first failed check and its evidence, and describes a zero-check result as unverified. Independent checks do not rewrite run receipts. Live `/apply` or `/discard` ends a CLI-backed chat with restart guidance instead of reusing a deleted directory.
