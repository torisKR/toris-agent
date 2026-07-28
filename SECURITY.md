# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through
[GitHub Security Advisories](https://github.com/torisKR/toris-agent/security/advisories/new).
If you cannot use that, email **ironjustlikethat@gmail.com**.

Please include:

- what the vulnerability allows an attacker to do (impact),
- the steps to reproduce it, ideally with a minimal example,
- the toris, Node.js and provider CLI versions you tested against.

You can expect an acknowledgement within **72 hours** and an assessment shortly after. Reporters are
credited in the release notes and the advisory unless you would rather stay anonymous — just say so.

## Security model

toris is a local orchestrator. Understanding what it actually does is most of the threat model:

- **It executes other programs.** toris spawns your provider CLI (`claude`, `codex`) as a child
  process, and runs your project's own checks (`npm run lint`, `npm test`, `npm run build`) inferred
  from `package.json`. Anything those programs can do, a run can cause to happen.
- **It can operate on your git repository.** Depending on the autonomy level, it may edit the working
  tree, create commits, and push a branch.
- **Autonomy is the gate.** L1 plans only. L2 edits the working tree. L3 commits locally. L4 pushes.
  L5 is fully autonomous. Anything above the level you chose becomes an approval request that waits
  for a human decision; a rejection stops the run with exit code `4`.
- **State is local and plain.** Config, projects, runs and event logs live under `$TORIS_HOME`
  (default `~/.toris`) as JSON and JSONL files, with no encryption. Protect that directory the way
  you protect the rest of your home directory.
- **No telemetry, no phone-home.** toris makes no network requests of its own. Any network traffic
  originates from the provider CLI you invoked.
- **Zero runtime dependencies.** The published package pulls in nothing but Node's standard library,
  which keeps the supply-chain surface as small as it can reasonably be.

## Hardening tips

- Run against a **dedicated worktree, clone or container** rather than your primary checkout.
- Keep autonomy **low for goals you did not write yourself**. Treat a goal string from an untrusted
  source the way you would treat untrusted code.
- **Review approvals** rather than reflexively approving them — that prompt is the last human gate.
- Do not point toris at a repository containing secrets you would not be comfortable exposing to
  your provider CLI, since file contents may be sent to it.
- Inspect `toris receipt <runId>` and `toris logs <runId>` after unattended runs.

## Scope

The following are **not** considered vulnerabilities in toris:

- Bugs or data handling in third-party provider CLIs (`claude`, `codex`) — report those upstream.
- Consequences of a user explicitly granting L4/L5 autonomy, or explicitly approving a request.
- Consequences of running toris against a repository or goal the user chose to trust.

A failure of the autonomy gating itself — for example an action taken above the configured level, or
without a required approval — **is** in scope, and is the kind of report we most want to receive.
