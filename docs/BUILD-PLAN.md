# toris-agent — parallel build plan (resume here)

Status: scaffolding + frozen contract committed. Package implementation not started.

## Why this file exists
`docs/CONTRACT.md` freezes every cross-package signature, and `docs/specs/*.md` splits it
per package. That means all 10 packages can be implemented **in parallel** with no shared
files — each agent owns exactly one directory (the plan's `pathOwnership: strict` rule).

## Agent assignment (one package per agent, disjoint paths)

| # | Package | Owns | Depends on (contract only) |
|---|---------|------|----------------------------|
| 1 | `@toris/schemas`   | `packages/schemas/**`   | — |
| 2 | `@toris/protocol`  | `packages/protocol/**`  | schemas |
| 3 | `@toris/storage`   | `packages/storage/**`   | schemas |
| 4 | `@toris/workspace` | `packages/workspace/**` | schemas |
| 5 | `@toris/verifier`  | `packages/verifier/**`  | schemas |
| 6 | `@toris/providers` | `packages/providers/**` | schemas |
| 7 | `@toris/agents`    | `packages/agents/**`    | schemas |
| 8 | `@toris/core`      | `packages/core/**`      | all above |
| 9 | `@toris/supervisor`| `packages/supervisor/**`| schemas, protocol, storage, core |
| 10| `toris-agent` CLI  | `apps/cli/**`           | all |
| 11| OSS packaging      | `.github/**`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` | — |

Waves 1–7 and 11 are fully independent. 8 → 9 → 10 can also be written in parallel
because the contract is frozen; only the final integration pass needs ordering.

## Standard agent prompt

> Implement ONE package of the `toris-agent` monorepo at `/Users/toris/projects/toris-agent`.
> Read `docs/specs/_base.md` then `docs/specs/<pkg>.md`. Implement those signatures EXACTLY.
> You own ONLY `packages/<pkg>/**`. Create `package.json` + `tsconfig.json` using the exact
> shapes in `_base.md`, `src/*.ts` split into files <400 lines, and colocated vitest
> `*.test.ts` (AAA pattern).
> ESM: every relative import ends in `.js`. Never mutate inputs.
> Do NOT run pnpm/npm install or build — the integrator installs once at the end.
> Reply TERSELY: file list, exported symbols, decisions.

## Integration pass (after agents finish)
1. `pnpm install`
2. `pnpm build` — fix cross-package type drift against `docs/CONTRACT.md` (contract wins)
3. `pnpm test`
4. `node apps/cli/dist/index.js doctor --json`
5. smoke: `toris init` → `toris project add .` → `toris run "..." --dry-run --json`

## Known constraint
Subagents inherit the parent session's context. Launch these agents from a **fresh or
compacted session**, otherwise they fail with `Prompt is too long` before doing any work.
