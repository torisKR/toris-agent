# Toris Flutter Play Store Release

## Purpose

Use this standalone skill package to inspect, configure, validate, repair, build, and operate Flutter Android delivery through Fastlane and GitHub Actions. It supports Google Play, optional Firebase App Distribution, and optional Slack notifications. Android only means that iOS and App Store delivery are out of scope.

The package favors local inspection and deterministic generated files. It does not grant an agent permission to deploy, mutate secrets, change console state, or send notifications.

## Compatibility

- Use Claude Code with `/toris-flutter-play-store-release`.
- Use Codex with `$toris-flutter-play-store-release`.
- Run the bundled Bash scripts on macOS or Linux.
- Run the generated GitHub Actions workflow on Linux.
- Use Windows PowerShell only for the documented secret-encoding command; the automation scripts do not support native Windows shells.
- Use a Flutter project containing `pubspec.yaml`, `android/`, and `android/app/`.
- Use Ruby and Bundler for Fastlane commands. The generated workflow pins its own Java, Ruby, Bundler, and exact Flutter SDK inputs.

## Install, update, and uninstall

Run lifecycle commands from a trusted canonical package checkout. Installation copies verified runtime files into both supported global skill directories; it does not use symlinks.

```bash
./install.sh --dry-run
./install.sh
./install.sh --source /path/to/toris-flutter-play-store-release
./update.sh --source /path/to/toris-flutter-play-store-release --dry-run
./update.sh --source /path/to/toris-flutter-play-store-release
./uninstall.sh --dry-run
./uninstall.sh --yes
```

`install.sh` defaults to its physical package directory. `update.sh` requires an explicit canonical source. `uninstall.sh` requires `--yes` before mutation. Each command validates package identity, the allowlisted manifest, receipts, both destinations, and the shared lifecycle lock before changing an installed copy.

## Rename migration

If `flutter-play-store-release` is already installed, install and verify `toris-flutter-play-store-release` before removing anything. Confirm the new installer dry-run reports `would no change`, then invoke the verified legacy package's own uninstaller from whichever old global copy exists:

```bash
LEGACY_SKILL="$HOME/.agents/skills/flutter-play-store-release"
if [ ! -x "$LEGACY_SKILL/uninstall.sh" ]; then
  LEGACY_SKILL="$HOME/.claude/skills/flutter-play-store-release"
fi
"$LEGACY_SKILL/uninstall.sh" --dry-run
"$LEGACY_SKILL/uninstall.sh" --yes
```

Do not delete the legacy directories manually. Its uninstaller validates both receipts and removes only the two verified old-name copies. Start a new agent task after migration so skill discovery refreshes.

## Direct scripts

Set `SKILL_ROOT` to this package or an installed copy.

```bash
SKILL_ROOT=/path/to/toris-flutter-play-store-release

"$SKILL_ROOT/scripts/inspect_flutter_project.sh" \
  --project /path/to/app --format human

"$SKILL_ROOT/scripts/bootstrap_android_fastlane.sh" \
  --project /path/to/app --dry-run

"$SKILL_ROOT/scripts/bootstrap_android_fastlane.sh" \
  --project /path/to/app --conflict fail

"$SKILL_ROOT/scripts/validate_release_setup.sh" \
  --project /path/to/app --context doctor --format human
```

Supported signatures are:

```text
inspect_flutter_project.sh --project PATH [--format human|json] [--flavor NAME]
bootstrap_android_fastlane.sh --project PATH [--flavor NAME] [--dry-run] [--conflict fail|skip]
validate_release_setup.sh [--project PATH] [--context doctor|setup|build|deploy] [--format human|json] [--run-project-commands]
encode_secret.sh [--input FILE|-] [--output FILE|-]
decode_secret.sh [--input FILE|-] [--output FILE|-]
install_flutter_sdk.sh --version VERSION --channel stable|beta --architecture x64|arm64 --destination PATH
```

Doctor is read-only and rejects `--run-project-commands`. Setup or build validation may run project-mutating commands only when that flag is explicitly supplied. Deploy validation performs preflight checks but does not itself upload.

Use the standard local Fastlane sequence after bootstrap:

```bash
cd /path/to/app/android
bundle install
bundle exec fastlane android doctor
bundle exec fastlane android build
PLAY_STORE_TRACK=internal bundle exec fastlane android release_play_store
```

The last command uploads. Run it only after the user explicitly names that track and deploy-context preflight passes.

## Example prompts

- `Set up Android release automation in this Flutter project, but do not upload.`
- `Run a read-only Play release doctor and explain every warning.`
- `Build and verify a signed Android App Bundle without uploading.`
- `Deploy the verified bundle to the internal track after preflight.`
- `Configure GitHub Actions and list the secrets I must enter myself.`
- `Configure Firebase App Distribution for an APK without changing Play delivery.`
- `Add Slack failure notifications, but do not send a test message.`
- `Repair only files owned by this release setup and preserve custom Fastlane lanes.`

## Modes

| Mode | Result | Play upload? |
| --- | --- | --- |
| `setup` | Preview and merge generated release configuration. | No. |
| `doctor` | Report setup readiness without project mutation. | No. |
| `build` | Create and verify a local AAB. | No. |
| `deploy` | Upload to one explicitly named Play track after preflight. | Yes, only when requested. |
| `ci` | Configure or repair GitHub Actions. | No. |
| `firebase-distribution` | Configure Firebase or distribute only when requested. | No Play upload. |
| `slack` | Configure Slack or send only when requested. | No. |
| `repair` | Reconcile owned files and surface conflicts. | No. |

## Safety

- Inspect before editing and preview bootstrap changes with `--dry-run`.
- Preserve user-owned files and stop on ambiguous signing or release configuration.
- Keep Play, Firebase, and signing credentials separate. Use least privilege and target-app permissions for service accounts.
- Require explicit authorization for Play or Firebase uploads, Slack messages, production, promotion, rollout changes, key operations, console changes, and secret mutation.
- Pin Play-only and Firebase-only lanes to their destination. Require exact `distribution_target:both` plus `CONFIRM_DUAL_DELIVERY=true` for dual delivery; ambient environment values never expand a release.
- Pin ordinary Play delivery to `completed` with no rollout. Require exact lane options and `CONFIRM_PLAY_RELEASE_POLICY=true` for `draft`, `inProgress`, or rollout.
- Accept only the exact lowercase string `true` at every `CONFIRM_*` runtime authority gate. Values such as `1`, `yes`, `on`, `TRUE`, or whitespace-padded text do not authorize an action.
- Never print secret values, use shell tracing around secrets, or commit `.env`, `key.properties`, keystores, or service-account JSON.
- Treat a successful build as a build, not as deployment evidence.
- Treat Slack notification failure as a warning. Slack failure must not mask a build or deployment failure, and it must not turn a successful release into a failed release.

### GitHub configuration

The generated workflow resolves Flutter with this exact precedence:

```text
flutter_version -> project pin -> FLUTTER_VERSION -> fail
```

`flutter_version` is the manual dispatch input. Project pins are `.fvmrc`, `.flutter-version`, then `.fvm/fvm_config.json`. `FLUTTER_VERSION` is a nonsecret repository variable. The workflow fails if none yields an exact supported version.

Use fixed Environments:

- `play-store-nonproduction` for every nonproduction manual run and only explicitly opted-in GitHub Release events.
- `play-store-production` only for a confirmed manual production run.

Configure Environment reviewer and tag protection in GitHub settings. Those are external controls that file validation cannot prove. Store Environment secrets in both environments as applicable. Keep `ANDROID_KEY_PROPERTIES_PATH` nonsecret and use it only for an existing private local properties file. Keep `FIREBASE_ANDROID_ARTIFACT_TYPE` nonsecret with `AAB` or `APK`.

The workflow is manual-only by default. Setting repository variable `ENABLE_GITHUB_RELEASE_DEPLOY=true` is a standing authorization for `release.published` to deliver only to Play/internal/completed. Authorize its Slack message separately with `ENABLE_GITHUB_RELEASE_SLACK_NOTIFICATION=true`. Manual Slack sends require `confirm_slack_notification=true`; workflow reruns never auto-notify.

### GitHub Secrets groups

Require these five signing/application secrets for every distribution target:

1. `APP_PACKAGE_NAME`
2. `ANDROID_KEYSTORE_BASE64`
3. `ANDROID_KEYSTORE_PASSWORD`
4. `ANDROID_KEY_ALIAS`
5. `ANDROID_KEY_PASSWORD`

Add `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64` for `play-store` or `both`. Add the separate `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` for `firebase` or `both`.

Exactly four values are optional secret-backed configuration:

- `SLACK_WEBHOOK_URL`
- `FIREBASE_APP_ID`
- `FIREBASE_TESTER_GROUPS`
- `FIREBASE_TESTERS`

`FIREBASE_APP_ID` becomes a required runtime value when `firebase` or `both` is selected. It may instead be a documented nonsecret repository or Environment variable when the identifier is not treated as sensitive. Tester names and groups may likewise be nonsecret variables when policy permits. Firebase release notes, distribution flags, confirmation flags, track, rollout, and notification flags are not secrets.

Do not blindly rerun an unknown upload result. Start a fresh dispatch and set the seven retry inputs: `retry_unknown_upload`, `confirm_upload_reconciled`, `reconciled_version_name`, `reconciled_version_code`, `reconciled_artifact_sha256`, `reconciled_destinations`, and `reconciled_provider_state`. The provider must prove `not-delivered`; the allocated version code must equal the reconciled code; and the newly built artifact SHA-256 must equal the reconciled SHA-256 before upload. A mismatch fails closed. An unmarked fresh dispatch cannot be recognized as a retry, and workflow reruns are rejected rather than reconciled implicitly. Retry runs suppress automatic Slack.

The generated workflow currently defines 22 top-level `workflow_dispatch` inputs. GitHub.com allows 25, so only three additional inputs fit without consolidating or redesigning the contract; GitHub Enterprise Server limits can differ by version.

Enter secrets yourself in GitHub settings. If you prefer the GitHub CLI, `gh secret set SECRET_NAME` is a user-run option; the skill must not execute it without explicit authorization.

### No-wrap Base64

Encoding is not encryption. Base64 protects transport shape only. Keep source files private, avoid clipboard and shell-history exposure, never log the output, and enter the encoded value directly into a secret manager.

Use the bundled encoder when possible:

```bash
"$SKILL_ROOT/scripts/encode_secret.sh" --input /private/path/secret.json
```

Equivalent no-wrap Base64 commands are:

```bash
# macOS
base64 -b 0 < /private/path/secret.json

# Linux
base64 -w 0 < /private/path/secret.json
```

```powershell
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\private\secret.json'))
```

## Generated files

Bootstrap owns or safely merges these project paths:

```text
android/Gemfile
android/Gemfile.lock
android/fastlane/Appfile
android/fastlane/Fastfile
android/fastlane/Pluginfile
android/fastlane/lib/flutter_play_store_release.rb
android/fastlane/.env.example
android/key.properties.example
.github/workflows/release-android.yml
docs/PLAY_STORE_RELEASE.md
tool/flutter-play-store-release/decode_secret.sh
tool/flutter-play-store-release/install_flutter_sdk.sh
tool/flutter-play-store-release/managed-files.sha256
```

The invocable and globally installed package is `toris-flutter-play-store-release`. The `tool/flutter-play-store-release` path, sidecar package ID, and generated ownership markers intentionally retain their original project-internal namespace so previously bootstrapped projects remain safely updatable.

The bootstrap also merges required ignore rules and marker-bounded signing hooks. It records hashes for fully owned files. It does not overwrite a populated secret file or silently take ownership of custom release signing.

## Validation

Run package checks from the canonical repository:

```bash
bash toris-flutter-play-store-release/tests/run_tests.sh documentation
python3 /path/to/skill-creator/scripts/quick_validate.py toris-flutter-play-store-release
```

Run project checks after bootstrap:

```bash
"$SKILL_ROOT/scripts/validate_release_setup.sh" \
  --project /path/to/app --context doctor

"$SKILL_ROOT/scripts/validate_release_setup.sh" \
  --project /path/to/app --context build --run-project-commands
```

Record missing credentials and console access as unverified. Do not claim Environment protection, Play review state, Firebase linkage, tester enrollment, or release success from file validation alone.

## Limitations

- The package cannot create or accept Play Console legal declarations, app content, store listing data, account verification, tester enrollment, or production access.
- A completely new or draft Play app may require a first manual AAB and console setup before API automation works.
- Play App Signing, upload key backup, service-account invitation, target-app permissions, and changing platform policies require operator review.
- New personal developer accounts currently have a closed testing gate before production access. Treat the account date, tester count, continuous duration, and eligibility as version-sensitive and re-check the current official Play Console guidance.
- File checks cannot prove GitHub Environment reviewer/tag protection, Play/Firebase links, or external permissions.
- Play version codes are globally constrained and reused codes are rejected. Serialize uploads and resolve a new code instead of retrying an already used one.
- The scripts support macOS and Linux, not native Windows execution.

Use the [first-release checklist](references/first-release-checklist.md), [environment catalog](references/environment-variables.md), [execution defaults](references/execution-defaults.md), and [troubleshooting guide](references/troubleshooting.md) for detailed operation.

## Sources

Use primary documentation and re-check version-sensitive requirements before a live release:

- [Flutter Android deployment](https://docs.flutter.dev/deployment/android)
- [Flutter flavors](https://docs.flutter.dev/deployment/flavors)
- [Android app signing](https://developer.android.com/studio/publish/app-signing)
- [Play Console app setup](https://support.google.com/googleplay/android-developer/answer/9859152?hl=en)
- [Google Play Developer API getting started](https://developers.google.com/android-publisher/getting_started)
- [Google Play edits](https://developers.google.com/android-publisher/edits)
- [Personal-account testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)
- [Fastlane upload_to_play_store](https://docs.fastlane.tools/actions/upload_to_play_store/)
- [Fastlane Firebase App Distribution plugin](https://firebase.google.com/docs/app-distribution/android/distribute-fastlane)
- [GitHub Actions documentation](https://docs.github.com/actions)
- [GitHub Actions security](https://docs.github.com/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [Firebase and Google Play linking](https://support.google.com/googleplay/android-developer/answer/6110967?hl=en)
