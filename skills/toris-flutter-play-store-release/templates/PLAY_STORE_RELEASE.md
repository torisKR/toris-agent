# Android release operations

Keep this guide with the Flutter project. Replace example paths and identifiers with values confirmed from the selected release variant. Never put a real credential in this file.

## 1. Purpose

Use the generated Fastlane and GitHub Actions configuration to validate, build, and deliver this Flutter application's Android release. Google Play is the primary destination. Firebase App Distribution and Slack are optional. iOS and App Store delivery are not covered.

Local setup, doctor, build, CI configuration, Firebase configuration, and Slack configuration do not authorize a Play upload. Require explicit authorization for the exact destination and track before delivery.

## 2. Generated files

The setup manages or marker-merges these paths:

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

These `tool/flutter-play-store-release` paths and their ownership metadata are a stable project-internal compatibility namespace. The agent skill itself is invoked and installed as `toris-flutter-play-store-release`.

Do not edit a fully owned file without expecting the next repair to report a hash conflict. Keep real `.env`, `android/key.properties`, keystores, service-account JSON, Fastlane output, and decoded credentials ignored and uncommitted.

## 3. Play Console setup

1. Create the app in Play Console with the confirmed release `applicationId`.
2. Complete the store listing, app content, privacy, data safety, target audience, ads, content rating, pricing, countries, and every current legal declaration that applies.
3. Review the current target API, developer verification, package registration, and testing requirements.
4. Enable Play App Signing when creating the first release and understand which key signs user-delivered APKs.
5. Create internal and closed tracks and tester lists as required before automation.

For new personal developer accounts created after November 13, 2023, current Play guidance requires a closed test with at least 12 testers opted in continuously for at least 14 days before applying for production access. This is version-sensitive policy: check the current requirement in Play Console and the [official testing guidance](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en) before release.

## 4. Service account setup

1. Create or select a Google Cloud project.
2. Enable the Google Play Developer API.
3. Create a dedicated service account and issue its JSON key only when needed.
4. In Play Console, invite the service-account email under Users and permissions.
5. Grant least privilege at the target-app level: view app information and the release permissions needed for the intended tracks. Do not grant finance, orders, global admin, or unrelated-app access.
6. Confirm API access with read-only doctor checks before any upload.

Keep Google Play and Firebase service accounts separate. Rotate a JSON key through the provider and secret store; do not commit it or paste it into logs.

See [Google Play Developer API getting started](https://developers.google.com/android-publisher/getting_started) and [Play Console permissions](https://support.google.com/googleplay/android-developer/answer/9844686?hl=en).

## 5. Upload key setup

Use an upload key to sign the AAB sent to Play. Play App Signing uses a separate app-signing key for artifacts delivered to users.

1. Detect an existing upload key before creating anything.
2. Verify the alias, certificate fingerprints, expiry, and current Play Console registration.
3. Store the keystore, passwords, alias, certificate, and recovery ownership in an approved secret system.
4. Make an encrypted, access-controlled upload key backup and test the recovery procedure. Record who owns recovery.
5. Keep `android/key.properties` private with an absolute keystore path. Never commit either file.

Do not generate, replace, reset, or delete a key without explicit authorization. Losing an upload key is not a reason to replace the Play app-signing key.

## 6. GitHub secrets

Configure these five secrets for every target in both applicable GitHub Environments:

- `APP_PACKAGE_NAME`
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Add `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64` for `play-store` or `both`. Add the separate `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` for `firebase` or `both`.

Exactly four values may be secret-backed optional configuration: `SLACK_WEBHOOK_URL`, `FIREBASE_APP_ID`, `FIREBASE_TESTER_GROUPS`, and `FIREBASE_TESTERS`. `FIREBASE_APP_ID` is required at runtime for a Firebase target, but it may come from a documented nonsecret variable. Release notes, artifact flags, confirmation flags, track, release status, rollout, and notification flags are not secrets.

Use `play-store-nonproduction` for nonproduction dispatches and explicitly opted-in release events. Use `play-store-production` only for confirmed production dispatches. Configure required reviewers and tag protection in GitHub settings; file validation cannot prove those external controls.

Resolve Flutter in this exact order:

```text
flutter_version -> project pin -> FLUTTER_VERSION -> fail
```

The dispatch input wins. Project pins are `.fvmrc`, `.flutter-version`, then `.fvm/fvm_config.json`. `FLUTTER_VERSION` is a nonsecret repository variable. Keep `ANDROID_KEY_PROPERTIES_PATH` and `FIREBASE_ANDROID_ARTIFACT_TYPE` nonsecret.

Encoding is not encryption. Use no-wrap Base64, keep outputs out of logs and history, and enter values directly in the secret store:

```bash
# macOS
base64 -b 0 < /private/path/upload.jks

# Linux
base64 -w 0 < /private/path/upload.jks
```

```powershell
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\private\upload.jks'))
```

Enter secrets in GitHub settings. If preferred, `gh secret set SECRET_NAME` is a user-run option, never an implied automation step.

## 7. First manual upload

A completely new or draft Play app may not be ready for Publishing API automation. Complete a first manual AAB upload in Play Console when required:

1. Run doctor and build locally.
2. Verify the release package, version name, unique version code, signing certificate, and nonempty AAB.
3. Complete Play App Signing and all blocking app-content or legal steps.
4. Upload the AAB to internal testing in Play Console.
5. Resolve every Play warning or rejection and create the intended track/tester state.
6. Confirm the service account can read the app and track before enabling automated upload.

Record the first manual AAB result without recording credentials. Automation must not retry authentication errors, permission errors, or draft-app constraints blindly.

## 8. Local doctor

Run a read-only readiness check from the project root:

```bash
SKILL_ROOT=/path/to/installed/toris-flutter-play-store-release
"$SKILL_ROOT/scripts/validate_release_setup.sh" \
  --project . --context doctor --format human
```

Run the validator from the installed skill package with `--project` pointing here. Doctor reports `PASS`, `WARN`, and `FAIL`; it does not run dependency installation, analysis, tests, builds, or uploads. Resolve failures before delivery and record unavailable console checks as unverified.

## 9. Local build

Authorize project commands, then validate and build without upload:

```bash
"$SKILL_ROOT/scripts/validate_release_setup.sh" \
  --project . --context build --run-project-commands
cd android
bundle install
bundle exec fastlane android doctor
bundle exec fastlane android build
```

Confirm exactly one fresh, nonempty AAB; the resolved version name/code; selected flavor and Dart target; release application ID; and release signing. Do not infer upload success from a build.

## 10. Internal deployment

An explicit internal deployment authorizes only the internal Play track. Validate before network access:

```bash
"$SKILL_ROOT/scripts/validate_release_setup.sh" --project . --context deploy
cd android
bundle install
bundle exec fastlane android doctor
PLAY_STORE_TRACK=internal bundle exec fastlane android release_play_store
```

The lane queries configured tracks for the next active version code, builds one verified AAB, and uploads only the binary. It skips listing metadata, images, screenshots, and changelogs. Serialize releases; a reused version code requires a newly resolved code and rebuild, not a blind retry.

## 11. GitHub Release runs

GitHub Release deployment is disabled by default. Explicitly setting repository variable `ENABLE_GITHUB_RELEASE_DEPLOY=true` during CI setup creates a standing authorization for `release.published`; the event remains fixed to the immutable tag commit, `play-store`, `internal`, `completed`, and `play-store-nonproduction`. It cannot route to Firebase, a rollout, or production.

Before publishing the GitHub Release, verify the tag points at the intended commit, required nonproduction Environment secrets are present, the exact Flutter version resolves, and no other release for this app is running.

## 12. Manual workflow runs

Use `workflow_dispatch` for a deliberate target, track, version, status, tests flag, Firebase artifact type, and confirmation inputs. The workflow rejects unconfirmed production before entering a secret-bearing job.

- Route every nonproduction run to `play-store-nonproduction`.
- Route production only to `play-store-production` after a separate production request and confirmation.
- Ordinary deploys use `completed` without rollout. Pass `release_status:draft` or exact `release_status:inProgress rollout:VALUE` lane options only after the separate request and `CONFIRM_PLAY_RELEASE_POLICY=true`.
- Select `both` only with exact `distribution_target:both` and `CONFIRM_DUAL_DELIVERY=true`; ambient values never expand a target.
- Do not use this binary-upload lane to halt an existing release.
- Treat reviewer/tag protection as required external setup, not as a validated file property.

Every `CONFIRM_*` runtime gate accepts only the exact lowercase string `true`; convenience aliases, uppercase variants, surrounding whitespace, and native booleans passed directly to the helper fail closed. The workflow currently uses 22 of GitHub.com's 25 top-level `workflow_dispatch` inputs, leaving three for future additions. Check the limit for the deployed GitHub Enterprise Server version before installing this template there.

For a provider outcome that remains unknown, do not use the Actions **Re-run jobs** control: every run attempt after the first is rejected. Reconcile the prior provider state, start a fresh dispatch, and supply all seven retry inputs:

- `retry_unknown_upload=true`
- `confirm_upload_reconciled=true`
- `reconciled_version_name` equal to `version_name`
- `reconciled_version_code` equal to the exact prior positive build code
- `reconciled_artifact_sha256` equal to the exact lowercase SHA-256 of the prior artifact
- `reconciled_destinations` equal to `play-store`, `firebase`, or `play-store,firebase` for `both`
- `reconciled_provider_state=not-delivered`

Leaving `retry_unknown_upload=false` requires the confirmation and tuple fields to remain false or empty; an unmarked fresh retry cannot be inferred. Before upload, the runtime requires its allocated version code to equal the reconciled code and recomputes the newly built artifact SHA-256. Any mismatch stops before the provider adapter. If the rebuild is not byte-for-byte identical, recover the exact artifact or begin a new explicitly authorized release; the workflow does not persist or recover prior artifacts.

## 13. Slack notifications

Set `SLACK_WEBHOOK_URL` only when notifications are wanted. Keep one notification owner with `SLACK_NOTIFICATION_OWNER=fastlane` locally or `github-actions` in CI. `SLACK_NOTIFY_SUCCESS` and `SLACK_NOTIFY_FAILURE` remain preferences behind the default-off authority gate: require `CONFIRM_SLACK_NOTIFICATION=true` for a current run. Release events require the separate standing variable `ENABLE_GITHUB_RELEASE_SLACK_NOTIFICATION=true`.

Messages include only repository, version, track, result, run URL, and commit or release URL. They must not include the environment, credentials, signing values, or raw provider errors. Slack failure must not mask the primary build or delivery result. Workflow reruns and `RETRY_UNKNOWN_UPLOAD=true` runs never auto-notify; send any later message separately after final provider state is known. Do not send a test message without explicit authorization.

## 14. Firebase App Distribution

Firebase-only delivery accepts `FIREBASE_ANDROID_ARTIFACT_TYPE=AAB` or `APK`; `AAB` is the default. `both` requires AAB and reuses the single Play artifact.

Require `FIREBASE_APP_ID`, separate Firebase service-account credentials, and either testers or groups as appropriate. Match the selected release `applicationId` and Firebase app ID to `google-services.json`. If evidence is absent, require `CONFIRM_FIREBASE_PACKAGE_MATCH=true`; never let confirmation override a detected mismatch.

Before AAB distribution, link the Firebase Android app to a reviewed/published app in the correct Play developer account. Review the Firebase-generated test-app signing certificate used to re-sign tester APKs and update any API-provider certificate allowlists. Set `CONFIRM_FIREBASE_AAB_PLAY_LINKED=true` only after that review. APK distribution does not require the Play link.

See [Firebase Fastlane distribution](https://firebase.google.com/docs/app-distribution/android/distribute-fastlane), [Firebase AAB information](https://firebase.google.com/docs/reference/app-distribution/rest/v1/projects.apps/getAabInfo), and [Play/Firebase linking](https://support.google.com/googleplay/android-developer/answer/6110967?hl=en).

## 15. Troubleshooting

- **Authentication:** Validate JSON structure, intended credential source, key status, and clock without printing the credential.
- **Permissions:** Confirm the service-account invitation and target-app release permissions; do not substitute global admin access.
- **Draft or new app:** Complete console app content, first upload, track, and Play App Signing steps.
- **Reused version code:** Query all configured tracks, serialize releases, and select a new valid code. If an upload outcome is unknown, do not rebuild or retry until the exact prior version/code, artifact SHA-256 identifier, and destination are reconciled and the provider proves `not-delivered`.
- **Signing:** Compare upload certificate fingerprints, alias, properties path, and release signing assignment.
- **Stale artifacts:** Remove only owned new output, restore quarantined prior output, and require exactly one fresh artifact.
- **Firebase Play link:** Verify the Play account link, published package, integration state, and test certificate.
- **Slack:** Preserve the release result and diagnose notification ownership, webhook response, and JSON separately.
- **CI runner and actions:** Verify exact Flutter resolution, pinned actions, Java/Ruby/Bundler setup, Environment routing, concurrency, and runner disk space.

Run doctor again after correction. Do not use repeated deploy attempts as diagnosis.

## 16. Key loss and rotation

Stop deployment when the upload keystore, password, alias, or expected fingerprint is missing or inconsistent. Check the encrypted upload key backup and recovery owner first. If Play App Signing is enabled and the upload key is unrecoverable, follow Play Console's official upload-key reset process with account-owner authorization. Rotate the CI secret only after Play accepts the replacement certificate.

Rotate service-account JSON and Slack webhooks in their providers, then update approved secret stores. Revoke old material after the new path is validated. Never rotate the Play app-signing key as a routine upload-key repair.

## 17. Rollback and promotion

A Play binary cannot be replaced by reusing its version code. For a bad internal or closed release, stop promotion, prepare a fixed build with a higher code, and release through the same preflight. For a staged production rollout, use Play Console's supported halt or rollout controls only with explicit authorization; this binary-upload lane does not halt an existing release.

Promotion is a separate external action. Review test evidence, policy status, crash/vitals signals, signing, country coverage, release notes, and production Environment approval before promoting. Name the source and destination tracks and record the resulting Play state. Never interpret an internal upload as production authorization.
