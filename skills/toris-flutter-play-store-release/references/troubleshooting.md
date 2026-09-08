# Troubleshooting

Run the read-only doctor first and preserve its `PASS`, `WARN`, and `FAIL` findings. Diagnose one boundary at a time. Do not retry a deploy until local preflight passes and the external cause is understood.

## Authentication

Symptoms include invalid credentials, missing client email/private key, expired or revoked JSON keys, HTTP 401, or a provider rejecting the caller identity.

1. Confirm the selected target uses the correct separate credential.
2. Confirm precedence is path > Base64 > default and that an invalid explicit path does not fall through.
3. Validate JSON structure and credential status without printing values.
4. Confirm runner time and provider key revocation state.
5. Rotate only with explicit authorization; revoke old material after the replacement works.

## Permissions

HTTP 403 or an authenticated caller that cannot read an app or edit a track is a permissions problem.

1. Confirm the service-account email was invited to Play Console.
2. Confirm access is granted to the exact target app.
3. Grant only view and intended release-track permissions; preserve least privilege.
4. Confirm Firebase IAM roles separately for Firebase delivery.
5. Do not solve a narrow permission failure by granting global admin, finance, order, or unrelated-app access.

See [Play Console permission definitions](https://support.google.com/googleplay/android-developer/answer/9844686?hl=en).

## Draft or new app

Treat a draft or new app as a console-bootstrap case. An application-not-found, draft-app, first-release, first-upload, or not-published result can mean API automation is premature.

1. Confirm the package exists in the intended Play developer account.
2. Complete app creation, legal/app-content declarations, Play App Signing, and track setup in Play Console.
3. Build and verify a first manual AAB.
4. Upload it manually to internal testing when Play requires console bootstrap.
5. Confirm the service account can read the app and tracks before trying automated delivery again.

Do not treat a draft/new-app constraint as an authentication retry loop.

## Reused version code

Play rejects a version code that has already been used, even when it is not visible on the selected track.

1. Stop concurrent releases for the package.
2. Query every name in `PLAY_STORE_VERSION_TRACKS` plus the selected track.
3. Treat an API error or malformed result as fatal; an empty track is valid.
4. Select the maximum active code plus one within `1..2100000000`.
5. If the rejection definitively proves no upload occurred, rebuild with the new code only after a fresh explicit deploy authorization.

Google and Fastlane do not provide this workflow with an authoritative allocator for every code ever used. If provider outcome is unknown, reconcile the exact prior version name/code, artifact SHA-256, and destination. Do not rerun the workflow; begin a fresh marked dispatch only after the provider proves `not-delivered`, `CONFIRM_UPLOAD_RECONCILED=true`, and all seven retry inputs are supplied. The runtime requires the allocated code and newly built artifact SHA-256 to equal the reconciled tuple before upload. A mismatch is not retryable evidence: recover the exact artifact or begin a new explicitly authorized release. An unmarked fresh retry cannot be inferred.

## Signing

Symptoms include missing keystore, bad password, unknown alias, certificate mismatch, release signed as debug, unsafe properties permissions, or Play rejecting the upload certificate.

1. Compare the expected upload certificate fingerprints in Play Console.
2. Inspect `ANDROID_KEY_PROPERTIES_PATH` mode, parent mode, absolute `storeFile`, and completeness.
3. Confirm all raw inputs are present when no properties override is used.
4. Confirm the release variant has exactly one release signing assignment and no debug assignment.
5. Check the encrypted upload key backup and recovery owner before any reset.
6. If authorized and Play App Signing is enabled, follow the official upload-key reset process; do not replace the app-signing key routinely.

## Stale artifacts

Treat stale artifacts as invalid input. Zero, multiple, old, empty, wrong-format, or wrong-flavor artifacts must fail rather than be guessed.

1. Confirm the build command received the intended flavor and Dart target.
2. Quarantine only prior outputs for the selected variant before building.
3. Require exactly one fresh nonempty AAB for Play, or the selected AAB/APK for Firebase-only.
4. Verify package, version, signing, and output type separately from the filename.
5. On failure, remove only new candidates and restore quarantined prior output.

Do not claim a Dart target from an artifact path and do not upload a stale file.

## Firebase Play link

For Firebase AAB failures, distinguish missing Play account linkage, package mismatch, unpublished Play app, unaccepted terms, and unavailable integration state.

1. Link the correct Firebase Android app and Play developer account.
2. Confirm a reviewed/published Play app with the same package exists.
3. Match `FIREBASE_APP_ID`, release `applicationId`, and `google-services.json` evidence.
4. Review the test-app signing certificate Firebase uses when Play converts and re-signs tester APKs.
5. Set `CONFIRM_FIREBASE_AAB_PLAY_LINKED=true` only after those checks.

Use APK distribution when appropriate if the Play link is intentionally unavailable. See [Firebase AAB information](https://firebase.google.com/docs/reference/app-distribution/rest/v1/projects.apps/getAabInfo).

## Slack

Slack is optional. Missing webhook means skip. HTTP, network, or payload failure is a warning.

1. Confirm `SLACK_NOTIFICATION_OWNER` chooses exactly one sender.
2. Confirm success/failure flags match policy.
3. Validate the JSON-safe payload contains only repository, version, track, result, run URL, and source URL.
4. Confirm no credentials or full environment are logged.
5. Diagnose the webhook separately after preserving the primary release result.

Slack failure must not mask a build, Play, or Firebase result. `CONFIRM_SLACK_NOTIFICATION=true` is required independently of the webhook and preference flags. Workflow reruns and unknown-outcome retry runs suppress automatic Slack; any later message needs separate authorization after final provider state is known. Do not send a test message without explicit authorization.

## CI runner and actions

Symptoms include unresolved Flutter version, checksum failure, unsupported archive, dependency-lock mismatch, missing Environment secret, rejected production route, action pin failure, timeout, or disk exhaustion.

1. Verify Flutter precedence: dispatch `flutter_version`, project pin, repository `FLUTTER_VERSION`, then fail.
2. Verify every nonlocal action uses a reviewed 40-character commit SHA.
3. Verify Java 17, Ruby 3.3, frozen Bundler state, lockfile, and Android working directory.
4. Confirm release tags dereference to the immutable checked-out commit.
5. Confirm nonproduction uses `play-store-nonproduction`; confirmed production uses `play-store-production`.
6. Review Environment secrets, reviewers, and tag protection in GitHub settings. File checks cannot prove external protection.
7. Confirm the concurrency group prevents overlapping release jobs for the same app.
8. Inspect runner disk, network, provider status, and the first failing step without exposing secrets.

See [GitHub Actions documentation](https://docs.github.com/actions) and [GitHub Actions security hardening](https://docs.github.com/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions).

## Doctor, build, and deploy triage

- A doctor `FAIL` blocks the selected context. A `WARN` may be expected for absent deploy credentials during setup/build.
- Doctor never runs project-mutating commands. Use setup/build with `--run-project-commands` only when authorized.
- A build result proves only local artifact production and validation.
- Deploy must run deploy-context doctor before network access and must stop on package, signing, credential, track, version, or artifact failure.
- A partial `both` result must name successful destinations and the failed destination; never flatten it into success.

After fixing the cause, rerun doctor, then the narrowest build or deploy preflight. Record any missing external evidence as not verified.
