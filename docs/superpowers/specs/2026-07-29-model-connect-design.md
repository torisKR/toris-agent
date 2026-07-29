# Model Connect Flow — Design Spec

Date: 2026-07-29
Status: Approved (user approved "승인 — 바로 구현")

## Problem

`toris chat` (and `/goal`) fails with `No model profiles are configured` when
`models.profiles` is empty. There is no onboarding flow: users must hand-edit
`~/.toris/config.json` and export API keys. Additionally, chat only supports
direct-API providers (`anthropic`, `openai`); the already-installed and
already-authenticated `claude` / `codex` CLIs cannot be used as chat backends.

## Goal

An opencode/gemini-cli style connection experience:

1. `toris connect` — interactive wizard that detects available backends,
   creates a model profile, and routes `chat` to it.
2. Auto-onboarding — `toris chat` with zero profiles launches the wizard
   (TTY only; non-TTY/`--json` keeps the current error).
3. CLI-backed chat providers — `claude-cli` and `codex-cli` become valid chat
   transports by spawning the installed CLI per turn, reusing its existing
   login session. No API key needed.

## Non-Goals

- OAuth token extraction from claude CLI credentials (fragile: Keychain,
  refresh). Rejected in favor of subprocess bridging.
- API-key storage in config or auth.json. Keys stay in the environment
  (existing repo policy: "Keys live in the environment, never in config").
- Hardcoded model IDs in product code (existing repo policy). The wizard asks
  the user to type a model id for API providers; CLI providers use `auto`.

## Architecture

### 1. Provider contract (existing, unchanged)

`provider.stream({model, system, messages, tools, maxTokens, signal})` is an
async iterator yielding:

- `{type:'text', delta:string}` — live text deltas
- `{type:'done', text, toolCalls:ToolCall[], stopReason, usage:{inputTokens,outputTokens}}`

Neutral history: `{role:'user'|'assistant'|'tool', ...}` (see `src/core/chat.js`).

### 2. New: `src/providers/claude-cli.js`

`createClaudeCliProvider({bin='claude', timeoutMs, env})` returning
`{name:'claude-cli', stream, complete}`.

- Per `stream()` call, spawn:
  `claude -p <prompt> --output-format stream-json --verbose`
  (stream-json requires `--verbose` in print mode).
- Prompt: last user message content. Conversation continuity via session
  resume: capture `session_id` from the `system:init` NDJSON event on the
  first turn; subsequent turns pass `--resume <session_id>`.
- System prompt: pass through `--append-system-prompt` on the first turn only.
- Parse NDJSON lines from stdout:
  - `{type:'assistant', message:{content:[{type:'text',text}...]}}` → yield
    `{type:'text', delta}` per text block
  - `{type:'result', ...}` → final; yield
    `{type:'done', text, toolCalls: [], stopReason:'end_turn', usage}` mapping
    `usage.input_tokens/output_tokens` when present, else zeros.
- `toolCalls` is ALWAYS `[]`: the CLI runs its own agent loop and tools;
  toris must not double-drive tools.
- Errors: non-zero exit → `TorisError` with stderr tail, code
  `E_PROVIDER_CLI`. Missing binary → `E_PROVIDER_CLI` naming the bin.
  Respect `signal` (kill process on abort).
- Model: `auto` means no `--model` flag; a concrete model id is forwarded as
  `--model <id>`.

### 3. New: `src/providers/codex-cli.js`

Same shape, `createCodexCliProvider({bin='codex', ...})`:

- Spawn `codex exec <prompt> --json` (JSONL events on stdout).
- Continuity: `codex exec resume <session_id> <prompt> --json` — the agent
  must verify the exact resume syntax against `codex exec --help` at build
  time and adapt; if resume is unavailable, fall back to replaying the
  transcript into the prompt (documented in code).
- Map JSONL events: agent message / delta events → `{type:'text', delta}`;
  terminal event → `{type:'done', ...}` with `toolCalls: []`.
- Token usage from the final event when available, else zeros.

### 4. Registration: `src/providers/index.js`

Add factories `claude-cli` / `codex-cli`. `createProvider` no longer throws
for CLI providers. API-key lookup only applies to API providers. The
`bin` comes from `config.providers.claude.bin` / `config.providers.codex.bin`
(passed by the caller via opts), defaulting to `claude`/`codex`.

### 5. New command: `toris connect` (`src/cli/commands/connect.js`)

Zero-dep wizard using `node:readline/promises` (consistent with chat REPL):

1. Detect candidates:
   - `claude` binary on PATH (`detectBinary`) → "Claude CLI (기존 로그인 재사용)"
   - `codex` binary on PATH → "Codex CLI (기존 로그인 재사용)"
   - `ANTHROPIC_API_KEY` set → "Anthropic API"
   - `OPENAI_API_KEY` set → "OpenAI API"
2. Numbered menu; user picks one. Unavailable options are listed dimmed with
   the reason (not on PATH / env var not set) but not selectable.
3. Model:
   - CLI providers → `auto` by default; optional prompt to pin a model id.
   - API providers → REQUIRED free-text model id (no hardcoded suggestions;
     print where to find ids).
4. Profile name: default `main` (prompt allows override). Writes
   `models.profiles.<name> = {provider, model}` and
   `models.routing.chat = <name>` via `saveConfig` (immutably; preserve
   existing profiles; if routing.chat exists, confirm overwrite).
5. Prints summary + `toris chat` hint. `--json` mode: non-interactive, takes
   `--provider`, `--model`, `--name` flags, errors if missing.

### 6. Chat integration (`src/cli/commands/chat.js`)

- `pickModel`: when zero profiles AND stdin is a TTY AND not `--json`,
  run the connect wizard inline, then continue with the fresh config.
  Otherwise keep the current error (updated to mention `toris connect`).
- `assertUsable`: CLI providers pass without API key checks; verify the
  binary is on PATH instead. `auto` model allowed for CLI providers
  (existing sentinel semantics).
- Tools/skills: for CLI providers, do not register toris internal tools and
  skip the skill briefing prompt injection (the CLI agent already has its
  own tools and skills); status bar shows `tools: delegated`.
- Help text (`src/cli/help.js`) gains `connect`; `COMMANDS` map in
  `src/cli/index.js` gains `connect: cmdConnect`.

### 7. Error handling

- Every failure names the exact config key or binary, matching house style.
- Wizard is cancellable (Ctrl-C / empty selection) → exits without writing.
- CLI provider surfaces stderr tail (≤500 chars) on failure.

### 8. Testing

`node --test` (zero-dep). New test files:

- `test/connect.test.js` — wizard pure logic: candidate detection (injected
  env/detectBinary), config mutation immutability, routing overwrite guard,
  `--json` non-interactive path.
- `test/claude-cli-provider.test.js` — NDJSON parsing (init/session_id
  capture, text deltas, result mapping, malformed lines ignored), arg
  construction (first turn vs resume, auto vs pinned model), error mapping.
  Subprocess faked with injected spawn.
- `test/codex-cli-provider.test.js` — same shape for codex JSONL.
- `test/chat.test.js` — extended: CLI provider passes assertUsable without
  keys; zero-profile non-TTY still errors mentioning `toris connect`.

Providers accept an injectable `spawnImpl` so tests never spawn real CLIs.

## Implementation Plan (parallel)

- Agent 1 (opus): `src/cli/commands/connect.js` + `test/connect.test.js` —
  self-contained; exports `cmdConnect` and `runConnectWizard`.
- Agent 2 (opus): `src/providers/claude-cli.js` + tests.
- Agent 3 (opus): `src/providers/codex-cli.js` + tests.
- PM (this session): wiring — `providers/index.js`, `chat.js`, `help.js`,
  `cli/index.js` — then integration review, full test run, local reinstall.

Shared files are touched ONLY by the PM to avoid merge conflicts.
