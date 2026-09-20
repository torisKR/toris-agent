# Local daemon

A background worker so a queued or **scheduled** `run` can outlive a TUI session. It is **not** a cloud service, not multi-machine, and it does not open a network port. There is no `daemon.sock` RPC in this release.

```bash
toris daemon start
toris daemon status
toris daemon run "add a health endpoint" --dry-run
toris daemon schedule add "@daily" "add a health endpoint" --dry-run
toris daemon stop
```

State lives under `$TORIS_HOME` (default `~/.toris`):

| Path | Role |
| --- | --- |
| `daemon.lock` / `daemon.json` | exclusive owner + heartbeat |
| `daemon/inbox/` | jobs dropped by `daemon run` and by the scheduler tick |
| `daemon/schedules/*.json` | one file per schedule |
| `daemon-jobs.json` | worker-owned job history |
| `logs/daemon.log` | detached worker stdout/stderr |

`toris run` itself still executes in the foreground. Only `toris daemon run` and due schedules enqueue work.

Studio `/daemon` at `http://127.0.0.1:5824/daemon` reads the same status, schedules, and job history. Schedule enable/disable/remove/add use the same store mutations (Origin + session token). **Queue run** is `POST /api/daemon/run`: the same inbox drop as `toris daemon run` (goal plus optional dry-run / autonomy / budget). HTTP 503 maps CLI exit 5 when the worker is down; `brief` / `toris brief` goals are refused. The page does not start or stop the worker. Shared Studio chrome shows a quiet read-only `daemon` chip from `GET /api/daemon` when the worker is running (hidden when it is not); the chip only links to `/daemon`.

## Schedules

Schedules are local cron. The running daemon evaluates them on its heartbeat (default 2s) in the **machine local timezone**, then enqueues a `run` job through the same inbox as `toris daemon run`. Adding a schedule does not require the daemon to be up; the next tick after `start` picks it up.

```bash
toris daemon schedule list
toris daemon schedule add "@every 30m" "lint the repo" --dry-run
toris daemon schedule add "09:00 mon-fri" "draft the standup"
toris daemon schedule add "0 6 * * 1-5" "review open PRs" --autonomy L3 --budget 2
toris daemon schedule disable sch_…
toris daemon schedule enable sch_…
toris daemon schedule remove sch_…
```

`--json` works on every subcommand. `toris daemon status` reports schedule count and the next due time.

The same schedule will not double-fire while a prior job from it is still `queued` or `running`. A slot missed while the daemon was down is caught up **once** on the next tick (no backlog of every missed minute).

### Expression subset

| Form | Example | Meaning |
| --- | --- | --- |
| 5-field cron | `0 9 * * 1-5` | minute hour day-of-month month day-of-week |
| aliases | `@hourly` `@daily` `@weekly` `@monthly` | expand to cron (`@midnight` = `@daily`) |
| interval | `@every 15m` `@every 2h` | first fire after one interval from add/enable |
| clock | `09:00` `09:00 mon-fri` `21:30 weekdays` | 24-hour local time; optional weekday list |

Cron fields accept `*`, `n`, `n-m`, `*/n`, `n,m`, and English names (`mon`, `jan`). Day-of-week is 0–6 (Sunday=0) or `7` for Sunday. When both day-of-month and day-of-week are restricted, a date matches if **either** field matches (standard cron).

Weekday words on the clock form: `mon`–`sun`, `mon-fri`, `weekdays`, `weekends`, comma lists.

Not supported: seconds fields, `@reboot`, cloud calendars, remote multi-machine clocks, or a timezone other than the host's local zone.

Autonomy / budget / `--dry-run` / `--apply` / `--no-review` / `--provider` / `-p` on `schedule add` become defaults for each fired job (same as `daemon run`). Omit them to use the daemon's usual config defaults.

`toris brief` is **not** a daemon job. The worker has a single job type (`run`). Scheduling `"toris brief"` as a goal would start a coding run; `schedule add` and `daemon run` refuse that goal. Put the CLI on host cron / systemd / launchd instead (`0 9 * * * toris brief`). See [BRIEF.md](./BRIEF.md).
