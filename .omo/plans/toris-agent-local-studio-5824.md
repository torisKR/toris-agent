# Toris Studio 5824 implementation plan

## Outcome

Run a persistent local creator studio at `http://127.0.0.1:5824` that imports post briefs and vertical video, queues reviewable work, renders through bundled `auto_shorts`, records structured quality evidence, and keeps public publishing behind two explicit confirmations.

## Invariants

- Bind only to `127.0.0.1`; never enable CORS.
- Store contents and jobs under `TORIS_HOME` with atomic JSON writes.
- Use Node built-ins and a fixed Python bridge with `shell: false`, bounded I/O, timeouts, and structured failures.
- Keep imported and rendered work at `awaiting_review` until a human confirms publication.
- Reject publication before credentials or network when quality, content hash, web confirmation, or exact confirmation text is missing.
- Preserve the source auto_shorts checkout; bundle a clean engine snapshot under `python/auto_shorts`.

## Delivery waves

1. Bundle the Python engine and lock its CLI and quality contracts with RED then GREEN tests.
2. Add content storage, HTTP primitives, Python bridge, foreground `toris studio`, and health/session/content/upload/job APIs.
3. Write `DESIGN.md`, implement primitives, and expose `/design-system` before product screens.
4. Build the Korean-first review queue, editor, importer, media reviewer, render state, and evidence receipt UI.
5. Add macOS user LaunchAgent install/status/restart/uninstall commands and recovery tests.
6. Add render jobs, H.264/AAC 1080x1920 quality reports, and double-gated publish delegation.
7. Run targeted tests, lint, bundled Python tests, HTTP/browser QA at 375/768/1280, keyboard/reduced-motion checks, launchd recovery, cleanup, and independent review.

## State machines

Content: `draft | imported | queued | rendering | quality_failed | awaiting_review | publishing | submitted | failed`.

Job: `queued | running | succeeded | failed | cancelled`.

## Acceptance evidence

- `curl -i http://127.0.0.1:5824/api/health` returns 200 and local-only studio data.
- Valid brief JSON and MP4 imports persist; malformed and oversized inputs do not create records.
- A render finishes with 1080x1920 H.264/AAC output plus machine-readable quality evidence.
- Publish attempts without every gate fail before any credential or network adapter is invoked.
- A user LaunchAgent survives the invoking CLI process and stays healthy on port 5824.
- Browser receipts cover mobile, tablet, desktop, keyboard, and reduced motion.

## Stop condition

Complete only when the persistent service, ingest/review flow, render/quality path, publication gate, real-surface QA, cleanup receipts, and final reviewer approval hold for the same commit.
