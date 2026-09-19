# Toris Studio

Toris Studio is a localhost-only workspace for reviewing post drafts and MP4 renders, and for talking to the same coding agent the TUI exposes. It is available at `http://127.0.0.1:5824` and persists its state in `~/.toris` by default.

## Start and stop

Foreground mode is useful while developing:

```bash
toris studio
toris studio --open
```

`--open` starts Studio if the loopback port is free, or attaches when `127.0.0.1:5824` is already running, then opens the loopback URL in the OS browser. From the TUI, `/studio` opens that same URL when Studio is up, or points you at `toris studio --open`.

On macOS, install the per-user LaunchAgent for login startup and restart-on-failure behavior:

```bash
toris studio service install
toris studio service status
toris studio service restart
toris studio service uninstall
```

Install creates `~/.toris/runtime/auto-shorts` with `uv`, then writes `~/Library/LaunchAgents/kr.toris.agent.studio.plist`. Logs are written to `~/.toris/logs/studio.out.log` and `~/.toris/logs/studio.err.log`. Uninstall removes the LaunchAgent but preserves drafts, renders, logs, and the Python runtime.

## Agent room

The coding agent from `toris` chat is also on `http://127.0.0.1:5824/agent`. Pick a profile in the left rail and send a message; the inspector shows the matching TUI commands (`toris`, `/agent`, `/studio`). Sending a message auto-approves tools for that turn — the click is the confirmation.

`GET /api/agents` and `GET /api/agent/status` are readable without a session token. The list is the same catalogue as `toris agents`, including `.toris/agents/*.json` overlays from Studio's working directory. `POST /api/agent/turn` is a mutation: it needs the current local `Origin` and the in-memory session token. It still returns JSON by default. Send `Accept: text/event-stream` to stream `text` / `tool-start` progress and a terminal `done` event with the same success payload. Invalid input fails as JSON before a stream starts. Studio still binds only to `127.0.0.1`. The `/agent` room consumes the stream when available, shows progressive text, supports Stop, Enter-to-send, and keeps a per-agent transcript in `localStorage`.

## Design Mode

Design Mode is the ADE slice for a solo web UI: pick live elements, attach evidence, let the coding agent edit source.

Open `http://127.0.0.1:5824/design` (or the 디자인 tab).

1. Load a target URL (your localhost app, or any `http`/`https` page). Studio proxies it into a sandboxed iframe and injects an element picker — no Chromium dependency.
2. Click an element. Studio records the CSS selector path, bounded `outerHTML`, key computed styles (color, font, spacing), page URL, and a cropped screenshot when the browser can rasterize it. Each pick lands in the annotation tray.
3. Optionally write a short per-element note, pick more elements, then send **one** instruction with the whole tray. That payload is persisted under `~/.toris/studio/design/` (`des_*.json`, optional `des_*.png`, and `tray.json`) and attached to a single `POST /api/agent/turn`.
4. After a successful send, the tray clears. Capture files stay on disk so you can re-queue them.

For pages that cannot be proxied usefully (strict CSP, authenticated SPAs), drag the **Toris pick** bookmarklet onto the bookmark bar. In the app tab, click it, pick an element, and Studio opens `/design#ingest=...` on loopback. The ingest page is same-origin, so the capture is stored with the usual Origin + session token.

A built-in sample page at `/design/sample` is always available so the picker can be exercised without a second server.

The proxy only fetches `http`/`https` URLs, strips a target document CSP, and frames the result with `frame-ancestors 'self'`. Untrusted target scripts run in a sandboxed iframe without `allow-same-origin`, so they cannot read the Studio session token.

## Patch Review

After Design Mode or an agent run leaves an isolated diff, open `http://127.0.0.1:5824/patches` (or the 패치 tab).

1. The left rail lists records from the same `toris patches` store (`~/.toris/patches.json` and `~/.toris/patches/*.diff`). Filter pending, applied, discarded, or all.
2. The canvas shows metadata and a readable unified diff. Huge diffs are truncated in the GUI; `toris diff <id>` still prints the full file.
3. **적용** and **폐기** call the same `applySavedPatch` / `discardSavedPatch` functions as the CLI. They are mutations: current local `Origin` plus the in-memory session token.
4. Optionally select a hunk, write a short review note, and send it as an implementer turn (`POST /api/patches/:id/review`). The turn runs inside the isolated worktree (`record.worktreePath`), not the Studio process directory. After the turn, Studio restages that worktree and replaces `~/.toris/patches/<id>.diff`, so **적용** applies the reviewed diff. If the worktree is gone, review is rejected rather than writing the original checkout. A **use on next turn** pin from `/knowledge` is forwarded as `{ domain, nodeId }` on that same request (same localStorage key as `/agent`, Design Mode, and `/android`) and consumed only after the review is accepted. Unknown pin ids are HTTP 400 (no model call, no write). A failed send leaves the pin in place.

CLI `toris patches`, `toris apply`, and `toris discard` are unchanged.

## Knowledge

`http://127.0.0.1:5824/knowledge` browses the same local secretary store as `toris knowledge`: domains, nodes, and DAG edges, with simple add forms. The selected domain shows a **read-only DAG panel** (nested list of title/kind plus edges; click a node for its short body). Each DAG node has one **use on next turn** control: the next `POST /api/agent/turn` from `/agent`, Design Mode, or `/android` — or the next Patch Review implementer turn (`POST /api/patches/:id/review`) — sends that domain + node id and consumes the pin only after the request is accepted. The server loads the stored note and prepends a capped title/kind/excerpt block. Missing ids are HTTP 400 (no model call, no write). Unchecked turns omit the pin. Auto-retrieve stays as-is. Empty domains stay quiet. `GET /api/knowledge/domains/:slug/dag` is the same-origin JSON read of that graph and does not write. A small **add node** form writes one node (`POST /api/knowledge/domains/:slug/nodes` → `KnowledgeStore.addNode`) and, when a valid existing node id is chosen, one edge (`KnowledgeStore.link`) using an existing DAG kind. Invalid kind or unknown target is HTTP 400 and writes nothing. Duplicate node ids are HTTP 409. GET and page load never write. A small **Reflect** panel shows the latest verified-run proposal (goal, short outcome, domain guess) or a quiet empty line. `GET /api/knowledge/reflect` is read-only and never writes. **Accept** (`POST /api/knowledge/reflect/accept`) writes that one tacit note through the same `acceptReflections` / `addTacit` path as `toris knowledge reflect --write` and `/reflect accept`. **Dismiss** (`POST /api/knowledge/reflect/dismiss`) does not write. Failed or unverified receipts are not shown as success proposals. Mutations still need the local `Origin` and session token. See [KNOWLEDGE.md](./KNOWLEDGE.md).

## Daemon

`http://127.0.0.1:5824/daemon` is a standalone page over the same local worker store as `toris daemon status` and `toris daemon schedule`. It shows whether the worker is running (pid, uptime, heartbeat, next due schedule), the schedule list, and a bounded recent-job history from `daemon-jobs.json`.

Enable, disable, remove, and the optional add-schedule form call the existing schedule helpers (`addSchedule`, `setScheduleEnabled`, `removeSchedule`). **Queue run** posts a one-shot inbox job (`POST /api/daemon/run`) with the same shape as `toris daemon run`: a goal plus optional `dryRun`, `autonomy`, and `budgetUsd`. Autonomy must be L1–L5. If Studio was started from a registered project path, that project's checks are attached the same way as the CLI (the browser does not send them). If the worker is down the route returns HTTP 503 (CLI exit 5). Goals that are only `brief` / `toris brief` are refused with HTTP 400, same as the CLI. These mutations need the current local `Origin` plus the in-memory session token. Reads are same-origin GET. Studio still binds only to `127.0.0.1`.

The page does **not** start or stop the worker — that stays on `toris daemon start` / `stop` so a browser tab cannot take the lock. See [DAEMON.md](./DAEMON.md).

## Brief

`http://127.0.0.1:5824/brief` is a standalone read-only page for the same local secretary digest as `toris brief`: today's spend, today's runs, daemon running/next due, and 3–5 tacit/node headlines. Empty run and knowledge sections stay quiet. `GET /api/brief` is the same-origin JSON read (`buildBrief`). There is no send, enqueue, or start/stop from this page. See [BRIEF.md](./BRIEF.md).

## Android

`http://127.0.0.1:5824/android` is a standalone page for optional device evidence — the Studio counterpart of `toris android status|devices|screenshot|logcat`. It shows whether `adb` / `emulator` are on PATH, lists connected devices, captures a screenshot or a short logcat dump into `~/.toris/android/`, and browses the newest local artifacts.

Select one or more of those artifacts, write **one** instruction, and send. Studio attaches bounded evidence (canonical screenshot path, plus a short logcat excerpt when a log is selected) to the same `POST /api/agent/turn` Design Mode already uses. There is no second turn endpoint. Mutations need the current local `Origin` plus the in-memory session token.

`GET /api/android` is the same shape as `androidStatus` (paths, version, device list). Missing `adb` is a quiet 200, not a 500. `GET /api/android/artifacts` lists the newest ~20 files under `~/.toris/android/` (`name`, `bytes`, `mtime`). Screenshot and logcat are mutations: current local `Origin` plus the in-memory session token. Image previews are served only from that folder (`GET /api/android/media?path=…`); path traversal is rejected. `install` stays CLI-only so Studio cannot be pointed at an APK path.

Studio still binds only to `127.0.0.1`. No Android SDK is required to open the page.

## Review flow

1. Save a post draft or import an MP4. The item enters `awaiting_review`.
2. Start a 15, 30, 45, or 60 second local render.
3. Studio records H.264, AAC, 1080x1920, duration, and frame-rate checks alongside the rendered file.
4. The external-release dialog verifies the exact content hash and confirmation phrase, then remains blocked. Studio has no external publisher or social API adapter.

Rendered videos are stored below `~/.toris/studio/content/<content-id>/render/final.mp4`. The HTTP media route supports byte ranges so the local browser can seek and play the result.

## Local security boundary

- The HTTP server refuses any bind address other than `127.0.0.1`.
- Mutating requests require the exact local `Origin` and a per-process session token.
- JSON and raw MP4 uploads are bounded before persistence.
- User-editable patches cannot replace media paths, quality evidence, status, or publication fields.
- Render source paths must remain inside the configured Toris home.
- External publishing, scheduling, likes, comments, follows, and direct messages are not implemented by Studio.
