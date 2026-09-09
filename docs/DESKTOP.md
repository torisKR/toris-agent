# toris Desktop — a ChatGPT-like app for solo entrepreneurs

`toris desktop` is a modern, dark, ChatGPT/open-webui-style desktop application
built on **Tauri v2**. It wraps the same **toris agent chat engine** the CLI uses
— streaming responses, a real tool loop (`read_file`, `list_files`, `write_file`,
`run_command`) and autonomy-gated approvals — and frames it for a **one-person
business (1인 사업가)** with selectable assistant modes.

It works out of the box with **no API key** thanks to a built-in **Demo**
provider, and switches to real models the moment you configure one.

---

## Architecture

```
┌───────────────────────────┐      Tauri events (bridge-event)      ┌──────────────────────┐
│  Webview (desktop/)        │  ◀───────────────────────────────────│  Rust backend        │
│  vanilla TS + Vite         │                                       │  (src-tauri/)        │
│  ChatGPT-like UI           │  ──────  invoke("bridge_write")  ────▶│  spawns + pipes      │
└───────────────────────────┘                                       └──────────┬───────────┘
                                                                                │ stdio (NDJSON)
                                                                     ┌──────────▼───────────┐
                                                                     │  Node sidecar        │
                                                                     │  src/desktop/bridge.js│
                                                                     │  → createChatSession  │
                                                                     │  → providers + tools  │
                                                                     │  → Demo provider      │
                                                                     └──────────────────────┘
```

- **Frontend** (`desktop/`): a lightweight Vite + TypeScript single-page app. Its
  dependencies live in `desktop/package.json` **devDependencies** only, so the
  root `toris-agent` package keeps its **zero runtime dependencies**.
- **Rust backend** (`src-tauri/`): a thin host. On startup it spawns the Node
  sidecar, forwards every NDJSON line the sidecar prints to the webview as a
  `bridge-event`, and exposes one `bridge_write` command for the UI to send
  commands back (send / approval / abort / reset / set-key / add-profile).
- **Node sidecar** (`src/desktop/bridge.js`): drives the **real** toris chat
  engine. It reuses `createChatSession`, the existing providers and the default
  tools — model calls are **not** reimplemented. It speaks a small NDJSON
  protocol over stdio.

The bridge is plain ESM with no dependencies and ships inside the `src/` tree, so
it is covered by `npm run lint` and `npm test` like the rest of the engine.

---

## Prerequisites

- **Node.js ≥ 22.6.0** and **Rust** (stable, with `cargo`).
- **Tauri v2 Linux system packages** (Debian/Ubuntu):

  ```bash
  sudo apt-get update
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
    libayatana-appindicator3-dev libsoup-3.0-dev \
    build-essential curl wget file libssl-dev pkg-config
  ```

  (On macOS install Xcode command-line tools; on Windows install the WebView2
  runtime and the MSVC build tools. See the Tauri v2 prerequisites for details.)

The Tauri CLI is invoked through `npx @tauri-apps/cli@^2` by the npm scripts, so
it does not need to be installed globally (it can also be installed via
`cargo install tauri-cli --version "^2"`).

---

## Run it

From the repository root:

```bash
npm run desktop:dev      # installs frontend deps, builds the UI, launches the app (debug)
npm run desktop:build    # installs frontend deps, builds the UI, compiles a release app
```

`desktop:dev` and `desktop:build` shell out to the Tauri CLI via `npx` (build-only
tooling — nothing is added to the root package). The frontend build
(`npm --prefix desktop run build`) runs automatically via the `beforeDevCommand`
/ `beforeBuildCommand` hooks in `src-tauri/tauri.conf.json`.

You can also run just the bridge for debugging:

```bash
npm run desktop:bridge   # reads NDJSON commands on stdin, prints NDJSON events on stdout
```

---

## Demo mode vs. real providers

- **Demo (default):** if no usable provider is configured, the app selects the
  **Demo** profile. It streams canned, mode-aware responses token-by-token and
  even runs the **real** read-only tool loop (e.g. `list_files`) so the whole UX
  — streaming, tool activity, approvals, conversation history — is demonstrable
  with **zero setup**. Demo replies are clearly labelled.
- **Real providers:** open **Settings** to
  1. paste an API key for **Anthropic**, **OpenAI** or **Grok** (held in memory
     by the local engine only — never written to disk), and
  2. add a **model profile** (a name + provider + a model id you choose — no
     model ids are hardcoded, matching toris's config ethos).

  Then pick that profile from the **Model** selector in the top bar. Installed
  **Claude Code** / **Codex** CLI logins are detected automatically as
  `claude-cli` / `codex-cli` profiles.

The engine also reads `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` from
the environment and your `~/.toris/config.json` profiles at startup, exactly like
the CLI.

---

## Autonomy & approvals

The **Autonomy** selector maps to the same L1–L5 ladder as the CLI. Below **L3**,
any mutating tool (`write_file`, `run_command`) pauses for an inline
**Approve / Deny** prompt in the chat before it runs. At L3 and above, mutating
tools auto-approve. This is enforced by the engine, not the UI.

---

## Solo-entrepreneur assistant modes

Each mode is a **real system prompt** that changes the agent's behaviour (defined
in `src/desktop/presets.js`), not just a label:

| Mode | What it does |
| --- | --- |
| **General assistant** | All-round copilot; can use tools. |
| **Email & replies** | Returns ready-to-send drafts with a subject + body. |
| **Plan my week** | Ruthless prioritisation into a day-by-day plan. |
| **Marketing copy** | Landing pages, posts and ads, with options. |
| **Summarize a doc** | TL;DR + key points + action items; can read files. |
| **Help with code** | Reads/edits your project with the tool loop. |
| **Bookkeeping & invoices** | Invoice text, reminders, expense notes (not tax advice). |

Switch modes from the **Mode** selector or the cards on the welcome screen; the
conversation is preserved when you switch.

---

## Data & privacy

Conversations and UI settings are stored **locally** in the webview's
`localStorage`. There is no account, server or telemetry — consistent with
toris's local-first design.
