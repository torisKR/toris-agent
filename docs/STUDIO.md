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
4. Optionally select a hunk, write a short review note, and send it as an implementer turn (`POST /api/patches/:id/review`). The turn runs inside the isolated worktree (`record.worktreePath`), not the Studio process directory. After the turn, Studio restages that worktree and replaces `~/.toris/patches/<id>.diff`, so **적용** applies the reviewed diff. If the worktree is gone, review is rejected rather than writing the original checkout.

CLI `toris patches`, `toris apply`, and `toris discard` are unchanged.

## Knowledge

`http://127.0.0.1:5824/knowledge` browses the same local secretary store as `toris knowledge`: domains, nodes, and DAG edges, with simple add forms. It is a standalone page (`knowledge.html`) and does not share the review-room or patch-review client. Mutations still need the local `Origin` and session token. See [KNOWLEDGE.md](./KNOWLEDGE.md).

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
