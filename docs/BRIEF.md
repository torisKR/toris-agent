# Brief — local secretary digest

`toris brief` prints one screen of what matters today so a solo builder (or a `@daily` timer) does not have to open `cost`, `runs`, `daemon status`, and `knowledge search`.

It is a **foreground CLI**. It reads existing stores and writes nothing.

```bash
toris brief              # today (default)
toris brief today
toris brief --json
```

`--home` / `--json` / `--no-color` work as they do on every other command.

## What it shows

| Section | Source | Quiet when |
| --- | --- | --- |
| **Spend** | `~/.toris/cost.json` + run files via `summarizeCost` | never (today's `$0 / cap` is still the fact) |
| **Runs** | `~/.toris/runs/*.json` for the local calendar day | no runs today |
| **Daemon** | `daemon.json` + `daemon/schedules/` | never for running/not; next-due line omitted if none |
| **Knowledge** | keyword search over `index.json`, else latest tacit | store not initialized, or no headlines |

Run rows are bounded (id, goal summary, status, verify pass/fail/n/a). Knowledge headlines are 3–5 tacit or node titles. Query tokens come from today's goals when those exist.

There is no new persistence format and no Slack/Telegram send. Stdout (text or JSON) is the product.

## Scheduling — do not use `daemon schedule`

The local daemon only enqueues **coding `run` jobs**. This is the wrong pattern:

```bash
# Do not do this — it is a coding goal, not the digest
toris daemon schedule add "09:00" "toris brief"
toris daemon run "toris brief"
```

Those commands are refused (Studio **Queue run** uses the same check). A schedule named `toris brief` would otherwise burn a planner/provider turn on the words "toris brief".

Schedule the CLI itself with host cron, systemd, or launchd:

```bash
# crontab — machine local timezone, same as the cost ledger
0 9 * * * toris brief
0 9 * * * toris brief --json >> ~/.toris/logs/brief.jsonl
```

```bash
# systemd --user timer (ExecStart)
toris brief
```

```bash
# launchd StartCalendarInterval, ProgramArguments
toris
brief
```

`@daily` on `toris daemon schedule` is for recurring **goals** (`lint the repo`, `draft the standup`), not for this digest. See [DAEMON.md](./DAEMON.md).

## Studio

The same digest is on the loopback GUI at `http://127.0.0.1:5824/brief` (`GET /api/brief`). Read-only — no Slack/Telegram send, no daemon start/stop, no enqueue. See [STUDIO.md](./STUDIO.md).
