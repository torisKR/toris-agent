# Agent profiles — builtins and project-local roles

Toris has one agent catalogue. `toris agents`, TUI `/agent`, `--agent`, and the
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
assignable in plans (unless `category` is `core`). `toris agents` labels custom rows
`project` or `home`, so you can see which file supplies the role.

There is no network fetch. Absent directories are empty, not errors. `toris agents`
reports an invalid overlay with the file and field that need correction.

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

## Manage and select a role

Copy [aso-specialist.json](examples/agents/aso-specialist.json) to
`.toris/agents/aso-specialist.json` to try a specialist locally. Create or edit
overlays in your editor, then run `toris agents` to check the schema and inspect
the effective catalogue. Keep the filename and `id` in agreement.

Remove an overlay by deleting that JSON file. If it replaced a home or builtin
role, the lower-precedence role becomes available again on the next catalogue
load. Use the `SOURCE` column to choose the file you intend to change.

```bash
toris agents
toris agents --json
toris --agent aso-specialist
```

In an interactive session, `/agent` lists the available roles and
`/agent aso-specialist` selects one for subsequent turns. Start a new session
after changing overlay files so it loads the updated catalogue.
