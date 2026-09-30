# Recording the terminal walkthrough

The README images, MP4, and asciicast come from the actual CLI running in a
96-column pseudoterminal. The recorder types `toris init --solo`, then opens
`toris --offline` and runs `/status`, `/plan`, `/check`, `/receipt`, `/help`,
and `/exit`. State is isolated in a temporary directory. The project checks
are the checkout's real lint and test commands.

The recording demonstrates local setup and evidence inspection. It does not
simulate successful model responses or AI coding. An offline plan creates a
dry-run receipt; the independent `/check` results do not verify that plan.

## Regenerate

On Linux, install Python 3 with Pillow, pexpect and pyte, ffmpeg with libx264,
and the DejaVu Sans Mono fonts. These are documentation tools, not application
dependencies. Node.js 22.6+ and Git are needed for the project workflow.

```bash
python3 -m venv /tmp/toris-media-tools
/tmp/toris-media-tools/bin/pip install Pillow pexpect pyte
/tmp/toris-media-tools/bin/python scripts/record-terminal-demo.py
```

Alternatively, pass `--python-deps /path/to/tool-only/packages` for an existing
dependency directory. Use `--output /tmp/toris-media-preview` to preview assets
without replacing the README files. The script refuses to produce a finished
video when checks fail or the session does not report zero model turns.

The `.cast` stores actual terminal output and timing. The renderer replays
those events, including line wrapping and scrolling, to create an H.264 MP4
with a terminal frame. The three PNGs capture the actual workspace, plan, and
check states; the WebP poster uses the workspace image.

Inspect the PNGs and decode the video before committing regenerated assets:

```bash
ffprobe -v error -show_format -show_streams docs/assets/readme/terminal-demo.mp4
ffmpeg -v error -i docs/assets/readme/terminal-demo.mp4 -f null -
```
