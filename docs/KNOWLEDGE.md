# Knowledge — local secretary memory

Toris can compound as a secretary: you **build** domain expertise on disk, organize it as a **DAG**, and promote **tacit knowledge** (암묵지) after work that actually landed. Nothing here is a hosted memory provider. Files live under `~/.toris/knowledge/` (and optionally `<project>/.toris/knowledge/`), are git-friendly, and are edited as markdown.

## Why this exists

Solo builders need the agent to remember *how this person ships*, not only what the last prompt said. Two public systems inspired the shape, without copying branding or code:

| Need | How others talk about it | How Toris does it |
| --- | --- | --- |
| Human-editable memory | Markdown memory files | `USER.md`, `MEMORY.md`, `domains/<slug>/*.md` |
| Bounded profile | A short USER + MEMORY pair | Character bounds; overflow compresses head+tail |
| Session continuity | Summaries / recall | Keyword + tag search, optional `index.json` |
| Skills after success | Write a procedure when work worked | `toris knowledge reflect` / chat `/reflect` — **opt-in write** |
| Domain packs | Bundled expertise | Starter domains you extend, pointing at builtin `skills/` |

Toris stays local-first and zero-runtime-deps. There is no cloud memory, no telemetry, and no silent write of facts the model found convenient.

## Layout

```
~/.toris/knowledge/
  USER.md                 curated facts about the human (8 KB bound)
  MEMORY.md               durable environment / work facts (12 KB bound)
  index.json              optional keyword index (rebuilt on write)
  inbox/*.md              unpromoted tacit captures
  domains/<slug>/
    DOMAIN.md             what this is, when to use it, anti-jobs, related skills
    dag.json              directed edges between node ids
    nodes/*.md            knowledge nodes (title, tags, body)
    tacit/*.md            promoted “how we actually do X here”
```

Project overlay: `<repo>/.toris/knowledge/` with the same shape. Search merges both; writes default to the home store unless you pass `--project`.

`toris init` and `toris knowledge init` seed the home store. Init is idempotent: existing USER.md / domains are left alone.

## Starter domains

These ship in the package and copy into `~/.toris/knowledge/domains/` on first init:

1. **product-growth** — SEO/GEO, store listing, shipping loops (`seo-geo-optimizer`, `app-store-listing-creator`, `ship-small`)
2. **flutter-android** — Flutter performance, Play release, device evidence
3. **expo-android** — Expo Android performance and motion, then Android verify
4. **toris-ops** — autonomy, receipts, Design Mode, android verify
5. **solo-revenue** — 1인 개발 수익화 루프: build → evidence → ship → list

Each pack has a real `DOMAIN.md`, at least three nodes, a small `dag.json`, and one tacit note. Extend them; do not treat them as frozen product copy.

## DAG

`dag.json`:

```json
{
  "edges": [
    { "from": "seo-geo-loop", "to": "shipping-loop", "kind": "supports" }
  ]
}
```

Kinds: `prerequisite`, `supports`, `conflicts`, `derived-from`.

Ordering kinds (`prerequisite`, `supports`, `derived-from`) must stay a DAG. Toris refuses a link that would cycle. `conflicts` may go both ways so A↔B disagreements stay legal.

## CLI

```bash
toris knowledge init
toris knowledge status
toris knowledge domains list
toris knowledge domains add my-app --title "My app"
toris knowledge domains inspect flutter-android
toris knowledge node add toris-ops --title "Session continuity" --body "Summaries in MEMORY.md."
toris knowledge node link toris-ops receipts-not-vibes session-continuity --kind supports
toris knowledge tacit add toris-ops --title "We cite the receipt path"
toris knowledge tacit promote <id> --domain toris-ops
toris knowledge search "flutter play"
toris knowledge reflect --text "We always measure on a mid-range phone." --domain flutter-android
toris knowledge reflect --text "..." --write
toris knowledge reflect run_abc123
toris knowledge reflect --from-run run_abc123 --json
toris knowledge memory get
toris knowledge user append --text "- Timezone: KST"
```

`toris memory` is an alias for `toris knowledge`. `toris doctor` reports a **WARN** until the store exists, then **PASS** with the domain count. It never fails the doctor run.

`toris brief` optionally lists 3–5 high-signal tacit or node headlines (keyword tokens from today's run goals, otherwise the latest tacit). If the store is not initialized, that section is omitted — it does not run `knowledge init` for you. See [BRIEF.md](./BRIEF.md).

## Chat tools

API-backed chat (`anthropic`, `openai`, `grok`) gets:

| Tool | Gate |
| --- | --- |
| `knowledge_search` | read |
| `memory_get` | read |
| `domain_activate` | session pin, no disk write |
| `knowledge_reflect` | propose only |
| `knowledge_write` | `needsApproval` — asks below L3, auto at L3+ |

On each `toris chat` turn (and Studio agent turns on the same session path), Toris **auto-retrieves** matching domain nodes and tacit notes from `~/.toris/knowledge/` and injects a bounded `[knowledge context]` block. The operator does not need to call `knowledge_search` first.

Retrieval is keyword + tag over the existing `index.json` (no remote embeddings). It prefers domain nodes + tacit, clips each body, and drops the lowest-score items once the char budget is hit. USER.md / MEMORY.md stay in the system prompt when already loaded; they are not dumped again on every turn. Below L3 this path is **read-only** — it never writes tacit, USER.md, or MEMORY.md.

Disable:

```bash
toris chat --no-knowledge "…"
```

or in `~/.toris/config.json`:

```json
{ "knowledge": { "autoRetrieve": false } }
```

`--json` includes a `knowledge` receipt (`retrieved`, `domains`, `chars`). `--verbose` prints a single dim `knowledge  domain/id · …` line. Default chat stays quiet.

CLI-backed `claude` / `codex` keep their own agent loop and tools; the same bounded block is still prepended to the user message so those CLIs see the local DAG. Use `toris knowledge` to maintain the files.

Slash commands:

- `/knowledge [query]` — status or search
- `/reflect` — propose tacit notes from this session, or the latest verified run
- `/reflect <runId>` — propose from that run's receipt (verification must have passed)
- `/reflect accept` — write the proposals (inbox if no domain)

Do not expect silent MEMORY.md updates. That is the point.

## Tacit promotion

1. Do the work. Verify it. The receipt of a passing run carries a quiet `toris knowledge reflect <runId>` line — it does not write anything.
2. `/reflect`, `toris knowledge reflect <runId>`, or `toris knowledge reflect --text "..."`.
3. Edit the proposal if the wording is too specific. `--json` returns the draft without writing.
4. `--write` / `accept` to inbox, then `tacit promote` into a domain. Below L3, chat `knowledge_write` still asks first.

A receipt-backed draft includes the goal, plan titles, check exit codes, and a short outcome note. Failed or unverified runs do not propose a success tacit. Domain is guessed from keywords/tags on an existing pack when you omit `--domain`.

A tacit note is “how we actually do X **here**”. A skill under `skills/` is a reusable procedure. A domain may list related builtin skills in `DOMAIN.md` frontmatter (`skills: seo-geo-optimizer, ship-small`).

## Studio

Optional GUI: `http://127.0.0.1:5824/knowledge`. Browse domains, nodes, and DAG edges; add a node or edge. It is a **separate page** (`knowledge.html` + `knowledge.js`) so it does not share the review-room client with Design Mode or the agent room.

The same page can show the latest **verified-run** proposal (goal, short outcome, domain guess) — the Studio equivalent of `toris knowledge reflect` / `/reflect`. **Accept** writes that one tacit note through `KnowledgeStore.addTacit` (same path as `--write` / `/reflect accept`). **Dismiss** does not write. Failed or unverified receipts stay hidden. Nothing is written until you click Accept.

## Grow a domain

1. `toris knowledge domains add checkout --title "Checkout"`
2. Add nodes for the jobs you keep re-explaining
3. Link prerequisites (`measure` → `change` → `verify`)
4. After a win, promote one tacit note
5. Point `skills:` at a builtin SKILL.md when the procedure already exists

Keep USER.md short. If a fact is about *you*, it is USER.md. If it is about *this machine / this product*, it is MEMORY.md. If it is a procedure, it is a node or a tacit note, not another paragraph in MEMORY.md.
