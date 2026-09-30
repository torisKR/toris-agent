# Toris terminal design

Toris is a local development harness for one person working in a repository. The terminal is the product interface: no browser, web server, port, or desktop autostart is required.

## The working sequence

1. `toris init --solo` registers the project and detects its checks.
2. `toris --offline` lets a new user inspect the workspace before connecting a model.
3. `/status` shows the project, editing directory, autonomy, agent count, budget, checks, and pending patches.
4. `/plan <goal>` previews work. `/run <goal>` executes it through the existing orchestrator.
5. `/check` tests the active files. `/diff` shows the proposed changes. `/receipt` shows the evidence collected for the run.
6. `/apply` and `/discard` settle a live isolated chat and finish that session. The next session starts with `toris`.

Fresh solo setup uses L2, one agent, a $20 daily run budget, and automatic knowledge retrieval. Existing settings win over the preset. L3 remains an explicit automatic-apply option. Model authentication belongs to the selected CLI or API backend; initialization does not claim a successful login.

## Layout and type

Use the existing system terminal font and ordinary Unicode; no patched font is required. The welcome box is capped at 64 columns. Below 40 columns, use a stacked header. Clip banner, palette, and status-strip rows to the reported width. A terminal with no negotiated width uses 80 columns.

Keep the prompt visible after local operations. Present one labeled fact per row in `/status`, an aligned task table for a plan, and a PASS/FAIL row per check. Long evidence and diffs remain selectable terminal text and may wrap naturally. Do not replace them with decorative cards.

## Color and keyboard

The accent is ANSI 256-color 209, used for the prompt and product mark. Success uses green, blocked or pending work uses yellow, and errors use red. Words and exit codes always carry the meaning; color alone does not. Respect `NO_COLOR`, `TERM=dumb`, and `--no-color`.

Typing `/` opens the command palette. Tab completes a command or agent. Readline supplies history and normal cursor editing. Ctrl-C interrupts a model turn; at an idle prompt it clears input or asks for a second press to exit. Ctrl-D and `/exit` leave the session. A local command error returns to the prompt.

## Honest states

- Offline means no model calls: prose and task execution are refused. A plan is deterministic and no coding task executes.
- A dry-run receipt records a plan, not successful implementation or verification.
- `/check` executes configured checks against the live chat worktree, or the latest pending run worktree after `/run`. A subsequent model message returns the focus to chat. Applied runs use the project checkout.
- No detected checks means unverified. Never print PASS for an empty check list.
- Independent `/check` results do not rewrite a run receipt. Receipts describe the checks actually performed in that run.
- CLI chat uses a Git worktree when possible. Direct API chat tools operate in the checkout. The interface and documentation must state that distinction.
- Daily and per-run budget limits belong to orchestrated runs. Do not imply the interactive chat token strip enforces a dollar ceiling.

## Evidence and documentation

README screenshots and the MP4 are rendered from a real pseudoterminal recording. Preserve the captured ANSI output and timing in the downloadable `.cast` artifact. Describe the offline walkthrough accurately; do not present a synthetic provider fixture as a successful AI coding run.

Validate terminal behavior with subprocess tests and a real PTY. Run the project checks, inspect screenshots for clipped text, decode the MP4, and check every README asset link before handoff.
