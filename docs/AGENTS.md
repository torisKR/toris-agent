# Agent profiles — builtins and project-local roles

Toris has one agent catalogue. `toris agents`, TUI `/agent`, `--agent`, Studio `/agent`, and the
planner all read the same list. You do not fork the repo to add a domain specialist.

## Builtins

Eleven task roles plus the `toris` chat persona live in `src/core/agents.js`. The planner can
assign the task roles. `toris` is the session, not a plan step.

## Overlay files

One JSON object per file. Directories are not recursive (`examples/` is ignored).

```
~/.toris/agents/<id>.json          # optional user-global overlay
<repo>/.toris/agents/<id>.json     # project-local (wins on the same id)
```

Precedence matches skills: **builtin < home < project**. A project file with id `implementer`
replaces the built-in Implementer. A new id appears everywhere the catalogue is shown and is
assignable in plans (unless `category` is `core`). Studio `/agent` is the same list: custom
rows are labeled `project` or `home`. Pick one to send that id on `POST /api/agent/turn`.
There is no profile editor in Studio.

There is no network fetch. Absent directories are empty, not errors. Studio skips a broken
file so the picker stays up. `toris agents` still fails with a field error.

## Schema

Required:

| Field | Rule |
| --- | --- |
| `id` | Slug: `^[a-z][a-z-]*$`. Must match the filename (`aso-specialist.json`). |
| `title` | Non-empty, max 80 characters. |
| `category` | `core` \| `plan` \| `build` \| `review` \| `verify` \| `ship` |
| `writes` | JSON boolean. `true` if this role may edit files. |
| `summary` | 11–500 characters. Shown in pickers and used when `system` is omitted. |

Optional:

| Field | Rule |
| --- | --- |
| `system` | Specialist system prompt (max 8000 characters). Replaces the derived role prompt. |

Unknown fields fail. Invalid JSON fails. The error names the file and the field — it does not
crash with a stack trace. `id` `toris` may only use `category: "core"`.

Copy [docs/examples/agents/aso-specialist.json](examples/agents/aso-specialist.json) to
`.toris/agents/aso-specialist.json` to try a specialist locally.

```bash
toris agents
toris --agent aso-specialist
```
