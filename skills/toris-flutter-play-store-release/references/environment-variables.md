# Environment variables

Use this catalog for local Fastlane runs and generated GitHub Actions runs. Keep configuration in `android/fastlane/.env` only on a private workstation and never commit that file. Each row supplies: type | context | default | precedence | secrecy | validation | owner.

## Precedence rules

- Resolve secret files as path > Base64 > default. An explicit unsafe or invalid path is a hard failure; do not fall back.
- Resolve signing as `ANDROID_KEY_PROPERTIES_PATH` > complete raw keystore inputs > local `android/key.properties` outside CI. CI refuses a workspace `android/key.properties`.
- Resolve Flutter as manual `flutter_version` input > project pin (`.fvmrc`, `.flutter-version`, `.fvm/fvm_config.json`) > repository variable `FLUTTER_VERSION` > fail.
- Resolve release notes as `FIREBASE_RELEASE_NOTES` from the dispatch input > repository or Environment variable > generated version text.
- Resolve version name as lane option > `VERSION_NAME` > one exact semantic-version tag at `HEAD` > `pubspec.yaml`.
- Resolve build-only version code as `VERSION_CODE` > numeric `pubspec.yaml` build number > positive Git commit count. Play deployment instead uses the maximum active code across `PLAY_STORE_VERSION_TRACKS` plus one and never falls back locally.

## Application, version, and toolchain

| Variable | Type | Context | Default | Precedence | Secrecy | Validation | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `APP_PACKAGE_NAME` | Android package string | doctor, build, deploy, CI | None | Explicit value; must equal selected release `applicationId` | Secret in generated workflow; nonsecret by nature | Java package shape and exact release-ID match | App/release owner |
| `VERSION_NAME` | SemVer-like string | build, deploy, CI | Exact tag or `pubspec.yaml` | Lane option > env > exact tag > pubspec | Nonsecret | `v?MAJOR.MINOR.PATCH` with supported prerelease | Release owner |
| `VERSION_CODE` | Integer | local build or Firebase-only delivery | Pubspec code, then positive Git commit count | Env > pubspec > fallback; ignored for Play allocation | Nonsecret | `1..2100000000` | Release owner |
| `FLUTTER_FLAVOR` | Flavor name | inspect, build, deploy | None | Lane option > env; never guessed silently | Nonsecret | Must match an inspected release flavor | App owner |
| `RELEASE_DART_TARGET` | Relative Dart path | build, deploy | `lib/main.dart` | Lane option > env > default | Nonsecret | Contained readable Dart file | App owner |
| `FLUTTER_VERSION` | Exact SDK version | GitHub Actions | None | Dispatch input > project pin > repository variable > fail | Nonsecret variable | Exact supported version syntax and verified archive | Repository owner |
| `FLUTTER_CHANNEL` | Enum | SDK installation policy | `stable` | Workflow/package setting | Nonsecret | `stable` or `beta`; production workflow uses stable | Repository owner |
| `JAVA_VERSION` | Major version | CI/toolchain documentation | `17` | Generated workflow pin | Nonsecret | Compatible with Gradle and Android Gradle Plugin | Repository owner |
| `RUBY_VERSION` | Version | CI/toolchain documentation | `3.3` | Generated workflow pin | Nonsecret | Fastlane runtime supports `>=3.2,<4.0` | Repository owner |
| `RUN_FLUTTER_ANALYZE` | Boolean | prepare, build, deploy | `true` | Explicit env > default | Nonsecret | `true` or `false` | Release owner |
| `RUN_FLUTTER_TESTS` | Boolean | prepare, build, deploy | `false` local; `true` for release event | Validated workflow input or env > default | Nonsecret | `true` or `false` | Release owner |
| `RUN_BUILD_RUNNER` | Enum | prepare, build, deploy | `auto` | Explicit env > default | Nonsecret | `auto`, `true`, or `false`; `auto` checks pubspec | App owner |

## Routing and release policy

| Variable | Type | Context | Default | Precedence | Secrecy | Validation | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DISTRIBUTION_TARGET` | Enum | doctor, deploy, CI | `play-store` | Exact lane option for delivery; ambient values are inspection-only and cannot expand a release | Nonsecret | `play-store`, `firebase`, or `both` | Release owner |
| `ENABLE_FIREBASE_APP_DISTRIBUTION` | Boolean | read-only inspection compatibility | `false` | Never expands a delivery target | Nonsecret | `true` or `false` | Fastlane coordinator |
| `CONFIRM_DUAL_DELIVERY` | Boolean confirmation | `both` delivery | `false` | Exact `true` in addition to `distribution_target:both` | Nonsecret | Exact `true`; never inferred | User/release approver |
| `PLAY_STORE_TRACK` | Track name | Play build/deploy | `internal` | Validated input or env > default | Nonsecret | Safe track syntax; production needs confirmation | Release owner |
| `PLAY_STORE_VERSION_TRACKS` | CSV track list | Play version allocation | `internal,alpha,beta,production` | Explicit env > default; selected track is added | Nonsecret | Unique safe names; each API query must succeed | Release owner |
| `PLAY_STORE_RELEASE_STATUS` | Enum | Play deploy | `completed` | Exact lane option; ambient non-default values fail closed | Nonsecret | `completed`, `draft`, or `inProgress` | Release owner |
| `PLAY_STORE_ROLLOUT` | Decimal | staged Play deploy | None | Exact lane option used only with `inProgress` | Nonsecret | Strictly greater than 0 and less than 1 | Release owner |
| `CONFIRM_PLAY_RELEASE_POLICY` | Boolean confirmation | non-default status or rollout | `false` | Exact `true` in addition to exact status/rollout lane options | Nonsecret | Exact `true`; never inferred | User/release approver |
| `CONFIRM_PRODUCTION_DEPLOY` | Boolean confirmation | production Play deploy | `false` | Must be explicitly true in addition to a production request | Nonsecret | Exact `true`; never inferred | User/release approver |
| `FIREBASE_ANDROID_ARTIFACT_TYPE` | Enum | Firebase build/delivery | `AAB` | Validated input or env > default; `both` forces AAB | Nonsecret | `AAB` or `APK` | Release owner |
| `CONFIRM_FIREBASE_AAB_PLAY_LINKED` | Boolean confirmation | Firebase AAB | `false` | Explicit input or env only | Nonsecret | Exact `true` after reviewed Play link and test certificate | User/release approver |
| `CONFIRM_FIREBASE_PACKAGE_MATCH` | Boolean confirmation | Firebase without mapping evidence | `false` | Explicit input or env; cannot override a detected mismatch | Nonsecret | Exact `true` only when `google-services.json` evidence is absent | User/release approver |
| `RETRY_UNKNOWN_UPLOAD` | Reconciliation marker | fresh retry after unknown outcome | `false` | Explicit workflow input or env only | Nonsecret | Exact `true` or `false`; `true` requires the complete tuple | Release owner |
| `CONFIRM_UPLOAD_RECONCILED` | Boolean confirmation | marked unknown-outcome retry | `false` | Explicit input or env only | Nonsecret | Exact lowercase string `true`; never inferred | User/release approver |
| `RECONCILED_VERSION_NAME` | Version identifier | marked unknown-outcome retry | None | Explicit input or env only | Nonsecret | Exact requested version, with optional equivalent leading `v` | Release owner |
| `RECONCILED_VERSION_CODE` | Integer | marked unknown-outcome retry | None | Explicit input or env only | Nonsecret | `1..2100000000`; must equal the allocated build code | Release owner |
| `RECONCILED_ARTIFACT_SHA256` | SHA-256 | marked unknown-outcome retry | None | Explicit input or env only | Nonsecret identifier | Exactly 64 lowercase hexadecimal characters; must equal the newly built artifact hash | Release owner |
| `RECONCILED_DESTINATIONS` | Destination tuple | marked unknown-outcome retry | None | Explicit input or env only | Nonsecret | Exact target: `play-store`, `firebase`, or `play-store,firebase` | Release owner |
| `RECONCILED_PROVIDER_STATE` | Provider state | marked unknown-outcome retry | None | Explicit input or env only | Nonsecret | Exactly `not-delivered` | Release owner |
| `FIREBASE_RELEASE_NOTES` | Text | Firebase delivery | Generated `Version NAME (CODE)` | Dispatch input > repository/Environment variable > generated text | Nonsecret | Length/control-character checks in CI | Release owner |
| `FIREBASE_TESTERS` | CSV emails | Firebase delivery | None | Secret or nonsecret Environment value > absent | Optional secret-backed | Provider syntax; do not log if treated as sensitive | Tester owner |
| `FIREBASE_TESTER_GROUPS` | CSV aliases | Firebase delivery | None | Secret or nonsecret Environment value > absent | Optional secret-backed | Provider group aliases | Tester owner |
| `FIREBASE_APP_ID` | Firebase app ID | Firebase doctor/deploy | None | Environment secret or documented nonsecret variable | Optional secret-backed; required runtime value for Firebase | Match package mapping in `google-services.json`, or require confirmation if evidence is absent | Firebase owner |

The workflow is manual-only by default. A GitHub Release is allowed only after the user explicitly sets repository variable `ENABLE_GITHUB_RELEASE_DEPLOY=true`; its immutable contract is Play/internal/completed in `play-store-nonproduction`. Set `ENABLE_GITHUB_RELEASE_SLACK_NOTIFICATION=true` separately to authorize its Slack message. Only a confirmed manual production run routes to `play-store-production`. Reviewer and tag protection are external GitHub settings that file validation cannot prove.

## Credentials and signing

| Variable | Type | Context | Default | Precedence | Secrecy | Validation | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ANDROID_KEY_PROPERTIES_PATH` | Absolute file path | local/CI signing | Local `android/key.properties` only outside CI | Private override > raw inputs > local default | Nonsecret path; file contents secret | Regular mode-0600 file in non-symlink mode-0700 directory; complete properties and absolute nonempty keystore | Signing owner/Fastlane |
| `ANDROID_KEYSTORE_PATH` | Absolute file path | local signing | None | Path > Base64; superseded by properties override | Nonsecret path; file secret | Safe nonempty regular file | Signing owner |
| `ANDROID_KEYSTORE_BASE64` | Base64 bytes | CI signing | None | Used only when path is absent | Required secret for every CI target | Strict canonical no-wrap Base64; decoded file must be nonempty | Signing owner |
| `ANDROID_KEYSTORE_PASSWORD` | String | signing | None | Properties override or explicit secret | Required secret for raw/CI signing | Nonempty; never logged | Signing owner |
| `ANDROID_KEY_ALIAS` | String | signing | None | Properties override or explicit secret | Required secret for raw/CI signing | Nonempty and present in keystore | Signing owner |
| `ANDROID_KEY_PASSWORD` | String | signing | None | Properties override or explicit secret | Required secret for raw/CI signing | Nonempty; never logged | Signing owner |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH` | Absolute/contained file path | Play doctor/deploy | `android/fastlane/google-play-service-account.json` | Path > Base64 > default | Nonsecret path; JSON secret | Safe regular JSON with service-account type, client email, and private key | Play account owner/Fastlane |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64` | Base64 JSON | Play CI/deploy | None | Used when explicit path is absent | Required secret for Play targets | Canonical no-wrap Base64 and complete service-account JSON | Play account owner |
| `FIREBASE_SERVICE_ACCOUNT_JSON_PATH` | Absolute/contained file path | Firebase doctor/deploy | `android/fastlane/firebase-service-account.json` | Path > Base64 > default | Nonsecret path; JSON secret | Safe regular JSON with service-account type, client email, and private key | Firebase owner/Fastlane |
| `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` | Base64 JSON | Firebase CI/deploy | None | Used when explicit path is absent | Required secret for Firebase targets | Canonical no-wrap Base64 and complete service-account JSON | Firebase owner |

The five every-target GitHub secrets are `APP_PACKAGE_NAME`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Add Play or Firebase service-account Base64 only for the selected target. Keep the two credentials separate and grant least privilege.

## Results and Slack

| Variable | Type | Context | Default | Precedence | Secrecy | Validation | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RELEASE_RESULT_PATH` | File path | release coordinator/CI | None; CI uses runner temporary JSON | Explicit env > no file | Nonsecret | Parent is writable; output is atomic mode 0600 JSON | Fastlane/workflow |
| `SLACK_WEBHOOK_URL` | URL | optional notification | None | Approved secret store > absent/skip | Optional secret-backed | HTTPS webhook; never printed | Slack owner |
| `CONFIRM_SLACK_NOTIFICATION` | Boolean authorization | Slack send | `false` | Exact per-run input; release events use their separate standing authorization | Nonsecret | Exact `true`; never inferred | User/release approver |
| `SLACK_NOTIFY_SUCCESS` | Boolean | Fastlane-owned Slack | `true` | Explicit env > default | Nonsecret | `true` or `false` | Release owner |
| `SLACK_NOTIFY_FAILURE` | Boolean | Fastlane-owned Slack | `true` | Explicit env > default | Nonsecret | `true` or `false` | Release owner |
| `SLACK_NOTIFICATION_OWNER` | Enum | local/CI notification | `fastlane`; CI sets `github-actions` | Explicit coordinator value | Nonsecret | `fastlane` or `github-actions`; only one sender | Workflow owner |
| `RUN_URL` | URL | Slack payload | Derived from GitHub context | Explicit env > derived URL > empty | Nonsecret | Safe link text only | Workflow/Fastlane |
| `SOURCE_URL` | URL | Slack payload | Derived commit URL | Explicit env > derived URL > empty | Nonsecret | Safe link text only | Workflow/Fastlane |

Slack failure must not mask the primary build or delivery result. The payload contains only repository, version, track, result, run URL, and source URL.

Every `CONFIRM_*` authorization variable requires the exact lowercase string `true`. Do not treat `1`, `yes`, `on`, uppercase variants, surrounding whitespace, or native booleans passed directly to the Fastlane helper as confirmation. Ordinary preference flags may retain their documented boolean parsing.

For a retry after an unknown upload result, set `RETRY_UNKNOWN_UPLOAD=true` only on a fresh run after reconciling the provider. Require `CONFIRM_UPLOAD_RECONCILED=true` and the five exact `RECONCILED_*` tuple fields above. The runtime first requires the allocated code to equal `RECONCILED_VERSION_CODE`, then hashes the newly built artifact and requires it to equal `RECONCILED_ARTIFACT_SHA256`, all before any upload adapter. An unmarked fresh retry cannot be inferred, and `github.run_attempt > 1` is rejected. The tuple is an operator attestation about the prior provider result, not a persistence system: if the rebuild hash differs, recover the exact artifact or begin a new explicitly authorized release.

## System-provided context

These values are supplied by CI or the operating system, not user release configuration:

| Variable | Type | Context | Default | Precedence | Secrecy | Validation | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CI` | Boolean | signing safety | `false` | Runner environment | Nonsecret | Truthy value enables CI restrictions | CI provider |
| `GITHUB_ACTIONS` | Boolean | signing safety | `false` | GitHub runner | Nonsecret | Truthy value enables CI restrictions | GitHub |
| `GITHUB_SERVER_URL` | URL | result links | None | GitHub runner | Nonsecret | Used only with repository/run or SHA fields | GitHub |
| `GITHUB_REPOSITORY` | Owner/name | result links | None | GitHub runner | Nonsecret | Payload-safe text | GitHub |
| `GITHUB_RUN_ID` | Integer-like string | run link | None | GitHub runner | Nonsecret | Combined with GitHub URL and repository | GitHub |
| `GITHUB_SHA` | Commit SHA | source link | None | GitHub runner | Nonsecret | Combined with GitHub URL and repository | GitHub |

Do not copy the entire environment into logs, artifacts, Slack, or the result JSON.

## Base64 handling

Encoding is not encryption. Use the package encoder or platform-specific no-wrap Base64 commands and send the output directly to an approved secret store. Never commit, log, or echo decoded material. PowerShell users may encode a file with `[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\private\secret.json'))`; macOS uses `base64 -b 0`, and Linux uses `base64 -w 0`.
