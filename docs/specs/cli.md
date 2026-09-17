## `toris-agent` (apps/cli) — command surface

Binary: `toris`. Global flags: `--json`, `--home <dir>`, `--no-color`, `--verbose`.
Every command MUST support `--json` emitting a single JSON object to stdout.

```
toris init                       # scaffold ~/.toris/config.yaml
toris doctor                     # runtime, adapters, git, db, daemon checks (exit 1 if any FAIL)
toris project add [path] | list | inspect <id> | remove <id>
toris run "<goal>" [-p <project>] [--autonomy L1..L5] [--budget <usd>] [--dry-run] [--yes]
toris runs [--status <s>] [--project <id>] [--limit <n>]
toris inspect <runId>            # run detail
toris receipt <runId> [--md]     # evidence receipt
toris cost [today] [--json]      # cross-run spend vs maxDailyCostUsd
toris brief [today] [--json]     # local secretary digest (spend, runs, daemon, knowledge)
toris approvals [--run <id>] | toris approve <id> [--reason] | toris reject <id> [--reason]
toris logs <runId> [-f]          # event tail
toris cancel <runId>
toris daemon start|stop|status   # local pid/lock worker; --json status
toris daemon run "<goal>"        # queue a run (exit 5 if the daemon is down)
toris daemon schedule list|add|remove|enable|disable   # local cron only
toris agents [--category <c>]    # agent profile catalog (builtins + .toris/agents/*.json)
toris skills
toris version
```

Exit codes: `0` success, `1` generic failure, `2` usage error, `3` verification failed, `4` approval denied/timeout, `5` daemon unavailable.
