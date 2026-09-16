# Toris Studio

Toris Studio is a localhost-only workspace for reviewing post drafts and MP4 renders, and for talking to the same coding agent the TUI exposes. It is available at `http://127.0.0.1:5824` and persists its state in `~/.toris` by default.

## Start and stop

Foreground mode is useful while developing:

```bash
toris studio
```

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

`GET /api/agents` and `GET /api/agent/status` are readable without a session token. `POST /api/agent/turn` is a mutation: it needs the current local `Origin` and the in-memory session token. Studio still binds only to `127.0.0.1`.

## Design Mode

Design Mode is the ADE slice for a solo web UI: pick a live element, attach evidence, let the coding agent edit source.

Open `http://127.0.0.1:5824/design` (or the 디자인 tab).

1. Load a target URL (your localhost app, or any `http`/`https` page). Studio proxies it into a sandboxed iframe and injects an element picker — no Chromium dependency.
2. Click an element. Studio records the CSS selector path, bounded `outerHTML`, key computed styles (color, font, spacing), page URL, and a cropped screenshot when the browser can rasterize it.
3. Write a short instruction and send. That payload is persisted under `~/.toris/studio/design/` and attached to `POST /api/agent/turn`, so the agent sees the live UI rather than a vibe.

For pages that cannot be proxied usefully (strict CSP, authenticated SPAs), drag the **Toris pick** bookmarklet onto the bookmark bar. In the app tab, click it, pick an element, and Studio opens `/design#ingest=...` on loopback. The ingest page is same-origin, so the capture is stored with the usual Origin + session token.

A built-in sample page at `/design/sample` is always available so the picker can be exercised without a second server.

The proxy only fetches `http`/`https` URLs, strips a target document CSP, and frames the result with `frame-ancestors 'self'`. Untrusted target scripts run in a sandboxed iframe without `allow-same-origin`, so they cannot read the Studio session token.

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
