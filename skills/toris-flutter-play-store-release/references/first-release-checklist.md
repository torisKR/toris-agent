# First release checklist

Complete this checklist for the selected Android application before enabling automated Play upload. Record evidence and owners outside the repository without copying credentials into the record.

## 1. Application identity

- [ ] Inspect the selected release flavor and Dart entrypoint.
- [ ] Confirm the release `applicationId`, namespace, version sources, and `APP_PACKAGE_NAME` match.
- [ ] Confirm the package belongs to the intended Play developer account and Firebase project.
- [ ] Confirm the app is Android only for this workflow; handle any iOS release separately.

## 2. Cloud API enablement

- [ ] Select a Google Cloud project owned by the correct organization or operator.
- [ ] Enable the Google Play Developer API in that project.
- [ ] Record the Cloud project owner and credential-rotation owner.
- [ ] Confirm billing or unrelated APIs are not being enabled as a side effect.

Google's current setup starts with a Cloud project, API enablement, and a service account or OAuth client. Use a service account for server-to-server CI. See [Google Play Developer API getting started](https://developers.google.com/android-publisher/getting_started).

## 3. Service account invitation and app permissions

- [ ] Create a dedicated Play release service account; do not reuse a personal or broad production credential.
- [ ] Invite its email from Play Console Users and permissions.
- [ ] Restrict access to the target app wherever Play Console permits.
- [ ] Grant view access and only the release permissions required for the intended tracks.
- [ ] Exclude finance, order, subscription, user-management, global admin, and unrelated-app permissions.
- [ ] Issue and store JSON only after least privilege is configured.
- [ ] Test read access before any write and distinguish authentication from permission failures.

Use a separate Firebase service account for Firebase App Distribution. Do not let Firebase setup broaden Play access.

## 4. Signing and key custody

- [ ] Detect any existing upload keystore and compare its certificate fingerprints with Play Console.
- [ ] Enable and review Play App Signing during first release setup.
- [ ] Distinguish the Play app-signing key from the local upload key.
- [ ] Confirm the upload alias, passwords, expiry, and recovery owner.
- [ ] Create an encrypted, access-controlled upload key backup and test recovery.
- [ ] Store the keystore and each password in approved systems with separate access as policy requires.
- [ ] Keep `.env`, `android/key.properties`, `*.jks`, and `*.keystore` ignored and uncommitted.
- [ ] Confirm CI receives temporary signing files and deletes owned material after the run.

Never generate, replace, reset, or delete a key merely because it is missing from the current machine. Require explicit owner authorization for any key operation. See [Android app signing](https://developer.android.com/studio/publish/app-signing).

## 5. Legal, app-content, and policy setup

- [ ] Create the app in Play Console with the confirmed package and default language.
- [ ] Complete store listing, contact, privacy, data safety, ads, target audience, content rating, app access, and pricing/country declarations as applicable.
- [ ] Complete developer identity, payment-profile, package-registration, and verification tasks shown by Play Console.
- [ ] Check the current target API level, restricted-permission, SDK, and developer-program policies.
- [ ] Have the authorized account owner accept any required legal terms; automation must not accept them.

The Publishing API does not replace console-only app creation, legal declarations, account verification, or app-content setup.

## 6. First manual AAB

- [ ] Run read-only doctor and resolve every hard failure.
- [ ] Build a signed release AAB without upload.
- [ ] Verify exactly one fresh nonempty artifact, the package, version name, unique version code, flavor, target, and upload certificate.
- [ ] Complete the first manual AAB upload to an internal track when the new or draft app cannot yet use API automation.
- [ ] Review Play App Signing enrollment, warnings, target API results, and package ownership.
- [ ] Finish any first-release or draft-app console steps before retrying API access.
- [ ] Confirm the service account can read the app and configured tracks after the manual bootstrap.

Do not treat repeated automated upload attempts as first-release setup. Keep the first manual upload result and approval evidence, not the credential or signed artifact, in the release record.

## 7. Testers and track gates

### Internal gate

- [ ] Create the internal track and tester list in Play Console.
- [ ] Verify testers can opt in, install, launch, authenticate, update, and report defects.
- [ ] Verify the release is not accidentally available to a broader audience.

### Closed gate

- [ ] Create the intended closed track and tester cohort.
- [ ] Confirm current eligibility, minimum tester count, continuous duration, and feedback expectations in Play Console.
- [ ] Keep evidence of opt-in duration and meaningful testing without collecting unnecessary personal data.
- [ ] Resolve quality, policy, crash, and pre-launch findings before requesting production access.

### Production gate

- [ ] Confirm production access is enabled for this account and app.
- [ ] Review internal/closed evidence, release notes, vitals, policy status, staged rollout plan, rollback plan, and owner approvals.
- [ ] Require an explicit production request and `CONFIRM_PRODUCTION_DEPLOY=true`.
- [ ] Use the protected `play-store-production` GitHub Environment; verify reviewers and tag rules in GitHub settings.

## 8. Changing personal-account policy

Google's guidance currently says new personal developer accounts created after November 13, 2023 must complete closed testing with at least 12 testers opted in continuously for at least 14 days, then apply for production access. Treat this as a version-sensitive warning, not a timeless constant.

- [ ] Re-check [official personal-account testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en) on the release date.
- [ ] Compare the account creation date and account type with the current scope.
- [ ] Follow the Play Console dashboard when it imposes a stricter or newer gate.
- [ ] Record the checked policy date and source in the approval record.

Automation must not claim that tester enrollment, duration, engagement, or production approval is proven by repository files.

## 9. Firebase readiness

- [ ] Register the exact Android package as a Firebase app and verify `FIREBASE_APP_ID`.
- [ ] Match the selected release package and app ID to `google-services.json`, or explicitly confirm only when mapping evidence is absent.
- [ ] Create a separate least-privilege Firebase service account.
- [ ] Create tester groups and confirm distribution consent and ownership.
- [ ] For AAB distribution, link the Firebase app to the reviewed/published Play app in the correct developer account.
- [ ] Review the Firebase-generated test-app signing certificate used to re-sign tester APKs and update certificate allowlists.
- [ ] Set `CONFIRM_FIREBASE_AAB_PLAY_LINKED=true` only after link and certificate review.

APK delivery does not require the Play link. See [Play/Firebase linking](https://support.google.com/googleplay/android-developer/answer/6110967?hl=en) and [Firebase AAB information](https://firebase.google.com/docs/reference/app-distribution/rest/v1/projects.apps/getAabInfo).

## 10. GitHub and notification readiness

- [ ] Configure `play-store-nonproduction` and `play-store-production` with target-appropriate secrets.
- [ ] Verify five every-target signing/application secrets and the conditional Play/Firebase credential.
- [ ] Configure reviewer/tag protection externally and record it as unverified by file-only validation.
- [ ] Confirm exact Flutter resolution, pinned actions, Java/Ruby/Bundler versions, concurrency, and immutable checkout behavior.
- [ ] Select exactly one Slack notification owner and verify secrets do not enter payloads.
- [ ] Keep Slack disabled by default; require a per-run confirmation or the separate documented release-event standing authorization.
- [ ] Confirm Slack failure cannot mask the release result.
- [ ] Confirm every `CONFIRM_*` authorization is the exact lowercase string `true`; do not accept truthy aliases.

## 11. Final automation preflight

- [ ] Run `validate_release_setup.sh --project PATH --context deploy` without network access.
- [ ] Confirm the named target and track. Internal authorization covers only internal.
- [ ] Confirm Play-only/Firebase-only lanes are pinned; require exact `both` plus its separate confirmation for dual delivery.
- [ ] Query all configured Play tracks successfully before allocating a version code.
- [ ] Confirm no concurrent upload can allocate the same code.
- [ ] Confirm release status and rollout are valid; production is never the default.
- [ ] Pin ordinary deploys to `completed` with no rollout; require exact lane options and separate confirmation for non-default policy.
- [ ] For an unknown provider outcome, reject workflow reruns and require a fresh dispatch with all seven exact retry/reconciliation inputs.
- [ ] Before a reconciled retry upload, require the allocated code and newly built artifact SHA-256 to equal the attested tuple.
- [ ] Confirm release notes, testers/groups, notification flags, result path, and artifact type are ordinary configuration, not secrets.
- [ ] Verify rollback and promotion are separate authorized actions.
- [ ] Record missing console access, policy state, Environment protection, and provider permissions as not verified.

Only after every applicable gate passes should the operator authorize a named deployment.
