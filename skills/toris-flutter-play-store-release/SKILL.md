---
name: toris-flutter-play-store-release
description: Inspect, configure, validate, repair, build, and safely operate Flutter Android delivery through Fastlane and GitHub Actions for Google Play, Firebase App Distribution, and Slack.
---

# Toris Flutter Play Store Release

Operate the Android release path of a Flutter project. Treat this skill as Android only; exclude iOS and App Store work. Write runtime documentation and configuration in English, then report results in the user's language.

## Quick start

1. Invoke `/toris-flutter-play-store-release` in Claude Code or `$toris-flutter-play-store-release` in Codex.
2. Identify the Flutter project root and the user's requested outcome.
3. Inspect before editing. Run `scripts/inspect_flutter_project.sh --project PATH --format human` from this skill's installed directory.
4. Classify the request into one mode and apply the narrowest authorized workflow.
5. Validate locally and report what changed, what passed, what remains unverified, and what only the user can do.

## Triggers

Use this skill for requests equivalent to:

- Set up Android release automation.
- Check whether this Flutter app is ready for Google Play.
- Build an Android App Bundle without uploading it.
- Deploy this build to the named Google Play track.
- Configure the Android release workflow in GitHub Actions.
- Distribute this Android build with Firebase App Distribution.
- Add Slack release notifications.
- Repair the existing Android release setup.

Do not use this skill for iOS delivery, general Flutter feature work, Play listing copy, or unrequested console administration.

## Classification

Select exactly one primary mode. Treat supporting checks as part of that mode.

| Mode | Use it for | External delivery |
| --- | --- | --- |
| `setup` | Install or merge Fastlane, signing hooks, workflow, tools, and project guidance. | None. |
| `doctor` | Read and validate the existing release setup. | None. |
| `build` | Produce and verify a local signed AAB without upload. | None. |
| `deploy` | Upload one verified AAB to the explicitly named Play track, or explicitly request both destinations with a separate dual-delivery confirmation. | Google Play; Firebase too only for an authorized `both` request. |
| `ci` | Configure or repair the generated GitHub Actions workflow. | None during configuration. |
| `firebase-distribution` | Configure Firebase delivery or, when explicitly requested, distribute to named testers or groups. | Firebase only. |
| `slack` | Configure notifications or test a webhook when explicitly requested. | Slack only. |
| `repair` | Reconcile owned files while preserving user-owned configuration. | None unless separately requested. |

A `setup`, `doctor`, `build`, `ci`, `firebase-distribution`, `slack`, or `repair` request never authorizes a Play upload. Do not upload from those modes.

## Inspect

Inspect before editing.

```bash
SKILL_ROOT=/path/to/installed/toris-flutter-play-store-release
"$SKILL_ROOT/scripts/inspect_flutter_project.sh" --project PATH --format human
"$SKILL_ROOT/scripts/bootstrap_android_fastlane.sh" --project PATH --dry-run
```

Confirm the project contains `pubspec.yaml`, `android/`, and `android/app/`. Review the Gradle DSL, application ID, namespace, version sources, signing state, flavors, entrypoints, Firebase mapping, Fastlane files, workflow, Git state, and every proposed path. Never infer a release flavor or package name when inspection cannot resolve it.

Classify each proposed target as create, update-owned, merge, preserve, skip-conflict, or fail-conflict. Preserve unrelated changes. Stop on an ambiguous user-owned signing or release configuration and explain the conflict.

Read [execution defaults](references/execution-defaults.md) before acting. The canonical repository also maintains a repository-wide execution-defaults policy; mention it when working from the source checkout, but do not create an installed link back into that repository.

## Authorization gate

Proceed without another prompt for read-only inspection, an authorized local setup or repair, and local validation that stays within the supplied project.

Require an explicit request before any of these actions:

- Upload to Google Play, Firebase, or another external service.
- Promote a release, change a rollout, or target `production`.
- Create or change GitHub secrets, repository variables, Environment rules, accounts, permissions, billing, or legal declarations.
- Create, replace, reset, export, or delete an upload key, app-signing key, service-account key, or webhook.
- Create the first Play Console release or change console-only app content.
- Send a Slack message.

Interpret an explicit internal deploy as authorization for only the named internal track after preflight passes. Do not extend it to another track, promotion, staged rollout, Firebase, Slack, or production. Require `CONFIRM_PRODUCTION_DEPLOY=true` in addition to a separately explicit production request.

Never derive Firebase or `both` delivery from ambient environment values. The Play and Firebase lanes pin their own destination. `both` requires the exact lane option `distribution_target:both` plus `CONFIRM_DUAL_DELIVERY=true`. Ordinary Play deploys pin `completed` and no rollout; `draft` or `inProgress` must be exact lane options and require `CONFIRM_PLAY_RELEASE_POLICY=true`. A Slack send independently requires `CONFIRM_SLACK_NOTIFICATION=true`.

Treat every `CONFIRM_*` authority gate as an exact token: only the lowercase string `true` authorizes the action. Reject aliases such as `1`, `yes`, `on`, uppercase variants, surrounding whitespace, and native booleans passed directly to the Fastlane helper. Truthy parsing is reserved for ordinary preferences and execution flags.

Never create a populated `.env`, `android/key.properties`, keystore, service-account JSON, or GitHub secret unless the user explicitly requests that exact mutation. Inspect credential presence without printing values. Never enable shell tracing while secrets may be present.

## Execute

### Setup or repair

Preview the complete plan, then apply it only when conflicts are resolved.

```bash
"$SKILL_ROOT/scripts/bootstrap_android_fastlane.sh" --project PATH --dry-run
"$SKILL_ROOT/scripts/bootstrap_android_fastlane.sh" --project PATH --conflict fail
```

Use `--flavor NAME` only after the release flavor is confirmed. Use `--conflict skip` only when the user accepts an incomplete nonzero result. Review the generated paths:

- `android/Gemfile` and `android/Gemfile.lock`
- `android/fastlane/Appfile`, `Fastfile`, `Pluginfile`, `.env.example`, and `lib/flutter_play_store_release.rb`
- `android/key.properties.example`
- `.github/workflows/release-android.yml`
- `docs/PLAY_STORE_RELEASE.md`
- `tool/flutter-play-store-release/decode_secret.sh`, `install_flutter_sdk.sh`, and `managed-files.sha256`

Keep `tool/flutter-play-store-release`, its sidecar package ID, and generated ownership markers unchanged. They are a stable project-internal compatibility namespace retained across the public skill rename to `toris-flutter-play-store-release`.

### Doctor

Run read-only validation by default.

```bash
"$SKILL_ROOT/scripts/validate_release_setup.sh" --project PATH --context doctor --format human
```

Do not add `--run-project-commands` to doctor. Treat `PASS`, `WARN`, and `FAIL` literally. Report absent credentials as readiness findings, not as permission to create them.

### Build

Obtain authorization before running project commands that may write caches or build output.

```bash
"$SKILL_ROOT/scripts/validate_release_setup.sh" --project PATH --context build --run-project-commands
cd PATH/android
bundle install
bundle exec fastlane android doctor
bundle exec fastlane android build
```

Verify exactly one fresh, nonempty artifact and its version, flavor, package, signing, and target. Do not upload.

### Deploy

Confirm the named track and target, then run deploy-context validation before network access.

```bash
"$SKILL_ROOT/scripts/validate_release_setup.sh" --project PATH --context deploy
cd PATH/android
bundle install
bundle exec fastlane android doctor
PLAY_STORE_TRACK=internal bundle exec fastlane android release_play_store
```

Replace `internal` only with the track the user explicitly named. Stop before network access on failed package, signing, credential, track, artifact, or version checks. Never claim deployment from a successful build alone.

Do not retry an unknown upload outcome implicitly. A fresh run marked with `RETRY_UNKNOWN_UPLOAD=true` must include the exact prior version name/code, artifact SHA-256, destination, and provider state `not-delivered`, plus `CONFIRM_UPLOAD_RECONCILED=true`, before any adapter is called. The allocated build code must equal the reconciled code, and the SHA-256 of the newly built artifact must equal the reconciled SHA-256 before upload. Fail closed when either differs; recovering the exact prior artifact or starting a new explicitly authorized release is an operator decision. An unmarked fresh dispatch cannot be inferred as a retry, and a GitHub workflow rerun with `github.run_attempt > 1` is always rejected. Retry/reconciliation runs never send automatic Slack notifications; after final provider state is known, a separately authorized manual message is required.

### CI, Firebase, and Slack

For `ci`, configure the generated workflow and document the fixed GitHub Environments `play-store-nonproduction` and `play-store-production`. GitHub `release.published` delivery is disabled by default and becomes a standing authorization only when the user explicitly sets `ENABLE_GITHUB_RELEASE_DEPLOY=true`; that event remains fixed to Play/internal/completed. A marked manual retry uses exactly seven inputs: `retry_unknown_upload`, `confirm_upload_reconciled`, `reconciled_version_name`, `reconciled_version_code`, `reconciled_artifact_sha256`, `reconciled_destinations`, and `reconciled_provider_state`. Leave reviewer and tag protection as an external, unverified repository setting.

For `firebase-distribution`, keep Firebase credentials separate from Play credentials. Require a matching Firebase application and, for AAB delivery, a reviewed Play link plus `CONFIRM_FIREBASE_AAB_PLAY_LINKED=true`. An AAB link confirmation does not authorize a Play release.

For `slack`, keep `SLACK_NOTIFICATION_OWNER` single-owner and require `CONFIRM_SLACK_NOTIFICATION=true` for the current run, or the separately documented release-event standing authorization. Workflow reruns suppress notification and require a fresh authorized dispatch. Make notification failures warnings that never replace the build or delivery result. Do not test a webhook without explicit authorization to send a message.

Use [environment variables](references/environment-variables.md), [first release checklist](references/first-release-checklist.md), and [troubleshooting](references/troubleshooting.md) for detailed operator decisions.

## Validate

Run the narrowest relevant checks, then expand only as needed.

```bash
bash -n "$SKILL_ROOT/scripts/inspect_flutter_project.sh"
bash -n "$SKILL_ROOT/scripts/bootstrap_android_fastlane.sh"
bash -n "$SKILL_ROOT/scripts/validate_release_setup.sh"
"$SKILL_ROOT/scripts/validate_release_setup.sh" --project PATH --context doctor
```

When setup or build execution is authorized, add `--context setup|build --run-project-commands`. When credentials or platform access are absent, record those checks as not verified. Do not convert an unrun check into a pass.

## Completion report

Return these exact ten English headings, in this order:

1. **Global skill installation result**
2. **Created skill files**
3. **Current Flutter project changes**
4. **Detected project information**
5. **Values the user must prepare**
6. **Local validation commands**
7. **GitHub Secrets**
8. **Deployment commands**
9. **Validation results**
10. **Cautions**

Within file-change sections, use the exact subgroups **Created**, **Modified**, **Preserved**, and **Backup** even when a subgroup is empty. In **Validation results**, label every check as **PASS**, **WARN**, **FAIL**, or **not run**; never convert an unrun or externally unverifiable check into PASS.

Never report a Play, Firebase, or Slack action as successful unless its adapter returned success and the final result preserved that outcome.

## Definition of done

- Keep work inside the selected Android release mode and authorization boundary.
- Preserve user-owned configuration and unrelated changes.
- Leave no plaintext credential, generated secret file, stale artifact, or temporary signing material behind.
- Validate owned files, application identity, signing, versions, artifacts, and selected integrations to the extent available.
- Report every external action, skipped check, warning, failure, and remaining user step accurately.
