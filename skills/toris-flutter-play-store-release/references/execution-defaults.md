# Execution defaults

Use this installed policy to decide how far to proceed after the skill is invoked. The user's explicit mode and scope always win.

## Select the operating mode

- **Execute:** For setup, build, repair, or configuration work, inspect first, make the smallest coherent in-scope changes, validate them, and hand off the result.
- **Review:** For an audit, explanation, or diagnosis-only request, inspect and report without changing files or external systems.
- **Plan:** For an explicit planning request, inspect enough context to make the plan executable, then stop before implementation.

Choose one release mode separately: `setup`, `doctor`, `build`, `deploy`, `ci`, `firebase-distribution`, `slack`, or `repair`. Do not treat local execute mode as deployment authority.

## Proceed with reversible local work

Proceed when the action is a normal, reversible part of the requested outcome:

- Read in-scope project files, configuration, logs, and supplied evidence.
- Edit in-scope release files after inspecting and previewing conflicts.
- Run existing local syntax checks, tests, builds, and validators that the user requested or that do not cross a stated boundary.
- Iterate on failures caused by the change.

Preserve unrelated changes. State safe assumptions and continue. Ask one focused question only when a missing choice would materially change the result or make proceeding unsafe.

## Explain broader local impact

Explain the impact and obtain direction before a materially broader local action, including dependency replacement, native-project ownership changes, a large migration, a long-running build, or generation of a new signing identity.

## Require explicit authorization

Do not perform these actions unless the user explicitly authorizes the exact target:

- Deploy, release, publish, promote, change a rollout, or upload to a store or distribution service.
- Change live Play Console, Firebase, GitHub, Slack, DNS, billing, account, permission, or legal state.
- Create, replace, reset, export, delete, or disclose a credential or signing key.
- Add or change GitHub secrets, variables, Environment protection, or a webhook.
- Send an external message or test notification.
- Perform a destructive or difficult-to-reverse operation.

Creating a local submission-ready AAB does not authorize uploading it. A named internal-track deployment does not authorize another track or production. Firebase delivery does not authorize Play delivery. Slack configuration does not authorize sending a message.

Ambient environment values never expand a delivery target, status, rollout, or Slack authority. Dual delivery, non-default Play policy, and Slack each require their own exact confirmation. A GitHub Release event authorizes fixed Play/internal/completed delivery only after the user explicitly opts into that standing contract during CI setup.

## Handle secrets

- Inspect presence and metadata without printing values.
- Prefer explicit private file paths locally and secret-store material in CI.
- Decode only into a private temporary directory, clean owned temporary files, and never overwrite a user-owned credential file.
- Keep shell tracing disabled and redact credential-bearing failures.
- Treat Base64 as transport encoding, not encryption.

## Handle uncertainty and failures

- Prefer current official sources for changing platform requirements.
- Diagnose failures within scope and stop before unsafe retries.
- After an unknown upload outcome, reconcile the exact prior version/code, artifact SHA-256, and destination at the provider. Use only a fresh explicitly marked run after provider state is proven `not-delivered`; workflow reruns are rejected and unmarked retries cannot be inferred. Require the allocated code and newly built artifact hash to equal the reconciled tuple before upload. Retry runs never auto-notify Slack.
- Mark checks blocked by missing access, credentials, hardware, or console state as not verified.
- Do not claim success from intent, code inspection, a build-only result, or a favorable single check.
- Preserve the primary build or deployment result when optional Slack notification fails.

## Hand off

Return a concise report with:

- **Changed:** Files or configuration created, merged, modified, or preserved.
- **Verified:** Commands and observed checks that passed.
- **Not verified:** Missing platform access, credentials, or inconclusive evidence.
- **Your action:** Only remaining steps that require the user.
