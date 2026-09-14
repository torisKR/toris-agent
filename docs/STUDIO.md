# Toris Studio

Toris Studio is a localhost-only workspace for reviewing post drafts and MP4 renders, and for talking to the same coding agent the TUI exposes. It is available at `http://127.0.0.1:5824` and persists its state in `~/.toris` by default.

## Start and stop

Foreground mode is useful while developing:

```bash
toris studio
toris studio --open
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

The coding agent from `toris` chat is also on `http://127.0.0.1:5824/agent`. Pick a profile in the left rail and send a message; the inspector shows the matching TUI commands (`toris`, `/agent`, `/studio`). From the TUI, `/studio` opens that URL when Studio is already running. Sending a message auto-approves tools for that turn — the click is the confirmation.

`GET /api/agents` and `GET /api/agent/status` are readable without a session token. `POST /api/agent/turn` is a mutation: it needs the current local `Origin` and the in-memory session token. Clients that send `Accept: text/event-stream` receive the same turn events as the TUI (`text`, `tool-start`, then `done`); JSON remains the default. Studio still binds only to `127.0.0.1`. The GUI composer keeps a transcript per agent, sends on Enter, and accepts `/agent`, `/clear`, and `/help`.

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
