# Contributing to toris-agent

Thanks for being here. toris is a small, dependency-free project, which means the barrier to
contributing is low: clone it, run the tests, change something, run them again.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — use the [bug report form](https://github.com/toriskr/toris-agent/issues/new?template=bug_report.yml). A run receipt (`toris receipt <runId> --md`) is worth a thousand words.
- **Propose a feature** — use the [feature request form](https://github.com/toriskr/toris-agent/issues/new?template=feature_request.yml). Describe the problem before the solution.
- **Improve the docs** — if something in the README was wrong or confusing, that is a bug.
- **Send a pull request** — see the workflow below.

## Getting started

```bash
git clone https://github.com/toriskr/toris-agent.git
cd toris-agent

node --version   # must be >= 22.6.0
npm test         # there is no install step — toris has zero dependencies
```

Run the CLI straight from source:

```bash
node bin/toris.js doctor
node bin/toris.js run "add a health endpoint" --dry-run
```

To test the globally-installed experience without publishing:

```bash
npm link
toris --version
```

## Project layout

```
bin/toris.js         # executable entry point
src/
├── cli/             # arg parsing, help text, output formatting
│   └── commands/    # one module per command group
└── core/
    ├── planner.js       goal → tasks
    ├── orchestrator.js  parallel execution, retries, provider fallback
    ├── providers.js     claude / codex adapters
    ├── verifier.js      runs project checks, collects exit codes
    ├── receipt.js       JSON + Markdown evidence
    ├── autonomy.js      L1..L5 gating
    ├── agents.js        the built-in agent profiles
    ├── store.js         local JSON persistence under $TORIS_HOME
    ├── config.js        defaults, deep merge, paths
    ├── git.js           git helpers
    ├── ids.js           run/task/approval id generation
    └── errors.js        typed errors → exit codes
test/                # node:test, one file per core module
docs/
├── CONTRACT.md      # frozen v0.1.0 interface contract
└── specs/           # per-module specifications
```

## Development workflow

1. **Branch.** `fix/short-description`, `feat/short-description`, `docs/short-description`.
2. **Write a failing test first.** Put it in `test/<module>.test.js`. Run it and watch it fail —
   that is how you know it tests something.
3. **Implement** the smallest change that makes it pass.
4. **Verify.**
   ```bash
   npm run lint
   npm test
   npx prettier --write .   # prettier is used via npx; it is not a dependency
   ```
5. **Commit** with a Conventional Commit message, then open a pull request.

## Testing

Tests use the built-in [`node:test`](https://nodejs.org/api/test.html) runner — no framework, no
config, no mocks library.

```bash
npm test                            # everything
node --test test/planner.test.js    # one suite
node --test --test-name-pattern="fallback" test/   # one behaviour
```

Guidelines:

- One test file per core module, named after it.
- Arrange–Act–Assert, with a test name that states the behaviour:
  `test('falls back to the other provider when the first one fails', ...)`.
- Prefer real temp directories (`mktemp`-style via `node:fs`) over mocking the filesystem;
  point `TORIS_HOME` at a throwaway dir.
- No network calls in tests, ever. Provider adapters are injected, so pass a fake.

## Code style

- **ESM only.** `import`/`export`, no CommonJS.
- **No new runtime dependencies.** If you think you need one, open an issue first and explain why
  the standard library is insufficient. This is a hard rule, not a preference.
- **Immutability.** Never mutate an input — return a new object. `Object.freeze` the constants.
- **Small files.** Roughly 200–400 lines; split when a module grows a second responsibility.
- **Explicit errors.** Throw the typed errors from `src/core/errors.js` so the CLI can map them to
  the documented exit codes. Never swallow an error silently.
- **JSDoc on every exported function**, one line is enough if the signature is obvious.
- **Named exports** for multi-export modules; default exports only where there is genuinely one thing.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(planner): allow tasks to declare explicit dependencies
fix(verifier): stop treating a missing script as a failed check
docs(readme): document the --budget flag
test(orchestrator): cover the provider fallback path
chore(ci): run the matrix on node 24
```

Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`.

## Pull requests

The [PR template](./.github/PULL_REQUEST_TEMPLATE.md) covers the checklist, but in short:

- Explain the problem, not just the diff.
- Include tests for the behaviour you changed.
- Keep it focused — one concern per PR.
- CI must be green: lint, tests on Node 22 and 24, and a global-install smoke test.

## The frozen contract

`docs/CONTRACT.md` records the exported signatures of the v0.1.0 interface. It is **frozen**:
changing an exported function's name, parameters or return shape breaks anyone building on toris.

If your change needs a contract change, say so explicitly in the issue *before* writing the code,
and expect the discussion to be about versioning rather than style. Additive changes (a new optional
field, a new exported function) are much easier to land than breaking ones.

## Adding a new agent profile

Profiles live in `src/core/agents.js`. Each one declares an `id`, a `category`
(`plan` | `build` | `review` | `verify` | `ship`), whether it `writes`, a one-line `summary`, and
the prompt scaffolding it contributes. Add the profile, then add a test asserting it appears in the
catalog with the right `writes` flag — the flag is a safety boundary, not documentation.

## Adding a new provider

Adapters live in `src/core/providers.js`. A provider is an object with a stable shape: how to detect
its binary, how to build an invocation, and how to interpret the result. Requirements:

- Detection must respect an override environment variable, matching `TORIS_CLAUDE_BIN` /
  `TORIS_CODEX_BIN`.
- Timeouts and non-zero exits must surface as typed errors so the orchestrator can retry and fall back.
- Add tests using a fake child process; never shell out to a real CLI in the test suite.
- Update the README's requirements section and `toris doctor` output expectations.

## Reporting bugs

Use the [issue templates](https://github.com/toriskr/toris-agent/issues/new/choose). For security
problems, **do not open a public issue** — follow [SECURITY.md](./SECURITY.md).

## License

toris-agent is [Apache-2.0](./LICENSE). By contributing, you agree that your contributions are
licensed under the same terms.
