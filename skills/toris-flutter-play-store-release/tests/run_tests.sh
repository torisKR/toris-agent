#!/usr/bin/env bash
# Run the canonical package contract and skill-specific test groups.

set -u

TESTS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_ROOT=$(CDPATH= cd -- "$TESTS_DIR/.." && pwd)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/toris-flutter-play-store-release-tests.XXXXXX") || {
  printf 'FAIL: could not create a temporary test directory\n' >&2
  exit 1
}

cleanup() {
  rm -rf -- "$TMP_ROOT"
}

trap cleanup EXIT HUP INT TERM

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_file() {
  relative_path=$1
  [ -f "$PACKAGE_ROOT/$relative_path" ] || fail "missing target: $relative_path"
  [ ! -L "$PACKAGE_ROOT/$relative_path" ] || fail "target must not be a symlink: $relative_path"
  [ -s "$PACKAGE_ROOT/$relative_path" ] || fail "empty target: $relative_path"
}

assert_executable() {
  relative_path=$1
  [ -x "$PACKAGE_ROOT/$relative_path" ] || fail "entrypoint is not executable: $relative_path"
}

assert_contains() {
  relative_path=$1
  expected=$2
  grep -F -- "$expected" "$PACKAGE_ROOT/$relative_path" >/dev/null 2>&1 ||
    fail "$relative_path does not contain: $expected"
}

assert_same_file() {
  expected=$1
  actual=$2
  description=$3

  if ! cmp -s "$expected" "$actual"; then
    diff -u "$expected" "$actual" >&2 || true
    fail "$description"
  fi
}

assert_empty_file() {
  actual=$1
  description=$2

  [ ! -s "$actual" ] || fail "$description"
}

assert_mode() {
  expected=$1
  actual_path=$2
  description=$3
  actual_mode=

  if actual_mode=$(stat -c '%a' "$actual_path" 2>/dev/null) &&
    case "$actual_mode" in *[!0-7]*|'') false ;; *) true ;; esac
  then
    :
  elif actual_mode=$(stat -f '%Lp' "$actual_path" 2>/dev/null) &&
    case "$actual_mode" in *[!0-7]*|'') false ;; *) true ;; esac
  then
    :
  else
    fail "could not determine file mode for $description"
  fi

  [ "$actual_mode" = "$expected" ] ||
    fail "$description (expected $expected, got $actual_mode)"
}

write_target_files() {
  cat > "$TMP_ROOT/target-files.txt" <<'FILES'
.skill-package-id
README.md
SKILL.md
agents/openai.yaml
install-manifest.txt
install.sh
references/environment-variables.md
references/execution-defaults.md
references/first-release-checklist.md
references/troubleshooting.md
scripts/bootstrap_android_fastlane.sh
scripts/decode_secret.sh
scripts/encode_secret.sh
scripts/inspect_flutter_project.sh
scripts/install_flutter_sdk.sh
scripts/lib/common.sh
scripts/lib/gradle_signing.sh
scripts/lib/package_sync.sh
scripts/lib/project_transaction.sh
scripts/validate_release_setup.sh
templates/Appfile
templates/Fastfile
templates/FlutterPlayStoreRelease.rb
templates/Gemfile
templates/Gemfile.lock
templates/PLAY_STORE_RELEASE.md
templates/Pluginfile
templates/env.example
templates/key.properties.example
templates/release-android.yml
tests/fastlane_helper_test.rb
tests/authorization_hardening_test.rb
tests/run_tests.sh
uninstall.sh
update.sh
FILES
}

inventory_package_files() {
  if ! (
    CDPATH= cd -- "$PACKAGE_ROOT" &&
      find . \( -type f -o -type l \) -print
  ) > "$TMP_ROOT/package-files-with-prefix.txt"; then
    fail 'could not inventory canonical package files'
  fi

  sed 's#^\./##' "$TMP_ROOT/package-files-with-prefix.txt" |
    LC_ALL=C sort > "$TMP_ROOT/actual-package-files.txt"

  # Runtime-generated fixtures are canonical-only test data, not package targets.
  grep -v '^tests/fixtures/' "$TMP_ROOT/actual-package-files.txt" \
    > "$TMP_ROOT/actual-declared-files.txt"
  LC_ALL=C sort -u "$TMP_ROOT/target-files.txt" \
    > "$TMP_ROOT/expected-declared-files.txt"

  missing_path=$(LC_ALL=C comm -23 \
    "$TMP_ROOT/expected-declared-files.txt" \
    "$TMP_ROOT/actual-declared-files.txt" | sed -n '1p')
  [ -z "$missing_path" ] || fail "missing target: $missing_path"

  unexpected_path=$(LC_ALL=C comm -13 \
    "$TMP_ROOT/expected-declared-files.txt" \
    "$TMP_ROOT/actual-declared-files.txt" | sed -n '1p')
  [ -z "$unexpected_path" ] || fail "unexpected package file: $unexpected_path"

  grep -v '^tests/' "$TMP_ROOT/actual-package-files.txt" \
    > "$TMP_ROOT/actual-runtime-files.txt"
}

package_contract() {
  write_target_files

  while IFS= read -r relative_path; do
    assert_file "$relative_path"
  done < "$TMP_ROOT/target-files.txt"
  inventory_package_files

  printf '%s\n' \
    'package_id=toris-flutter-play-store-release' \
    'schema_version=1' > "$TMP_ROOT/expected-package-id"
  assert_same_file \
    "$TMP_ROOT/expected-package-id" \
    "$PACKAGE_ROOT/.skill-package-id" \
    '.skill-package-id must contain the canonical package ID and schema only'

  cat > "$TMP_ROOT/expected-openai.yaml" <<'YAML'
interface:
  display_name: "Toris Flutter Play Store Release"
  short_description: "Automate safe Flutter releases to Google Play"
  default_prompt: "Use $toris-flutter-play-store-release to inspect this Flutter app, configure safe Android delivery, and verify the Google Play release setup."
YAML
  assert_same_file \
    "$TMP_ROOT/expected-openai.yaml" \
    "$PACKAGE_ROOT/agents/openai.yaml" \
    'agents/openai.yaml does not match the canonical interface metadata'

  [ "$(sed -n '1p' "$PACKAGE_ROOT/SKILL.md")" = '---' ] ||
    fail 'SKILL.md must start with YAML frontmatter'
  [ "$(sed -n '2p' "$PACKAGE_ROOT/SKILL.md")" = 'name: toris-flutter-play-store-release' ] ||
    fail 'SKILL.md frontmatter must declare the canonical name first'
  description_line=$(sed -n '3p' "$PACKAGE_ROOT/SKILL.md")
  case "$description_line" in
    'description: '[A-Za-z]*) ;;
    *) fail 'SKILL.md frontmatter must contain an English description second' ;;
  esac
  if LC_ALL=C printf '%s\n' "$description_line" | grep '[^ -~]' >/dev/null 2>&1; then
    fail 'SKILL.md frontmatter description must use English ASCII text'
  fi
  [ "$(sed -n '4p' "$PACKAGE_ROOT/SKILL.md")" = '---' ] ||
    fail 'SKILL.md frontmatter may contain only name and description'
  assert_contains 'SKILL.md' '## Quick start'
  assert_contains 'SKILL.md' '## Definition of done'

  unfinished_pattern='TO''DO|TB''D|FIX''ME|PLACE''HOLDER'
  while IFS= read -r relative_path; do
    if grep -E "$unfinished_pattern" "$PACKAGE_ROOT/$relative_path" >/dev/null 2>&1; then
      fail "unfinished marker found in target: $relative_path"
    fi
  done < "$TMP_ROOT/target-files.txt"

  for relative_path in \
    install.sh \
    update.sh \
    uninstall.sh \
    scripts/inspect_flutter_project.sh \
    scripts/bootstrap_android_fastlane.sh \
    scripts/validate_release_setup.sh \
    scripts/encode_secret.sh \
    scripts/decode_secret.sh \
    scripts/install_flutter_sdk.sh \
    tests/run_tests.sh
  do
    assert_executable "$relative_path"
  done

  LC_ALL=C sort "$PACKAGE_ROOT/install-manifest.txt" > "$TMP_ROOT/sorted-manifest.txt"
  assert_same_file \
    "$TMP_ROOT/sorted-manifest.txt" \
    "$PACKAGE_ROOT/install-manifest.txt" \
    'install-manifest.txt is not sorted lexically'

  LC_ALL=C sort -u "$PACKAGE_ROOT/install-manifest.txt" > "$TMP_ROOT/unique-manifest.txt"
  assert_same_file \
    "$TMP_ROOT/unique-manifest.txt" \
    "$PACKAGE_ROOT/install-manifest.txt" \
    'install-manifest.txt contains duplicate entries'

  if grep -E '(^|/)(tests|fixtures)(/|$)' "$PACKAGE_ROOT/install-manifest.txt" >/dev/null 2>&1; then
    fail 'install-manifest.txt must exclude tests and fixtures'
  fi

  if grep -E '(^|/)(\.git|\.svn|\.hg|\.idea|\.vscode|__pycache__|\.pytest_cache|\.dart_tool|node_modules|build|dist)(/|$)|(^|/)\.env($|\.)|(^|/)[^/]*(\.jks|\.keystore|\.p12|\.pem|\.key)$' "$PACKAGE_ROOT/install-manifest.txt" >/dev/null 2>&1; then
    fail 'install-manifest.txt contains VCS, cache, editor, generated, or secret-shaped paths'
  fi

  assert_same_file \
    "$TMP_ROOT/actual-runtime-files.txt" \
    "$PACKAGE_ROOT/install-manifest.txt" \
    'install-manifest.txt must exactly match the actual runtime file inventory'

  while IFS= read -r relative_path; do
    case "$relative_path" in
      *.sh) bash -n "$PACKAGE_ROOT/$relative_path" || fail "invalid shell syntax: $relative_path" ;;
    esac
  done < "$TMP_ROOT/target-files.txt"

  sed -n '/^if \[ "$#" -eq 0 \]/,/^else$/p' "$PACKAGE_ROOT/tests/run_tests.sh" \
    | grep -Fx '  installation' >/dev/null 2>&1 ||
    fail 'default/all test dispatch omitted the installation group'

  if grep -E '^[[:space:]]*set [+-]e([[:space:]]|$)' \
    "$PACKAGE_ROOT/tests/run_tests.sh" >/dev/null 2>&1
  then
    fail 'test helpers must preserve the caller errexit state'
  fi

  pass 'package_contract'
}

secret_codecs_helpers() {
  for helper in \
    fprs_die \
    fprs_warn \
    fprs_info \
    fprs_require_arg \
    fprs_realpath \
    fprs_sha256 \
    fprs_mktemp_dir \
    fprs_file_mode \
    fprs_json_escape \
    fprs_is_truthy \
    fprs_cleanup_dir
  do
    bash -c '. "$1"; command -v "$2" >/dev/null 2>&1' sh "$COMMON" "$helper" ||
      fail "common helper is unavailable: $helper"
  done

  printf 'abc' > "$CODEC_ROOT/sha input"
  helper_sha=$(bash -c '. "$1"; fprs_sha256 "$2"' sh "$COMMON" "$CODEC_ROOT/sha input") ||
    fail 'fprs_sha256 rejected a readable file'
  [ "$helper_sha" = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' ] ||
    fail 'fprs_sha256 did not return the SHA-256 payload only'

  mkdir -p "$CODEC_ROOT/real path/child"
  expected_realpath=$(CDPATH= cd -- "$CODEC_ROOT/real path" && pwd -P)/future.txt
  helper_realpath=$(bash -c '. "$1"; fprs_realpath "$2"' sh "$COMMON" "$CODEC_ROOT/real path/child/../future.txt") ||
    fail 'fprs_realpath rejected a path with spaces and a nonexistent leaf'
  [ "$helper_realpath" = "$expected_realpath" ] ||
    fail 'fprs_realpath did not normalize the parent path physically'

  helper_json=$(bash -c '. "$1"; fprs_json_escape "$2"' sh "$COMMON" 'quote" slash\ line
	tab') || fail 'fprs_json_escape rejected control characters'
  [ "$helper_json" = 'quote\" slash\\ line\n\ttab' ] ||
    fail 'fprs_json_escape did not escape JSON metacharacters and controls'

  bash -c '. "$1"; fprs_is_truthy "YeS"' sh "$COMMON" ||
    fail 'fprs_is_truthy rejected a mixed-case truthy value'
  if bash -c '. "$1"; fprs_is_truthy "no"' sh "$COMMON"; then
    fail 'fprs_is_truthy accepted a false value'
  fi

  helper_temp=$(bash -c '
    . "$1"
    helper_temp=$(fprs_mktemp_dir codec-helper "$2") || exit
    printf private > "$helper_temp/private file" || exit
    printf "%s\n" "$helper_temp"
  ' sh "$COMMON" "$CODEC_ROOT") ||
    fail 'fprs_mktemp_dir could not create a private directory'
  [ -d "$helper_temp" ] || fail 'fprs_mktemp_dir did not return a directory'
  assert_mode '700' "$helper_temp" 'fprs_mktemp_dir mode'
  assert_mode '600' "$helper_temp/private file" 'umask inherited from common helpers'
  bash -c '. "$1"; fprs_cleanup_dir "$2"' sh "$COMMON" "$helper_temp" ||
    fail 'fprs_cleanup_dir rejected an owned temporary directory'
  [ ! -e "$helper_temp" ] || fail 'fprs_cleanup_dir did not remove its target'
  if bash -c '. "$1"; fprs_cleanup_dir /' sh "$COMMON"; then
    fail 'fprs_cleanup_dir accepted the filesystem root'
  fi

  printf 'mode' > "$CODEC_ROOT/mode file"
  chmod 640 "$CODEC_ROOT/mode file"
  helper_mode=$(bash -c '. "$1"; fprs_file_mode "$2"' sh "$COMMON" "$CODEC_ROOT/mode file") ||
    fail 'fprs_file_mode rejected a readable file'
  [ "$helper_mode" = '640' ] || fail 'fprs_file_mode returned the wrong mode'

  bash -c '. "$1"; fprs_require_arg --input "$2"' sh "$COMMON" "$CODEC_ROOT/sha input" ||
    fail 'fprs_require_arg rejected a present argument'
  if bash -c '. "$1"; fprs_require_arg --input ""' sh "$COMMON" \
    > "$CODEC_ROOT/require.stdout" 2> "$CODEC_ROOT/require.stderr"
  then
    fail 'fprs_require_arg accepted an empty argument'
  fi
  assert_empty_file "$CODEC_ROOT/require.stdout" 'fprs_require_arg wrote diagnostics to stdout'

  bash -c '. "$1"; fprs_info ready; fprs_warn careful' sh "$COMMON" \
    > "$CODEC_ROOT/log.stdout" 2> "$CODEC_ROOT/log.stderr" ||
    fail 'common logging helpers failed'
  : > "$CODEC_ROOT/expected-log.stdout"
  printf 'INFO: ready\nWARNING: careful\n' > "$CODEC_ROOT/expected-log.stderr"
  assert_same_file "$CODEC_ROOT/expected-log.stdout" "$CODEC_ROOT/log.stdout" 'logging helpers wrote to stdout'
  assert_same_file "$CODEC_ROOT/expected-log.stderr" "$CODEC_ROOT/log.stderr" 'fprs_warn output changed'
  if bash -c '. "$1"; fprs_die stopped' sh "$COMMON" \
    > "$CODEC_ROOT/die.stdout" 2> "$CODEC_ROOT/die.stderr"
  then
    fail 'fprs_die returned success'
  fi
  assert_empty_file "$CODEC_ROOT/die.stdout" 'fprs_die wrote diagnostics to stdout'
}

secret_codecs_round_trips() {
  printf 'portable release secret\n' > "$CODEC_ROOT/text input"
  "$ENCODER" --input "$CODEC_ROOT/text input" \
    > "$CODEC_ROOT/text encoded" 2> "$CODEC_ROOT/text encode.stderr" ||
    fail 'file-to-stdout encoding failed'
  assert_empty_file "$CODEC_ROOT/text encode.stderr" 'successful encoding wrote to stderr'
  [ "$(wc -l < "$CODEC_ROOT/text encoded" | tr -d '[:space:]')" = '1' ] ||
    fail 'encoded payload was wrapped across multiple lines'
  [ "$(tail -c 1 "$CODEC_ROOT/text encoded" | wc -l | tr -d '[:space:]')" = '1' ] ||
    fail 'encoded payload did not end with exactly one newline'
  "$DECODER" --input "$CODEC_ROOT/text encoded" \
    > "$CODEC_ROOT/text decoded" 2> "$CODEC_ROOT/text decode.stderr" ||
    fail 'file-to-stdout decoding failed'
  assert_same_file "$CODEC_ROOT/text input" "$CODEC_ROOT/text decoded" 'text round trip changed bytes'
  assert_empty_file "$CODEC_ROOT/text decode.stderr" 'successful decoding wrote to stderr'

  printf '\000\001\002\177\200\377binary\nbytes\000' > "$CODEC_ROOT/binary input"
  printf 'stale encoded output' > "$CODEC_ROOT/binary encoded"
  chmod 644 "$CODEC_ROOT/binary encoded"
  printf 'unchanged' > "$CODEC_ROOT/binary output"
  (umask 000; "$ENCODER" --input - --output "$CODEC_ROOT/binary encoded" \
    < "$CODEC_ROOT/binary input") \
    > "$CODEC_ROOT/binary encode.stdout" 2> "$CODEC_ROOT/binary encode.stderr" ||
    fail 'stdin-to-file encoding failed'
  assert_empty_file "$CODEC_ROOT/binary encode.stdout" 'file encoding emitted payload to stdout'
  assert_mode '600' "$CODEC_ROOT/binary encoded" 'replaced encoded output mode'
  (umask 000; "$DECODER" --input "$CODEC_ROOT/binary encoded" --output "$CODEC_ROOT/binary output") \
    > "$CODEC_ROOT/binary decode.stdout" 2> "$CODEC_ROOT/binary decode.stderr" ||
    fail 'file-to-file binary decoding failed'
  assert_empty_file "$CODEC_ROOT/binary decode.stdout" 'file decoding emitted payload to stdout'
  assert_same_file "$CODEC_ROOT/binary input" "$CODEC_ROOT/binary output" 'binary round trip changed bytes'
  assert_mode '600' "$CODEC_ROOT/binary output" 'replaced decoded output mode'

  mkdir -p "$CODEC_ROOT/path with spaces"
  cp "$CODEC_ROOT/binary input" "$CODEC_ROOT/path with spaces/input secret"
  "$ENCODER" --input "$CODEC_ROOT/path with spaces/input secret" \
    --output "$CODEC_ROOT/path with spaces/encoded secret" ||
    fail 'encoding paths with spaces failed'
  "$DECODER" --input - --output "$CODEC_ROOT/path with spaces/decoded secret" \
    < "$CODEC_ROOT/path with spaces/encoded secret" ||
    fail 'decoding paths with spaces failed'
  assert_same_file \
    "$CODEC_ROOT/path with spaces/input secret" \
    "$CODEC_ROOT/path with spaces/decoded secret" \
    'path-with-spaces round trip changed bytes'
  assert_mode '600' "$CODEC_ROOT/path with spaces/decoded secret" 'new decoded output mode'

  printf '' | "$ENCODER" > "$CODEC_ROOT/empty encoded" 2> "$CODEC_ROOT/empty encode.stderr" ||
    fail 'empty stdin encoding failed'
  printf '\n' > "$CODEC_ROOT/expected empty encoding"
  assert_same_file \
    "$CODEC_ROOT/expected empty encoding" \
    "$CODEC_ROOT/empty encoded" \
    'empty input did not encode as one empty line'
  printf '' > "$CODEC_ROOT/empty output"
  "$DECODER" --input - --output "$CODEC_ROOT/empty output" \
    < "$CODEC_ROOT/empty encoded" || fail 'empty input decoding failed'
  assert_empty_file "$CODEC_ROOT/empty output" 'empty decode produced bytes'
  assert_mode '600' "$CODEC_ROOT/empty output" 'empty decoded output mode'

  printf ' aG\tVs\nbG\r8=\v\f' > "$CODEC_ROOT/wrapped input"
  "$DECODER" --input "$CODEC_ROOT/wrapped input" > "$CODEC_ROOT/wrapped output" ||
    fail 'ASCII-whitespace-wrapped input was rejected'
  printf 'hello' > "$CODEC_ROOT/expected hello"
  assert_same_file "$CODEC_ROOT/expected hello" "$CODEC_ROOT/wrapped output" 'wrapped decode changed bytes'

  cp "$CODEC_ROOT/wrapped input" "$CODEC_ROOT/wrapped input.before"
  "$DECODER" --input "$CODEC_ROOT/wrapped input" > /dev/null ||
    fail 'explicit wrapped input could not be decoded twice'
  assert_same_file \
    "$CODEC_ROOT/wrapped input.before" \
    "$CODEC_ROOT/wrapped input" \
    'successful decode modified explicit input'
  cp "$CODEC_ROOT/binary input" "$CODEC_ROOT/binary input.before"
  "$ENCODER" --input "$CODEC_ROOT/binary input" > /dev/null ||
    fail 'explicit binary input could not be encoded twice'
  assert_same_file \
    "$CODEC_ROOT/binary input.before" \
    "$CODEC_ROOT/binary input" \
    'successful encode modified explicit input'
}

secret_codecs_strictness() {
  printf 'keep-this-output' > "$CODEC_ROOT/existing output"
  chmod 644 "$CODEC_ROOT/existing output"
  cp "$CODEC_ROOT/existing output" "$CODEC_ROOT/existing output.before"
  for invalid_case in invalid-alphabet truncated-padding middle-padding excess-padding noncanonical-padding
  do
    case "$invalid_case" in
      invalid-alphabet) invalid_payload='Zm9v_CANARY_CODEC!' ;;
      truncated-padding) invalid_payload='Zg=' ;;
      middle-padding) invalid_payload='Z=g=' ;;
      excess-padding) invalid_payload='Z===' ;;
      noncanonical-padding) invalid_payload='Zh==' ;;
    esac
    printf '%s' "$invalid_payload" > "$CODEC_ROOT/$invalid_case.input"
    cp "$CODEC_ROOT/$invalid_case.input" "$CODEC_ROOT/$invalid_case.before"
    if "$DECODER" --input "$CODEC_ROOT/$invalid_case.input" --output "$CODEC_ROOT/existing output" \
      > "$CODEC_ROOT/$invalid_case.stdout" 2> "$CODEC_ROOT/$invalid_case.stderr"
    then
      fail "invalid Base64 was accepted: $invalid_case"
    else
      invalid_status=$?
    fi
    [ "$invalid_status" -eq 1 ] ||
      fail "invalid Base64 did not use exit 1: $invalid_case"
    assert_empty_file "$CODEC_ROOT/$invalid_case.stdout" "invalid decode emitted payload: $invalid_case"
    assert_same_file \
      "$CODEC_ROOT/$invalid_case.before" \
      "$CODEC_ROOT/$invalid_case.input" \
      "failed decode modified explicit input: $invalid_case"
    assert_same_file \
      "$CODEC_ROOT/existing output.before" \
      "$CODEC_ROOT/existing output" \
      "failed decode replaced prior output: $invalid_case"
    if grep -F 'CANARY_CODEC' "$CODEC_ROOT/$invalid_case.stderr" >/dev/null 2>&1; then
      fail "failed decode exposed secret content on stderr: $invalid_case"
    fi
  done
  assert_mode '644' "$CODEC_ROOT/existing output" 'failed decode changed prior output mode'

  printf 'same-file-secret' > "$CODEC_ROOT/same input"
  cp "$CODEC_ROOT/same input" "$CODEC_ROOT/same input.before"
  if "$ENCODER" --input "$CODEC_ROOT/same input" --output "$CODEC_ROOT/same input" \
    > "$CODEC_ROOT/same.stdout" 2> "$CODEC_ROOT/same.stderr"
  then
    fail 'encoder accepted identical input and output'
  else
    same_status=$?
  fi
  [ "$same_status" -eq 2 ] || fail 'encoder did not use exit 2 for a refused same path'
  assert_same_file "$CODEC_ROOT/same input.before" "$CODEC_ROOT/same input" 'same-path refusal modified input'

  ln "$CODEC_ROOT/same input" "$CODEC_ROOT/same hardlink"
  if "$DECODER" --input "$CODEC_ROOT/same input" --output "$CODEC_ROOT/same hardlink" \
    > /dev/null 2> "$CODEC_ROOT/hardlink.stderr"
  then
    fail 'decoder accepted hard-linked input and output'
  else
    hardlink_status=$?
  fi
  [ "$hardlink_status" -eq 2 ] || fail 'decoder did not use exit 2 for a same-file alias'
  assert_same_file "$CODEC_ROOT/same input.before" "$CODEC_ROOT/same input" 'same-file alias refusal modified input'

  mkdir -p "$CODEC_ROOT/alias child"
  printf 'YWxpYXM=' > "$CODEC_ROOT/alias input"
  alias_spelling="$CODEC_ROOT/alias child/../alias input"
  if "$DECODER" --input "$CODEC_ROOT/alias input" --output "$alias_spelling" \
    > /dev/null 2> "$CODEC_ROOT/alias.stderr"
  then
    fail 'decoder accepted a lexical same-path alias'
  else
    alias_status=$?
  fi
  [ "$alias_status" -eq 2 ] || fail 'lexical same-path alias did not use exit 2'

  printf 'argument-secret' > "$CODEC_ROOT/argument input"
  cp "$CODEC_ROOT/argument input" "$CODEC_ROOT/argument input.before"
  for codec_command in "$ENCODER" "$DECODER"
  do
    codec_name=$(basename "$codec_command")
    for argument_case in duplicate-input duplicate-output missing-value positional unknown
    do
      case "$argument_case" in
        duplicate-input)
          set -- --input "$CODEC_ROOT/argument input" --input - ;;
        duplicate-output)
          set -- --output - --output "$CODEC_ROOT/argument output" ;;
        missing-value)
          set -- --input ;;
        positional)
          set -- "$CODEC_ROOT/argument input" ;;
        unknown)
          set -- --wat ;;
      esac
      if "$codec_command" "$@" > "$CODEC_ROOT/$codec_name-$argument_case.stdout" \
        2> "$CODEC_ROOT/$codec_name-$argument_case.stderr"
      then
        fail "ambiguous or invalid arguments were accepted by $codec_name: $argument_case"
      else
        argument_status=$?
      fi
      [ "$argument_status" -eq 2 ] ||
        fail "argument error did not use exit 2 in $codec_name: $argument_case"
      assert_empty_file \
        "$CODEC_ROOT/$codec_name-$argument_case.stdout" \
        "argument error wrote to stdout in $codec_name: $argument_case"
    done
  done
  assert_same_file \
    "$CODEC_ROOT/argument input.before" \
    "$CODEC_ROOT/argument input" \
    'argument parsing modified explicit input'

  redaction_raw='FPRS_RAW_SECRET_CANARY_7d06d4'
  redaction_encoded='RlBSU19SQVdfU0VDUkVUX0NBTkFSWV83ZDA2ZDQ='
  mkdir -p "$CODEC_ROOT/redaction logs" "$CODEC_ROOT/redaction shim"
  cat > "$CODEC_ROOT/redaction shim/base64" <<'SH'
#!/bin/sh
case "${1-}" in
  -w|-b)
    [ "${2-}" = 0 ] || exit 64
    payload=$(cat)
    if [ -z "$payload" ]; then
      exit 0
    fi
    printf '%s' "$payload"
    printf '%s' "$payload" >&2
    exit 70
    ;;
  *) exit 64 ;;
esac
SH
  chmod +x "$CODEC_ROOT/redaction shim/base64"

  redaction_index=0
  for redaction_payload in "$redaction_raw" "$redaction_encoded"
  do
    redaction_index=$((redaction_index + 1))
    if printf '%s' "$redaction_payload" | PATH="$CODEC_ROOT/redaction shim:$PATH" "$ENCODER" \
      > "$CODEC_ROOT/redaction logs/encode-$redaction_index.stdout" \
      2> "$CODEC_ROOT/redaction logs/encode-$redaction_index.stderr"
    then
      fail 'encoder redaction failure probe unexpectedly succeeded'
    else
      redaction_status=$?
    fi
    [ "$redaction_status" -eq 1 ] || fail 'encoder redaction probe did not use exit 1'
  done

  redaction_index=0
  for redaction_payload in "$redaction_raw" "$redaction_encoded"
  do
    redaction_index=$((redaction_index + 1))
    if printf '%s!' "$redaction_payload" | "$DECODER" \
      > "$CODEC_ROOT/redaction logs/decode-$redaction_index.stdout" \
      2> "$CODEC_ROOT/redaction logs/decode-$redaction_index.stderr"
    then
      fail 'decoder redaction failure probe unexpectedly succeeded'
    else
      redaction_status=$?
    fi
    [ "$redaction_status" -eq 1 ] || fail 'decoder redaction probe did not use exit 1'
  done

  for redaction_log in "$CODEC_ROOT/redaction logs"/*.stdout
  do
    assert_empty_file "$redaction_log" 'secret codec failure emitted a payload'
  done
  for redaction_log in "$CODEC_ROOT/redaction logs"/*.stdout "$CODEC_ROOT/redaction logs"/*.stderr
  do
    if grep -F "$redaction_raw" "$redaction_log" >/dev/null 2>&1 ||
      grep -F "$redaction_encoded" "$redaction_log" >/dev/null 2>&1
    then
      fail 'secret codec failure logs exposed a unique canary'
    fi
  done

  if grep -E '(^|[[:space:]])set[[:space:]]+(-[^[:space:]]*x|-o[[:space:]]+xtrace)|^#!.*[[:space:]]+-[^[:space:]]*x' \
    "$COMMON" "$ENCODER" "$DECODER" >/dev/null 2>&1
  then
    fail 'secret codec scripts enable shell tracing'
  fi
}

secret_codecs_publication_races() {
  race_real_base64=$(command -v base64) || fail 'base64 is required for publication race tests'
  mkdir -p "$CODEC_ROOT/publication race/shim"
  cat > "$CODEC_ROOT/publication race/shim/base64" <<'SH'
#!/bin/sh
if [ ! -e "$FPRS_RACE_OUTPUT" ]; then
  mkdir "$FPRS_RACE_OUTPUT" || exit 70
fi
exec "$FPRS_REAL_BASE64" "$@"
SH
  chmod +x "$CODEC_ROOT/publication race/shim/base64"

  for race_codec in encode decode
  do
    race_output="$CODEC_ROOT/publication race/$race_codec target"
    case "$race_codec" in
      encode)
        race_command=$ENCODER
        race_input="$CODEC_ROOT/text input"
        ;;
      decode)
        race_command=$DECODER
        race_input="$CODEC_ROOT/text encoded"
        ;;
    esac

    if PATH="$CODEC_ROOT/publication race/shim:$PATH" \
      FPRS_REAL_BASE64="$race_real_base64" FPRS_RACE_OUTPUT="$race_output" \
      "$race_command" --input "$race_input" --output "$race_output" \
      > "$CODEC_ROOT/publication race/$race_codec.stdout" \
      2> "$CODEC_ROOT/publication race/$race_codec.stderr"
    then
      fail "$race_codec accepted a publication directory race"
    else
      race_status=$?
    fi
    [ "$race_status" -eq 1 ] || fail "$race_codec publication race did not use exit 1"
    assert_empty_file \
      "$CODEC_ROOT/publication race/$race_codec.stdout" \
      "$race_codec publication race emitted a payload"
    [ -d "$race_output" ] || fail "$race_codec publication race fixture was not injected"
    race_leak=$(find "$race_output" -mindepth 1 -print | sed -n '1p')
    [ -z "$race_leak" ] || fail "$race_codec left secret data under an injected directory"
  done

  race_leftover=$(find "$CODEC_ROOT/publication race" -type d -name '.fprs-secret-codec.*' \
    -print | sed -n '1p')
  [ -z "$race_leftover" ] || fail 'publication race left an invocation-owned directory'
  pass 'publication_race_regression'
}

secret_codec_signal_case() {
  signal_name=$1
  signal_codec_name=$2
  signal_root="$CODEC_ROOT/signal $signal_codec_name $signal_name"
  signal_fifo="$signal_root/input"
  signal_output="$signal_root/output"
  mkdir -p "$signal_root"
  mkdir "$signal_root/.fprs-secret-codec.keep"
  printf 'pre-existing-lookalike' > "$signal_root/.fprs-secret-codec.keep/sentinel"
  mkfifo "$signal_fifo"

  case "$signal_codec_name" in
    encode)
      signal_command=$ENCODER
      signal_prefix='signal-encode-input'
      ;;
    decode)
      signal_command=$DECODER
      signal_prefix='Zm9v'
      printf 'preserve-decoder-output' > "$signal_output"
      chmod 640 "$signal_output"
      cp "$signal_output" "$signal_output.before"
      ;;
    *) fail 'unknown signal codec fixture' ;;
  esac

  (printf '%s' "$signal_prefix"; while :; do :; done) > "$signal_fifo" &
  signal_writer=$!
  python3 -c '
import os
import signal
import sys
for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, signal.SIG_DFL)
os.execv(sys.argv[1], sys.argv[1:])
' "$signal_command" --input "$signal_fifo" --output "$signal_output" \
    > "$signal_root/stdout" 2> "$signal_root/stderr" &
  signal_codec=$!

  signal_ready=false
  signal_attempt=0
  while [ "$signal_attempt" -lt 100 ]; do
    if find "$signal_root" -type d -name '.fprs-secret-codec.*' \
      ! -name '.fprs-secret-codec.keep' -print |
      grep . >/dev/null 2>&1
    then
      signal_ready=true
      break
    fi
    signal_attempt=$((signal_attempt + 1))
    sleep 0.02
  done
  if [ "$signal_ready" != true ]; then
    kill -TERM "$signal_codec" "$signal_writer" >/dev/null 2>&1 || true
    wait "$signal_codec" >/dev/null 2>&1 || true
    wait "$signal_writer" >/dev/null 2>&1 || true
    fail "$signal_name signal test could not observe $signal_codec_name staging"
  fi

  kill -"$signal_name" "$signal_codec" >/dev/null 2>&1 || true
  kill -TERM "$signal_writer" >/dev/null 2>&1 || true
  if wait "$signal_codec"; then
    wait "$signal_writer" >/dev/null 2>&1 || true
    fail "$signal_name-interrupted $signal_codec_name returned success"
  else
    signal_status=$?
  fi
  wait "$signal_writer" >/dev/null 2>&1 || true

  [ "$signal_status" -eq 1 ] ||
    fail "$signal_name-interrupted $signal_codec_name did not use exit 1"
  assert_empty_file "$signal_root/stdout" "$signal_name-interrupted $signal_codec_name emitted payload"
  signal_leftover=$(find "$signal_root" -type d -name '.fprs-secret-codec.*' \
    ! -name '.fprs-secret-codec.keep' -print | sed -n '1p')
  [ -z "$signal_leftover" ] ||
    fail "$signal_name-interrupted $signal_codec_name left a temporary directory"
  [ -f "$signal_root/.fprs-secret-codec.keep/sentinel" ] ||
    fail "$signal_name-interrupted $signal_codec_name removed a pre-existing lookalike"

  case "$signal_codec_name" in
    encode)
      [ ! -e "$signal_output" ] ||
        fail "$signal_name-interrupted encoder published an explicit output"
      ;;
    decode)
      assert_same_file \
        "$signal_output.before" \
        "$signal_output" \
        "$signal_name-interrupted decoder changed prior output"
      assert_mode '640' "$signal_output" "$signal_name-interrupted decoder changed prior output mode"
      ;;
  esac
}

secret_codecs_platform_and_cleanup() {
  command -v python3 >/dev/null 2>&1 || fail 'python3 is required for codec publication tests'
  real_base64=$(command -v base64) || fail 'base64 is required for codec tests'
  if printf '' | "$real_base64" --decode >/dev/null 2>&1; then
    real_decode_flag=--decode
  elif printf '' | "$real_base64" -D >/dev/null 2>&1; then
    real_decode_flag=-D
  elif printf '' | "$real_base64" -d >/dev/null 2>&1; then
    real_decode_flag=-d
  else
    fail 'test runner could not identify the platform Base64 decode flag'
  fi

  mkdir -p "$CODEC_ROOT/bsd shim"
  cat > "$CODEC_ROOT/bsd shim/base64" <<'SH'
#!/bin/sh
case "${1-}" in
  -b)
    [ "${2-}" = 0 ] || exit 64
    shift 2
    "$FPRS_REAL_BASE64" | tr -d '\r\n'
    ;;
  -D)
    shift
    "$FPRS_REAL_BASE64" "$FPRS_REAL_DECODE_FLAG" "$@"
    ;;
  *) exit 64 ;;
esac
SH
  chmod +x "$CODEC_ROOT/bsd shim/base64"
  printf 'forced BSD flavor' > "$CODEC_ROOT/bsd input"
  PATH="$CODEC_ROOT/bsd shim:$PATH" \
    FPRS_REAL_BASE64="$real_base64" FPRS_REAL_DECODE_FLAG="$real_decode_flag" \
    "$ENCODER" --input "$CODEC_ROOT/bsd input" > "$CODEC_ROOT/bsd encoded" ||
    fail 'encoder did not detect BSD Base64 flags'
  PATH="$CODEC_ROOT/bsd shim:$PATH" \
    FPRS_REAL_BASE64="$real_base64" FPRS_REAL_DECODE_FLAG="$real_decode_flag" \
    "$DECODER" --input "$CODEC_ROOT/bsd encoded" > "$CODEC_ROOT/bsd output" ||
    fail 'decoder did not detect BSD Base64 flags'
  assert_same_file "$CODEC_ROOT/bsd input" "$CODEC_ROOT/bsd output" 'BSD Base64 round trip changed bytes'

  mkdir -p "$CODEC_ROOT/gnu shim"
  cat > "$CODEC_ROOT/gnu shim/base64" <<'SH'
#!/bin/sh
case "${1-}" in
  -w)
    [ "${2-}" = 0 ] || exit 64
    shift 2
    "$FPRS_REAL_BASE64" | tr -d '\r\n'
    ;;
  --decode)
    shift
    "$FPRS_REAL_BASE64" "$FPRS_REAL_DECODE_FLAG" "$@"
    ;;
  *) exit 64 ;;
esac
SH
  chmod +x "$CODEC_ROOT/gnu shim/base64"
  PATH="$CODEC_ROOT/gnu shim:$PATH" \
    FPRS_REAL_BASE64="$real_base64" FPRS_REAL_DECODE_FLAG="$real_decode_flag" \
    "$ENCODER" --input "$CODEC_ROOT/bsd input" > "$CODEC_ROOT/gnu encoded" ||
    fail 'encoder did not detect GNU Base64 flags'
  PATH="$CODEC_ROOT/gnu shim:$PATH" \
    FPRS_REAL_BASE64="$real_base64" FPRS_REAL_DECODE_FLAG="$real_decode_flag" \
    "$DECODER" --input "$CODEC_ROOT/gnu encoded" > "$CODEC_ROOT/gnu output" ||
    fail 'decoder did not detect GNU Base64 flags'
  assert_same_file "$CODEC_ROOT/bsd input" "$CODEC_ROOT/gnu output" 'GNU Base64 round trip changed bytes'

  mkdir -p "$CODEC_ROOT/failing shim"
  cat > "$CODEC_ROOT/failing shim/base64" <<'SH'
#!/bin/sh
case "${1-}" in
  --decode|-D|-d)
    shift
    payload=$(cat)
    [ -z "$payload" ] && exit 0
    exit 70
    ;;
  -w|-b)
    [ "${2-}" = 0 ] || exit 64
    payload=$(cat)
    [ -z "$payload" ] && exit 0
    exit 70
    ;;
  *) exit 64 ;;
esac
SH
  chmod +x "$CODEC_ROOT/failing shim/base64"
  printf 'decoder-failure-sentinel' > "$CODEC_ROOT/tool failure output"
  chmod 640 "$CODEC_ROOT/tool failure output"
  cp "$CODEC_ROOT/tool failure output" "$CODEC_ROOT/tool failure output.before"
  if PATH="$CODEC_ROOT/failing shim:$PATH" "$DECODER" \
    --input "$CODEC_ROOT/text encoded" --output "$CODEC_ROOT/tool failure output" \
    > "$CODEC_ROOT/tool failure.stdout" 2> "$CODEC_ROOT/tool failure.stderr"
  then
    fail 'decoder accepted a Base64 tool failure'
  else
    tool_failure_status=$?
  fi
  [ "$tool_failure_status" -eq 1 ] || fail 'Base64 tool failure did not use exit 1'
  assert_empty_file "$CODEC_ROOT/tool failure.stdout" 'Base64 tool failure emitted payload'
  assert_same_file \
    "$CODEC_ROOT/tool failure output.before" \
    "$CODEC_ROOT/tool failure output" \
    'Base64 tool failure replaced prior output'
  assert_mode '640' "$CODEC_ROOT/tool failure output" 'Base64 tool failure changed prior output mode'

  printf 'encoder-failure-sentinel' > "$CODEC_ROOT/encode tool failure output"
  chmod 640 "$CODEC_ROOT/encode tool failure output"
  cp "$CODEC_ROOT/encode tool failure output" "$CODEC_ROOT/encode tool failure output.before"
  if PATH="$CODEC_ROOT/failing shim:$PATH" "$ENCODER" \
    --input "$CODEC_ROOT/text input" --output "$CODEC_ROOT/encode tool failure output" \
    > "$CODEC_ROOT/encode tool failure.stdout" 2> "$CODEC_ROOT/encode tool failure.stderr"
  then
    fail 'encoder accepted a Base64 tool failure'
  else
    tool_failure_status=$?
  fi
  [ "$tool_failure_status" -eq 1 ] || fail 'encoder Base64 tool failure did not use exit 1'
  assert_empty_file "$CODEC_ROOT/encode tool failure.stdout" 'encoder Base64 tool failure emitted payload'
  assert_same_file \
    "$CODEC_ROOT/encode tool failure output.before" \
    "$CODEC_ROOT/encode tool failure output" \
    'encoder Base64 tool failure replaced prior output'
  assert_mode '640' "$CODEC_ROOT/encode tool failure output" 'encoder tool failure changed prior output mode'

  mkdir -p "$CODEC_ROOT/cleanup tmp" "$CODEC_ROOT/cleanup output"
  mkdir "$CODEC_ROOT/cleanup tmp/.fprs-secret-codec.keep"
  mkdir "$CODEC_ROOT/cleanup output/.fprs-secret-codec.keep"
  printf 'owned sentinel' > "$CODEC_ROOT/cleanup tmp/.fprs-secret-codec.keep/sentinel"
  printf 'owned sentinel' > "$CODEC_ROOT/cleanup output/.fprs-secret-codec.keep/sentinel"
  TMPDIR="$CODEC_ROOT/cleanup tmp" "$ENCODER" --input "$CODEC_ROOT/text input" \
    --output "$CODEC_ROOT/cleanup output/encoded success" ||
    fail 'encoder cleanup success setup failed'
  TMPDIR="$CODEC_ROOT/cleanup tmp" "$DECODER" --input "$CODEC_ROOT/text encoded" \
    --output "$CODEC_ROOT/cleanup output/decoded success" ||
    fail 'decoder cleanup success setup failed'
  assert_same_file \
    "$CODEC_ROOT/text input" \
    "$CODEC_ROOT/cleanup output/decoded success" \
    'decoder cleanup success changed bytes'

  printf 'preserve-encode-error' > "$CODEC_ROOT/cleanup output/encode error"
  cp "$CODEC_ROOT/cleanup output/encode error" "$CODEC_ROOT/cleanup output/encode error.before"
  if PATH="$CODEC_ROOT/failing shim:$PATH" TMPDIR="$CODEC_ROOT/cleanup tmp" \
    "$ENCODER" --input "$CODEC_ROOT/text input" \
    --output "$CODEC_ROOT/cleanup output/encode error" \
    > "$CODEC_ROOT/cleanup encode error.stdout" 2> "$CODEC_ROOT/cleanup encode error.stderr"
  then
    fail 'encoder cleanup error setup unexpectedly succeeded'
  fi
  assert_same_file \
    "$CODEC_ROOT/cleanup output/encode error.before" \
    "$CODEC_ROOT/cleanup output/encode error" \
    'encoder cleanup error changed explicit output'

  printf 'preserve-decode-error' > "$CODEC_ROOT/cleanup output/decode error"
  cp "$CODEC_ROOT/cleanup output/decode error" "$CODEC_ROOT/cleanup output/decode error.before"
  if TMPDIR="$CODEC_ROOT/cleanup tmp" "$DECODER" --input "$CODEC_ROOT/invalid-alphabet.input" \
    --output "$CODEC_ROOT/cleanup output/decode error" \
    > "$CODEC_ROOT/cleanup decode error.stdout" 2> "$CODEC_ROOT/cleanup decode error.stderr"
  then
    fail 'decoder cleanup error setup unexpectedly succeeded'
  fi
  assert_same_file \
    "$CODEC_ROOT/cleanup output/decode error.before" \
    "$CODEC_ROOT/cleanup output/decode error" \
    'decoder cleanup error changed explicit output'
  [ -f "$CODEC_ROOT/cleanup tmp/.fprs-secret-codec.keep/sentinel" ] ||
    fail 'cleanup removed a pre-existing TMPDIR lookalike'
  [ -f "$CODEC_ROOT/cleanup output/.fprs-secret-codec.keep/sentinel" ] ||
    fail 'cleanup removed a pre-existing output lookalike'
  cleanup_leftover=$(find "$CODEC_ROOT/cleanup tmp" "$CODEC_ROOT/cleanup output" \
    -type d -name '.fprs-secret-codec.*' \
    ! -name '.fprs-secret-codec.keep' -print | sed -n '1p')
  [ -z "$cleanup_leftover" ] || fail 'temporary directory remained after success or error'

  for signal_name in HUP INT TERM
  do
    secret_codec_signal_case "$signal_name" encode
    secret_codec_signal_case "$signal_name" decode
  done
  pass 'signal_status_cleanup_regression'
  [ -f "$CODEC_ROOT/cleanup output/.fprs-secret-codec.keep/sentinel" ] ||
    fail 'signal cleanup removed a pre-existing lookalike'

  mkdir -p "$CODEC_ROOT/umask shim"
  cat > "$CODEC_ROOT/umask shim/base64" <<'SH'
#!/bin/sh
umask > "$FPRS_UMASK_LOG"
exit 70
SH
  chmod +x "$CODEC_ROOT/umask shim/base64"
  if PATH="$CODEC_ROOT/umask shim:$PATH" FPRS_UMASK_LOG="$CODEC_ROOT/encode umask" \
    "$ENCODER" < /dev/null > /dev/null 2> "$CODEC_ROOT/encode umask.stderr"
  then
    fail 'umask probe encoder unexpectedly succeeded'
  fi
  if PATH="$CODEC_ROOT/umask shim:$PATH" FPRS_UMASK_LOG="$CODEC_ROOT/decode umask" \
    "$DECODER" < /dev/null > /dev/null 2> "$CODEC_ROOT/decode umask.stderr"
  then
    fail 'umask probe decoder unexpectedly succeeded'
  fi
  encode_umask=$(tr -d '[:space:]' < "$CODEC_ROOT/encode umask")
  decode_umask=$(tr -d '[:space:]' < "$CODEC_ROOT/decode umask")
  case "$encode_umask" in *077) ;; *) fail 'encoder did not establish umask 077' ;; esac
  case "$decode_umask" in *077) ;; *) fail 'decoder did not establish umask 077' ;; esac
}

secret_codecs() {
  CODEC_ROOT="$TMP_ROOT/secret codecs"
  COMMON="$PACKAGE_ROOT/scripts/lib/common.sh"
  ENCODER="$PACKAGE_ROOT/scripts/encode_secret.sh"
  DECODER="$PACKAGE_ROOT/scripts/decode_secret.sh"
  mkdir -p "$CODEC_ROOT"

  secret_codecs_helpers
  secret_codecs_round_trips
  secret_codecs_strictness
  secret_codecs_publication_races
  secret_codecs_platform_and_cleanup
  pass 'secret_codecs'
}

inspection_assert_status() {
  inspection_description=$1
  inspection_expected_status=$2
  shift 2
  inspection_case_index=$((inspection_case_index + 1))
  INSPECTION_LAST_STDOUT="$INSPECTION_LOGS/$inspection_case_index.stdout"
  INSPECTION_LAST_STDERR="$INSPECTION_LOGS/$inspection_case_index.stderr"

  if "$@" > "$INSPECTION_LAST_STDOUT" 2> "$INSPECTION_LAST_STDERR"; then
    inspection_actual_status=0
  else
    inspection_actual_status=$?
  fi
  [ "$inspection_actual_status" -eq "$inspection_expected_status" ] ||
    fail "$inspection_description (expected exit $inspection_expected_status, got $inspection_actual_status)"
}

inspection_assert_json_fragment() {
  inspection_json_file=$1
  inspection_expected_fragment=$2
  inspection_description=$3
  grep -F -- "$inspection_expected_fragment" "$inspection_json_file" >/dev/null 2>&1 ||
    fail "$inspection_description"
}

inspection_assert_schema() {
  inspection_json_file=$1
  inspection_keys='schema_version project_root flutter_constraint dart_constraint flutter_version android_dsl gradle_file android_gradle_plugin_version gradle_wrapper_version java_compatibility application_id namespace application_id_candidates version_name version_code pubspec_version_name pubspec_build_number flavors selected_flavor suggested_flavor suggestion_confirmed entrypoints build_runner fastlane github_actions release_signing release_uses_debug_signing firebase firebase_package_names firebase_apps firebase_app_distribution monorepo git_dirty files_bootstrap_may_change warnings failures'

  [ "$(sed -n '1p' "$inspection_json_file" | cut -c1)" = '{' ] ||
    fail 'inspection JSON did not start with an object'
  [ "$(tail -n 1 "$inspection_json_file" | sed 's/.*\(.\)$/\1/')" = '}' ] ||
    fail 'inspection JSON did not end with an object'
  for inspection_key in $inspection_keys
  do
    inspection_key_count=$(grep -o "\"$inspection_key\":" "$inspection_json_file" | wc -l | tr -d '[:space:]')
    [ "$inspection_key_count" = 1 ] ||
      fail "inspection JSON key count changed for $inspection_key"
  done

  # Keep structural checks even when a richer parser is available.
  grep -E '"schema_version":[0-9]+' "$inspection_json_file" >/dev/null 2>&1 ||
    fail 'inspection schema_version is not numeric'
  grep -E '"suggestion_confirmed":(true|false)' "$inspection_json_file" >/dev/null 2>&1 ||
    fail 'inspection suggestion_confirmed is not boolean'
  grep -E '"git_dirty":(true|false|null)' "$inspection_json_file" >/dev/null 2>&1 ||
    fail 'inspection git_dirty has the wrong structural type'
  for inspection_array_key in application_id_candidates flavors entrypoints firebase_package_names firebase_apps files_bootstrap_may_change warnings failures
  do
    grep -E "\"$inspection_array_key\":\[" "$inspection_json_file" >/dev/null 2>&1 ||
      fail "inspection $inspection_array_key is not structurally an array"
  done

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$inspection_json_file" <<'PY' || fail 'Python rejected the inspection JSON schema'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

nullable_strings = {
    "flutter_constraint", "dart_constraint", "flutter_version", "gradle_file",
    "android_gradle_plugin_version", "gradle_wrapper_version", "java_compatibility",
    "application_id", "namespace", "version_name", "version_code",
    "pubspec_version_name", "pubspec_build_number", "selected_flavor", "suggested_flavor",
}
strings = {"project_root", "android_dsl"}
booleans = {
    "suggestion_confirmed", "build_runner", "fastlane", "github_actions",
    "release_signing", "release_uses_debug_signing", "firebase",
    "firebase_app_distribution", "monorepo",
}
arrays = {
    "application_id_candidates", "flavors", "entrypoints", "firebase_package_names",
    "firebase_apps", "files_bootstrap_may_change", "warnings", "failures",
}
required = {"schema_version", "git_dirty"} | nullable_strings | strings | booleans | arrays
assert required <= set(data)
assert type(data["schema_version"]) is int
assert data["schema_version"] == 1
for key in strings:
    assert type(data[key]) is str
for key in nullable_strings:
    assert data[key] is None or type(data[key]) is str
for key in booleans:
    assert type(data[key]) is bool
for key in arrays:
    assert type(data[key]) is list
assert data["git_dirty"] is None or type(data["git_dirty"]) is bool
PY
  elif command -v ruby >/dev/null 2>&1; then
    ruby -rjson - "$inspection_json_file" <<'RUBY' || fail 'Ruby rejected the inspection JSON schema'
data = JSON.parse(File.read(ARGV.fetch(0)))
nullable_strings = %w[flutter_constraint dart_constraint flutter_version gradle_file android_gradle_plugin_version gradle_wrapper_version java_compatibility application_id namespace version_name version_code pubspec_version_name pubspec_build_number selected_flavor suggested_flavor]
strings = %w[project_root android_dsl]
booleans = %w[suggestion_confirmed build_runner fastlane github_actions release_signing release_uses_debug_signing firebase firebase_app_distribution monorepo]
arrays = %w[application_id_candidates flavors entrypoints firebase_package_names firebase_apps files_bootstrap_may_change warnings failures]
required = (["schema_version", "git_dirty"] + nullable_strings + strings + booleans + arrays).sort
raise unless (required - data.keys).empty?
raise unless data["schema_version"] == 1
strings.each { |key| raise unless data[key].is_a?(String) }
nullable_strings.each { |key| raise unless data[key].nil? || data[key].is_a?(String) }
booleans.each { |key| raise unless data[key] == true || data[key] == false }
arrays.each { |key| raise unless data[key].is_a?(Array) }
raise unless data["git_dirty"].nil? || data["git_dirty"] == true || data["git_dirty"] == false
RUBY
  fi
}

inspection_write_pubspec() {
  inspection_project=$1
  inspection_build_runner_section=$2
  mkdir -p "$inspection_project/android/app/src/main" "$inspection_project/lib"
  case "$inspection_build_runner_section" in
    dev_dependencies)
      cat > "$inspection_project/pubspec.yaml" <<'YAML'
name: inspection_fixture
environment:
  sdk: ">=3.3.0 <4.0.0"
  flutter: ">=3.19.0"
version: 1.2.3+45
dependencies:
  flutter:
    sdk: flutter
dev_dependencies:
  build_runner: ^2.4.9
YAML
      ;;
    dependencies)
      cat > "$inspection_project/pubspec.yaml" <<'YAML'
name: inspection_fixture
environment:
  sdk: '>=3.4.0 <4.0.0'
  flutter: 3.22.0
version: 3.0.0+300
dependencies:
  flutter:
    sdk: flutter
  build_runner: ^2.4.11
dev_dependencies:
  test: any
YAML
      ;;
    *) fail 'unknown build_runner fixture section' ;;
  esac
  printf 'void main() {}\n' > "$inspection_project/lib/main.dart"
}

inspection_write_wrapper() {
  inspection_project=$1
  inspection_gradle_version=$2
  mkdir -p "$inspection_project/android/gradle/wrapper"
  printf 'distributionUrl=https\\://services.gradle.org/distributions/gradle-%s-bin.zip\n' \
    "$inspection_gradle_version" > "$inspection_project/android/gradle/wrapper/gradle-wrapper.properties"
}

inspection_append_execution_canary() {
  inspection_gradle_file=$1
  inspection_gradle_dsl=$2
  case "$inspection_gradle_dsl" in
    groovy)
      printf '\nnew File(System.getenv("FPRS_INSPECTION_EXEC_MARKER") ?: "/dev/null").text = "executed"\n' \
        >> "$inspection_gradle_file"
      ;;
    kotlin)
      printf '\njava.io.File(System.getenv("FPRS_INSPECTION_EXEC_MARKER") ?: "/dev/null").writeText("executed")\n' \
        >> "$inspection_gradle_file"
      ;;
    *) fail 'unknown Gradle DSL for execution canary' ;;
  esac
}

inspection_make_groovy() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle" <<'GRADLE'
pluginManagement {}
plugins {
    // id "com.android.application" version "99.0.0" apply false
    id "com.android.application" version "8.5.2" apply false
}
GRADLE
  cat > "$inspection_project/android/app/build.gradle" <<'GRADLE'
plugins {
    id "com.android.application"
}

android {
    namespace "com.example.release"
    /* Inactive documentation example:
    defaultConfig {
        applicationId "CHANGE_ME_APPLICATION_ID"
    }
    */
    compileOptions {
        // sourceCompatibility JavaVersion.VERSION_99
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    defaultConfig {
        applicationId "com.example.release"
        versionCode 45
        versionName "1.2.3"
    }
    signingConfigs {
        upload {
            storeFile file(keystoreProperties["storeFile"])
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.upload
        }
    }
}

def ignoredSecret = "FPRS_GRADLE_SECRET_CANARY_18d90b"
new File(System.getenv("FPRS_INSPECTION_EXEC_MARKER") ?: "/dev/null").text = "executed"
GRADLE
}

inspection_make_kotlin() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dependencies
  inspection_write_wrapper "$inspection_project" 8.10.2
  printf '{"flutter":"3.22.3"}\n' > "$inspection_project/.fvmrc"
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
pluginManagement {}
plugins {
    id("com.android.application") version "8.7.3" apply false
}
KOTLIN
  cat > "$inspection_project/android/gradle.properties" <<'PROPERTIES'
VERSION_NAME=7.4.0
VERSION_CODE=740
PROPERTIES
  cat > "$inspection_project/android/app/build.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application")
}

android {
    namespace = "com.acme.shell"
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    flavorDimensions += "environment"
    productFlavors {
        create("staging") {
            applicationIdSuffix = ".staging"
            versionCode = 999
            versionName = "9.9.9"
        }
        create("release") {
            applicationId = "com.acme.mobile.release"
        }
    }
    defaultConfig {
        applicationId = "com.acme.mobile"
        versionCode = (project.findProperty("VERSION_CODE") ?: "1").toString().toInt()
        versionName = (project.findProperty("VERSION_NAME") ?: "1.0").toString()
    }
    buildTypes {
        getByName("release") { signingConfig = signingConfigs.getByName("debug") }
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
  printf 'void main() {}\n' > "$inspection_project/lib/main_release.dart"
  mkdir -p "$inspection_project/android/fastlane" "$inspection_project/.github/workflows"
  printf 'firebase_app_distribution(app: ENV["FIREBASE_APP_ID"])\n' \
    > "$inspection_project/android/fastlane/Fastfile"
  printf 'name: release\n' > "$inspection_project/.github/workflows/release-android.yml"
  mkdir -p "$inspection_project/android/app/src/release"
  printf '%s\n' '{"project_info":{"project_number":"FPRS_FIREBASE_PROJECT_CANARY_7364f1","project_id":"not-for-output","package_name":"com.global.noise"},"client":[{"oauth_client":[{"client_type":1,"android_info":{"package_name":"com.oauth.noise"}}],"client_info":{"mobilesdk_app_id":"1:123456789:android:releaseabc","android_client_info":{"package_name":"com.acme.mobile.release"}},"api_key":[{"current_key":"FPRS_FIREBASE_API_KEY_CANARY_aa90e2"}]},{"client_info":{"mobilesdk_app_id":"1:123456789:android:legacyabc","android_client_info":{"package_name":"com.acme.legacy"}}},{"client_info":{"mobilesdk_app_id":"1:123456789:android:orphanabc"}},{"client_info":{"android_client_info":{"package_name":"com.cross.noise"}}}]}' \
    > "$inspection_project/android/app/src/release/google-services.json"
}

inspection_make_minimal_kotlin() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.9
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.6.1" apply false
}
KOTLIN
  cat > "$inspection_project/android/app/build.gradle.kts" <<'KOTLIN'
val unrelatedJavaDocumentation = JavaVersion.VERSION_21

android {
    namespace = "com.example.kotlin"
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
    }
    defaultConfig {
        applicationId = "com.example.kotlin"
        versionCode = 1_045
        versionName = "1.2.3"
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
}

inspection_make_unresolved() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.6
  cat > "$inspection_project/android/settings.gradle" <<'GRADLE'
plugins {
    id "com.android.application" version "8.4.1" apply false
}
GRADLE
  cat > "$inspection_project/android/app/build.gradle" <<'GRADLE'
android {
    namespace namespaceFromEnvironment()
    defaultConfig {
        applicationId applicationIdFromEnvironment()
        versionCode 1 + calculateVersionCode()
        versionName calculateVersionName()
    }
}
GRADLE
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle" groovy
}

inspection_make_dynamic_flavor() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.5.2" apply false
}
KOTLIN
  cat > "$inspection_project/android/app/build.gradle.kts" <<'KOTLIN'
android {
    namespace = "com.example.dynamic"
    defaultConfig {
        applicationId = "com.example.dynamic"
        versionCode = 45
        versionName = "1.2.3"
    }
    productFlavors {
        create("release") {
            applicationIdSuffix = ".release"
        }
    }
    productFlavors {
        create(flavorNameFromEnvironment()) {
            applicationIdSuffix = ".dynamic"
        }
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
}

inspection_make_dynamic_suffix() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle" <<'GRADLE'
plugins {
    id "com.android.application" version "8.5.2" apply false
}
GRADLE
  cat > "$inspection_project/android/app/build.gradle" <<'GRADLE'
android {
    namespace "com.example.base"
    defaultConfig {
        applicationId "com.example.base"
        versionCode 45
        versionName "1.2.3"
    }
    productFlavors {
        release {
            applicationIdSuffix ".release" + suffixFromEnvironment()
        }
    }
}
GRADLE
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle" groovy
  printf 'void main() {}\n' > "$inspection_project/lib/main_release.dart"
}

inspection_make_literal_suffix() {
  inspection_project=$1
  inspection_make_dynamic_suffix "$inspection_project"
  sed 's/applicationIdSuffix .*/applicationIdSuffix ".release"/' \
    "$inspection_project/android/app/build.gradle" \
    > "$inspection_project/android/app/build.gradle.next"
  mv "$inspection_project/android/app/build.gradle.next" \
    "$inspection_project/android/app/build.gradle"
}

inspection_make_release_suffix() {
  inspection_project=$1
  inspection_suffix_expression=$2
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.5.2" apply false
}
KOTLIN
  cat > "$inspection_project/android/app/build.gradle.kts" <<KOTLIN
android {
    namespace = "com.example.base"
    defaultConfig {
        applicationId = "com.example.base"
        versionCode = 45
        versionName = "1.2.3"
    }
    productFlavors {
        create("release") {
            applicationIdSuffix = ".flavor"
        }
    }
    buildTypes {
        getByName("release") {
            applicationIdSuffix = $inspection_suffix_expression
        }
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
  printf 'void main() {}\n' > "$inspection_project/lib/main_release.dart"
}

inspection_make_release_suffix_without_flavors() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.5.2" apply false
}
KOTLIN
  cat > "$inspection_project/android/app/build.gradle.kts" <<'KOTLIN'
android {
    namespace = "com.example.base"
    defaultConfig {
        applicationId = "com.example.base"
        versionCode = 45
        versionName = "1.2.3"
    }
    buildTypes {
        getByName("release") {
        }
    }
    buildTypes {
        getByName("release") {
            applicationIdSuffix = ".store"
        }
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
}

inspection_make_signing_reference() {
  inspection_project=$1
  inspection_signing_expression=$2
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.5.2" apply false
}
KOTLIN
  cat > "$inspection_project/android/app/build.gradle.kts" <<KOTLIN
android {
    namespace = "com.example.signing"
    defaultConfig {
        applicationId = "com.example.signing"
        versionCode = 45
        versionName = "1.2.3"
    }
    buildTypes {
        named("release") {
            signingConfig = $inspection_signing_expression
        }
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
}

inspection_make_nested_release_assignments() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.5.2" apply false
}
KOTLIN
  cat > "$inspection_project/android/app/build.gradle.kts" <<'KOTLIN'
android {
    namespace = "com.example.nested"
    defaultConfig {
        applicationId = "com.example.nested"
        versionCode = 45
        versionName = "1.2.3"
    }
    buildTypes {
        named("release") {
            if (enableConditionalRelease) {
                applicationIdSuffix = ".conditional"
                signingConfig = signingConfigs.named("debug").get()
            }
        }
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
}

inspection_make_mixed_versions() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  printf 'VERSION_NAME=7.4.0\nVERSION_CODE=740\n' \
    > "$inspection_project/android/gradle.properties"
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.5.2" apply false
}
KOTLIN
  cat > "$inspection_project/android/app/build.gradle.kts" <<'KOTLIN'
android {
    namespace = "com.example.versions"
    defaultConfig {
        applicationId = "com.example.versions"
        versionCode = (project.findProperty("VERSION_CODE") ?: "1").toString().toInt() + calculateOffset()
        versionName = (project.findProperty("VERSION_NAME") ?: "1.0").toString() + versionSuffix()
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
}

inspection_make_version_mutations() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  printf 'VERSION_NAME=7.4.0\nVERSION_CODE=740\n' \
    > "$inspection_project/android/gradle.properties"
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.5.2" apply false
}
KOTLIN
  cat > "$inspection_project/android/app/build.gradle.kts" <<'KOTLIN'
android {
    namespace = "com.example.mutations"
    defaultConfig {
        applicationId = "com.example.mutations"
        versionCode = (project.findProperty("VERSION_CODE") ?: "1").toString().toInt()
        versionCode += calculateOffset()
        versionName = (project.findProperty("VERSION_NAME") ?: "1.0").toString()
        versionName += versionSuffix()
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
}

inspection_make_multidimension() {
  inspection_project=$1
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle" <<'GRADLE'
plugins {
    id "com.android.application" version "8.5.2" apply false
}
GRADLE
  cat > "$inspection_project/android/app/build.gradle" <<'GRADLE'
android {
    namespace "com.example.multi"
    defaultConfig {
        applicationId "com.example.multi"
        versionCode 45
        versionName "1.2.3"
    }
    flavorDimensions configuredDimensions
    productFlavors {
        free {
            dimension tierDimension
            applicationIdSuffix ".free"
        }
        production {
            dimension environmentDimension
            applicationIdSuffix ".production"
        }
    }
}
GRADLE
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle" groovy
}

inspection_make_flavor_callback() {
  inspection_project=$1
  inspection_callback=$2
  inspection_callback_mode=${3:-mutation}
  case "$inspection_callback_mode" in
    read_only)
      inspection_callback_header="$inspection_callback { flavor ->"
      inspection_callback_statement='println flavor.applicationIdSuffix'
      ;;
    mutation)
      case "$inspection_callback" in
        each|forEach) inspection_callback_header="$inspection_callback { flavor ->" ;;
        *) inspection_callback_header="$inspection_callback {" ;;
      esac
      inspection_callback_statement='applicationIdSuffix ".common"'
      ;;
    *) fail 'unknown flavor callback fixture mode' ;;
  esac
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle" <<'GRADLE'
plugins {
    id "com.android.application" version "8.5.2" apply false
}
GRADLE
  cat > "$inspection_project/android/app/build.gradle" <<GRADLE
android {
    namespace "com.example.callback"
    defaultConfig {
        applicationId "com.example.callback"
        versionCode 45
        versionName "1.2.3"
    }
    productFlavors {
        release {
            applicationIdSuffix ".release"
        }
        $inspection_callback_header
            $inspection_callback_statement
        }
    }
}
GRADLE
  printf 'void main() {}\n' > "$inspection_project/lib/main_release.dart"
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle" groovy
}

inspection_make_flavor_identity_case() {
  inspection_project=$1
  inspection_identity_case=$2
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle" <<'GRADLE'
plugins {
    id "com.android.application" version "8.5.2" apply false
}
GRADLE
  case "$inspection_identity_case" in
    nested)
      inspection_flavor_body='            if (enableIdentity) {
                applicationIdSuffix ".conditional"
            }'
      ;;
    inline)
      inspection_flavor_body='            if (enableIdentity) applicationId "com.example.inline"'
      ;;
    duplicate)
      inspection_flavor_body='            applicationId "com.example.first"
            applicationId "com.example.second"'
      ;;
    mutation)
      inspection_flavor_body='            applicationIdSuffix ".first"
            applicationIdSuffix += ".later"'
      ;;
    *) fail 'unknown flavor identity fixture case' ;;
  esac
  cat > "$inspection_project/android/app/build.gradle" <<GRADLE
android {
    namespace "com.example.identity"
    defaultConfig {
        applicationId "com.example.identity"
        versionCode 45
        versionName "1.2.3"
    }
    productFlavors {
        release {
$inspection_flavor_body
        }
    }
}
GRADLE
  printf 'void main() {}\n' > "$inspection_project/lib/main_release.dart"
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle" groovy
}

inspection_make_default_config_case() {
  inspection_project=$1
  inspection_default_case=$2
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.5.2" apply false
}
KOTLIN
  case "$inspection_default_case" in
    compact)
      inspection_default_body='    defaultConfig { applicationId = "com.example.defaults" }
    defaultConfig { versionCode = 77 }
    defaultConfig { versionName = "7.7.0" }'
      ;;
    repeated_dynamic)
      inspection_default_body='    defaultConfig {
        applicationId = "com.example.stale"
        versionCode = 77
        versionName = "7.7.0"
    }
    defaultConfig { applicationId = applicationIdFromEnvironment() }
    defaultConfig { versionCode += calculateOffset() }
    defaultConfig { if (usePreviewVersion) versionName = "8.0.0" }'
      ;;
    nested)
      inspection_default_body='    defaultConfig {
        applicationId = "com.example.stale"
        versionCode = 77
        versionName = "7.7.0"
        if (useNestedDefaults) {
            applicationId = "com.example.nested"
            versionCode = 88
            versionName = "8.8.0"
        }
    }'
      ;;
    *) fail 'unknown defaultConfig fixture case' ;;
  esac
  cat > "$inspection_project/android/app/build.gradle.kts" <<KOTLIN
android {
    namespace = "com.example.defaults"
$inspection_default_body
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
}

inspection_make_java_case() {
  inspection_project=$1
  inspection_java_case=$2
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.5.2" apply false
}
KOTLIN
  case "$inspection_java_case" in
    compact)
      inspection_java_body='    compileOptions { sourceCompatibility = JavaVersion.VERSION_1_8; targetCompatibility = JavaVersion.VERSION_1_8 }'
      ;;
    later_override)
      inspection_java_body='    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        sourceCompatibility = javaVersionFromEnvironment()
    }'
      ;;
    mixed)
      inspection_java_body='    compileOptions {
        sourceCompatibility = if (useModernJava) JavaVersion.VERSION_21 else JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }'
      ;;
    inconsistent)
      inspection_java_body='    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_21
    }'
      ;;
    *) fail 'unknown Java fixture case' ;;
  esac
  cat > "$inspection_project/android/app/build.gradle.kts" <<KOTLIN
android {
    namespace = "com.example.java"
$inspection_java_body
    defaultConfig {
        applicationId = "com.example.java"
        versionCode = 45
        versionName = "1.2.3"
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
}

inspection_make_compact_release_case() {
  inspection_project=$1
  inspection_release_case=$2
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle" <<'GRADLE'
plugins {
    id "com.android.application" version "8.5.2" apply false
}
GRADLE
  case "$inspection_release_case" in
    static)
      inspection_release_line='    buildTypes { release { applicationIdSuffix ".store"; signingConfig signingConfigs.upload } }'
      ;;
    dynamic)
      inspection_release_line='    buildTypes { release { applicationIdSuffix ".store" + suffixFromEnvironment(); signingConfig useDebug ? signingConfigs.debug : signingConfigs.upload } }'
      ;;
    *) fail 'unknown compact release fixture case' ;;
  esac
  cat > "$inspection_project/android/app/build.gradle" <<GRADLE
android {
    namespace "com.example.compactrelease"
    defaultConfig {
        applicationId "com.example.compactrelease"
        versionCode 45
        versionName "1.2.3"
    }
$inspection_release_line
}
GRADLE
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle" groovy
}

inspection_make_qualified_write_case() {
  inspection_project=$1
  inspection_qualified_case=$2
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle" <<'GRADLE'
plugins {
    id "com.android.application" version "8.5.2" apply false
}
GRADLE
  case "$inspection_qualified_case" in
    default_version)
      inspection_qualified_body='    defaultConfig.versionCode += calculateOffset()'
      ;;
    flavor_container)
      inspection_qualified_body='    productFlavors.create("release") {
        applicationIdSuffix = ".release"
    }'
      ;;
    release)
      inspection_qualified_body='    buildTypes {
        release {
            applicationIdSuffix ".store"
            signingConfig signingConfigs.upload
        }
    }
    buildTypes.release.applicationIdSuffix = suffixFromEnvironment()
    buildTypes.release.signingConfig = signingConfigs.debug'
      ;;
    read_only_flavor_query)
      inspection_qualified_body='    productFlavors {
        release {
            applicationIdSuffix ".release"
        }
    }
    if (productFlavors.findByName("release") != null) {
        println "release flavor exists"
    }'
      ;;
    flavor_factory_statement)
      inspection_qualified_body='    productFlavors.create("release")'
      ;;
    setter_calls)
      inspection_qualified_body='    buildTypes {
        release {
            applicationIdSuffix ".store"
            signingConfig signingConfigs.upload
        }
    }
    defaultConfig.versionCode calculateOffset()
    buildTypes.release.applicationIdSuffix(suffixFromEnvironment())
    buildTypes.release.signingConfig(signingConfigs.debug)'
      ;;
    *) fail 'unknown qualified Gradle write fixture case' ;;
  esac
  cat > "$inspection_project/android/app/build.gradle" <<GRADLE
android {
    namespace "com.example.qualified"
    defaultConfig {
        applicationId "com.example.qualified"
        versionCode 45
        versionName "1.2.3"
    }
$inspection_qualified_body
}
GRADLE
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle" groovy
}

inspection_make_duplicate_properties() {
  inspection_project=$1
  inspection_property_source=$2
  inspection_write_pubspec "$inspection_project" dev_dependencies
  inspection_write_wrapper "$inspection_project" 8.7
  cat > "$inspection_project/android/settings.gradle.kts" <<'KOTLIN'
plugins {
    id("com.android.application") version "8.5.2" apply false
}
KOTLIN
  case "$inspection_property_source" in
    gradle)
      cat > "$inspection_project/android/gradle.properties" <<'PROPERTIES'
VERSION_NAME=1.0.0
VERSION_CODE=100
VERSION_NAME = 2.0.0
VERSION_CODE = 200
PROPERTIES
      inspection_version_code='(project.findProperty("VERSION_CODE") ?: "1").toString().toInt()'
      inspection_version_name='(project.findProperty("VERSION_NAME") ?: "1.0").toString()'
      ;;
    flutter)
      cat > "$inspection_project/android/local.properties" <<'PROPERTIES'
flutter.versionName=3.0.0
flutter.versionCode=300
flutter.versionName = 4.0.0
flutter.versionCode = 400
PROPERTIES
      inspection_version_code='flutter.versionCode'
      inspection_version_name='flutter.versionName'
      ;;
    continuation)
      cat > "$inspection_project/android/local.properties" <<'PROPERTIES'
flutter.versionName=3.0.0
flutter.versionCode=300
OTHER_NAME=prefix\
flutter.versionName=4.0.0
OTHER_CODE=prefix\
flutter.versionCode=400
PROPERTIES
      inspection_version_code='flutter.versionCode'
      inspection_version_name='flutter.versionName'
      ;;
    *) fail 'unknown duplicate property fixture source' ;;
  esac
  cat > "$inspection_project/android/app/build.gradle.kts" <<KOTLIN
android {
    namespace = "com.example.properties"
    defaultConfig {
        applicationId = "com.example.properties"
        versionCode = $inspection_version_code
        versionName = $inspection_version_name
    }
}
KOTLIN
  inspection_append_execution_canary \
    "$inspection_project/android/app/build.gradle.kts" kotlin
}

inspection_assert_no_canary_logs() {
  for inspection_canary in \
    FPRS_GRADLE_SECRET_CANARY_18d90b \
    FPRS_FIREBASE_PROJECT_CANARY_7364f1 \
    FPRS_FIREBASE_API_KEY_CANARY_aa90e2
  do
    if grep -R -F -- "$inspection_canary" "$INSPECTION_LOGS" >/dev/null 2>&1; then
      fail 'inspection output exposed a secret canary'
    fi
  done
}

inspection() {
  INSPECTOR="$PACKAGE_ROOT/scripts/inspect_flutter_project.sh"
  INSPECTION_ROOT="$TMP_ROOT/inspection fixtures"
  INSPECTION_LOGS="$INSPECTION_ROOT/logs"
  inspection_case_index=0
  mkdir -p "$INSPECTION_LOGS"

  groovy_project="$INSPECTION_ROOT/path with spaces/groovy app"
  inspection_make_groovy "$groovy_project"
  groovy_project=$(CDPATH= cd -- "$groovy_project" && pwd -P) ||
    fail 'could not resolve Groovy fixture physically'
  exec_marker="$INSPECTION_ROOT/project-command-executed"
  export FPRS_INSPECTION_EXEC_MARKER="$exec_marker"

  inspection_assert_status 'minimal Groovy JSON inspection failed' 0 \
    "$INSPECTOR" --project "$groovy_project" --format json
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  assert_empty_file "$INSPECTION_LAST_STDERR" 'successful JSON inspection wrote diagnostics to stderr'
  [ ! -e "$exec_marker" ] || fail 'inspection evaluated the Gradle project'
  cat > "$INSPECTION_ROOT/expected-groovy.json" <<EOF
{"schema_version":1,"project_root":"$groovy_project","flutter_constraint":">=3.19.0","dart_constraint":">=3.3.0 <4.0.0","flutter_version":null,"android_dsl":"groovy","gradle_file":"android/app/build.gradle","android_gradle_plugin_version":"8.5.2","gradle_wrapper_version":"8.7","java_compatibility":"17","application_id":"com.example.release","namespace":"com.example.release","application_id_candidates":["com.example.release"],"version_name":"1.2.3","version_code":"45","pubspec_version_name":"1.2.3","pubspec_build_number":"45","flavors":[],"selected_flavor":null,"suggested_flavor":null,"suggestion_confirmed":false,"entrypoints":["lib/main.dart"],"build_runner":true,"fastlane":false,"github_actions":false,"release_signing":true,"release_uses_debug_signing":false,"firebase":false,"firebase_package_names":[],"firebase_apps":[],"firebase_app_distribution":false,"monorepo":false,"git_dirty":null,"files_bootstrap_may_change":["android/Gemfile","android/Gemfile.lock","android/fastlane/Appfile","android/fastlane/Fastfile","android/fastlane/Pluginfile","android/fastlane/lib/flutter_play_store_release.rb","android/fastlane/.env.example","android/key.properties.example",".github/workflows/release-android.yml","docs/PLAY_STORE_RELEASE.md","tool/flutter-play-store-release/decode_secret.sh","tool/flutter-play-store-release/install_flutter_sdk.sh","tool/flutter-play-store-release/managed-files.sha256",".gitignore","android/app/build.gradle"],"warnings":[],"failures":[]}
EOF
  assert_same_file \
    "$INSPECTION_ROOT/expected-groovy.json" \
    "$INSPECTION_LAST_STDOUT" \
    'minimal Groovy JSON changed'

  inspection_assert_status 'minimal Groovy human inspection failed' 0 \
    "$INSPECTOR" --project "$groovy_project" --format human
  assert_empty_file "$INSPECTION_LAST_STDERR" 'successful human inspection wrote diagnostics to stderr'
  cat > "$INSPECTION_ROOT/expected-groovy.human" <<EOF
Flutter project inspection
Schema version: 1
Project root: $groovy_project
Flutter constraint: >=3.19.0
Dart constraint: >=3.3.0 <4.0.0
Flutter version: unknown
Android DSL: groovy
Gradle file: android/app/build.gradle
Android Gradle plugin: 8.5.2
Gradle wrapper: 8.7
Java compatibility: 17
Application ID: com.example.release
Namespace: com.example.release
Application ID candidates: com.example.release
Version name: 1.2.3
Version code: 45
Pubspec version name: 1.2.3
Pubspec build number: 45
Flavors: none
Selected flavor: none
Suggested flavor: none
Suggestion confirmed: no
Entrypoints: lib/main.dart
Build runner: yes
Fastlane: no
GitHub Actions: no
Release signing: yes
Release uses debug signing: no
Firebase: no
Firebase package names: none
Firebase apps: none
Firebase App Distribution: no
Monorepo: no
Git dirty: unknown
Files bootstrap may change: android/Gemfile, android/Gemfile.lock, android/fastlane/Appfile, android/fastlane/Fastfile, android/fastlane/Pluginfile, android/fastlane/lib/flutter_play_store_release.rb, android/fastlane/.env.example, android/key.properties.example, .github/workflows/release-android.yml, docs/PLAY_STORE_RELEASE.md, tool/flutter-play-store-release/decode_secret.sh, tool/flutter-play-store-release/install_flutter_sdk.sh, tool/flutter-play-store-release/managed-files.sha256, .gitignore, android/app/build.gradle
Warnings: none
Failures: none
EOF
  assert_same_file \
    "$INSPECTION_ROOT/expected-groovy.human" \
    "$INSPECTION_LAST_STDOUT" \
    'minimal Groovy human report changed'

  ln -s "$groovy_project" "$INSPECTION_ROOT/groovy alias"
  inspection_assert_status 'physical project-root resolution failed' 0 \
    "$INSPECTOR" --project "$INSPECTION_ROOT/groovy alias" --format json
  inspection_assert_json_fragment \
    "$INSPECTION_LAST_STDOUT" \
    "\"project_root\":\"$groovy_project\"" \
    'inspection did not resolve the project root physically'

  minimal_kotlin_project="$INSPECTION_ROOT/minimal kotlin app"
  inspection_make_minimal_kotlin "$minimal_kotlin_project"
  inspection_assert_status 'minimal Kotlin JSON inspection failed' 0 \
    "$INSPECTOR" --project "$minimal_kotlin_project" --format json
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"android_dsl":"kotlin","gradle_file":"android/app/build.gradle.kts","android_gradle_plugin_version":"8.6.1","gradle_wrapper_version":"8.9","java_compatibility":"8"' \
    'minimal Kotlin Gradle fields changed'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":"com.example.kotlin","namespace":"com.example.kotlin","application_id_candidates":["com.example.kotlin"]' \
    'minimal Kotlin application identity changed'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"version_name":"1.2.3","version_code":"1045"' \
    'minimal Kotlin numeric version literal changed'

  kotlin_project="$INSPECTION_ROOT/kotlin app"
  inspection_make_kotlin "$kotlin_project"
  inspection_assert_status 'ambiguous Kotlin flavor inspection did not use exit 2' 2 \
    "$INSPECTOR" --project "$kotlin_project" --format json
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"android_dsl":"kotlin"' 'Kotlin DSL was not detected'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null' 'ambiguous flavor unexpectedly selected an application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id_candidates":["com.acme.mobile.release","com.acme.mobile.staging"]' \
    'flavor application-ID candidates changed'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"flavors":["release","staging"]' 'Kotlin flavors changed'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"selected_flavor":null,"suggested_flavor":"release","suggestion_confirmed":false' \
    'entrypoint flavor suggestion was not conservative'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"failures":["multiple product flavors require --flavor"]' \
    'ambiguous flavors did not produce a stable failure'
  grep -F 'multiple product flavors require --flavor' "$INSPECTION_LAST_STDERR" >/dev/null 2>&1 ||
    fail 'ambiguous JSON inspection did not diagnose on stderr'

  inspection_assert_status 'explicit Kotlin release flavor inspection failed' 0 \
    "$INSPECTOR" --project "$kotlin_project" --format json --flavor release
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  assert_empty_file "$INSPECTION_LAST_STDERR" 'selected Kotlin flavor emitted diagnostics'
  for inspection_fragment in \
    '"flutter_constraint":"3.22.0","dart_constraint":">=3.4.0 <4.0.0","flutter_version":"3.22.3"' \
    '"android_gradle_plugin_version":"8.7.3","gradle_wrapper_version":"8.10.2","java_compatibility":"21"' \
    '"application_id":"com.acme.mobile.release","namespace":"com.acme.shell"' \
    '"version_name":"7.4.0","version_code":"740","pubspec_version_name":"3.0.0","pubspec_build_number":"300"' \
    '"selected_flavor":"release","suggested_flavor":"release","suggestion_confirmed":false' \
    '"entrypoints":["lib/main.dart","lib/main_release.dart"],"build_runner":true' \
    '"fastlane":true,"github_actions":true,"release_signing":false,"release_uses_debug_signing":true,"firebase":true' \
    '"firebase_package_names":["com.acme.mobile.release","com.acme.legacy"]' \
    '"firebase_apps":[{"package_name":"com.acme.mobile.release","app_id":"1:123456789:android:releaseabc","matches_application_id":true},{"package_name":"com.acme.legacy","app_id":"1:123456789:android:legacyabc","matches_application_id":false}]' \
    '"firebase_app_distribution":true' \
    '"files_bootstrap_may_change":["android/Gemfile","android/Gemfile.lock","android/fastlane/Appfile","android/fastlane/Fastfile","android/fastlane/Pluginfile","android/fastlane/lib/flutter_play_store_release.rb","android/fastlane/.env.example","android/key.properties.example",".github/workflows/release-android.yml","docs/PLAY_STORE_RELEASE.md","tool/flutter-play-store-release/decode_secret.sh","tool/flutter-play-store-release/install_flutter_sdk.sh","tool/flutter-play-store-release/managed-files.sha256",".gitignore","android/app/build.gradle.kts"]' \
    '"warnings":["namespace differs from default application ID","release build type uses debug signing"],"failures":[]'
  do
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" "$inspection_fragment" \
      "selected Kotlin inspection missing: $inspection_fragment"
  done
  if grep -E 'com\.(oauth|global|cross)\.noise' "$INSPECTION_LAST_STDOUT" >/dev/null 2>&1; then
    fail 'Firebase inspection paired an app ID with a package outside client_info.android_client_info'
  fi

  dynamic_flavor_project="$INSPECTION_ROOT/dynamic flavor declaration app"
  inspection_make_dynamic_flavor "$dynamic_flavor_project"
  inspection_assert_status 'dynamic product flavor declaration inspection failed' 0 \
    "$INSPECTOR" --project "$dynamic_flavor_project" --format json
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":"com.example.dynamic","application_id_candidates":[]' \
    'dynamic product flavor declaration fell back to the base application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["product flavor declarations could not be resolved"]' \
    'dynamic product flavor declaration warning changed'

  dynamic_suffix_project="$INSPECTION_ROOT/dynamic suffix app"
  inspection_make_dynamic_suffix "$dynamic_suffix_project"
  inspection_assert_status 'dynamic application-ID suffix inspection failed' 0 \
    "$INSPECTOR" --project "$dynamic_suffix_project" --format json --flavor release
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":"com.example.base","application_id_candidates":[]' \
    'dynamic suffix was collapsed into a concrete release application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["application ID suffix expression could not be resolved for flavor release"]' \
    'dynamic suffix warning changed'

  literal_suffix_project="$INSPECTION_ROOT/literal suffix app"
  inspection_make_literal_suffix "$literal_suffix_project"
  inspection_assert_status 'literal application-ID suffix inspection failed' 0 \
    "$INSPECTOR" --project "$literal_suffix_project" --format json --flavor release
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":"com.example.base.release","namespace":"com.example.base","application_id_candidates":["com.example.base.release"]' \
    'literal suffix release identity changed'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":[],"failures":[]' \
    'normal namespace/base identity produced a flavor suffix mismatch warning'

  release_suffix_project="$INSPECTION_ROOT/release build suffix app"
  inspection_make_release_suffix "$release_suffix_project" '".store"'
  inspection_assert_status 'literal release build suffix inspection failed' 0 \
    "$INSPECTOR" --project "$release_suffix_project" --format json --flavor release
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":"com.example.base.flavor.store","namespace":"com.example.base","application_id_candidates":["com.example.base.flavor.store"]' \
    'release build suffix was not appended after the flavor suffix'

  no_flavor_release_suffix_project="$INSPECTION_ROOT/no-flavor release build suffix app"
  inspection_make_release_suffix_without_flavors "$no_flavor_release_suffix_project"
  inspection_assert_status 'no-flavor release build suffix inspection failed' 0 \
    "$INSPECTOR" --project "$no_flavor_release_suffix_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":"com.example.base.store","namespace":"com.example.base","application_id_candidates":["com.example.base.store"]' \
    'release build suffix was not applied without product flavors'

  dynamic_release_suffix_project="$INSPECTION_ROOT/dynamic release build suffix app"
  inspection_make_release_suffix "$dynamic_release_suffix_project" \
    '".store" + suffixFromEnvironment()'
  inspection_assert_status 'dynamic release build suffix inspection failed' 0 \
    "$INSPECTOR" --project "$dynamic_release_suffix_project" --format json --flavor release
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":"com.example.base","application_id_candidates":[]' \
    'dynamic release build suffix produced a concrete application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["release application ID suffix expression could not be resolved"]' \
    'dynamic release build suffix warning changed'

  named_debug_signing_project="$INSPECTION_ROOT/named debug signing app"
  inspection_make_signing_reference "$named_debug_signing_project" \
    'signingConfigs.named("debug").get()'
  inspection_assert_status 'Kotlin named debug signing inspection failed' 0 \
    "$INSPECTOR" --project "$named_debug_signing_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"release_signing":false,"release_uses_debug_signing":true' \
    'Kotlin named debug signing was not classified as debug signing'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["release build type uses debug signing"]' \
    'Kotlin named debug signing warning changed'

  named_upload_signing_project="$INSPECTION_ROOT/named upload signing app"
  inspection_make_signing_reference "$named_upload_signing_project" \
    'signingConfigs.named("upload").get()'
  inspection_assert_status 'Kotlin named upload signing inspection failed' 0 \
    "$INSPECTOR" --project "$named_upload_signing_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"release_signing":true,"release_uses_debug_signing":false' \
    'Kotlin named upload signing was not classified as non-debug signing'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":[],"failures":[]' \
    'Kotlin named upload signing emitted a warning'

  conditional_signing_project="$INSPECTION_ROOT/conditional signing app"
  inspection_make_signing_reference "$conditional_signing_project" \
    'if (useDebugSigning) signingConfigs.debug else signingConfigs.upload'
  inspection_assert_status 'conditional release signing inspection failed' 0 \
    "$INSPECTOR" --project "$conditional_signing_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"release_signing":false,"release_uses_debug_signing":false' \
    'conditional release signing expression was classified as a direct reference'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["release signing expression could not be resolved"]' \
    'conditional release signing warning changed'

  nested_release_project="$INSPECTION_ROOT/nested conditional release assignments app"
  inspection_make_nested_release_assignments "$nested_release_project"
  inspection_assert_status 'nested conditional release assignment inspection failed' 0 \
    "$INSPECTOR" --project "$nested_release_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":"com.example.nested","application_id_candidates":[]' \
    'nested release suffix assignment produced a concrete application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"release_signing":false,"release_uses_debug_signing":false' \
    'nested release signing assignment was classified as direct'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["release application ID suffix expression could not be resolved","release signing expression could not be resolved"]' \
    'nested conditional release warnings changed'

  mixed_versions_project="$INSPECTION_ROOT/mixed version expressions app"
  inspection_make_mixed_versions "$mixed_versions_project"
  inspection_assert_status 'mixed version property expression inspection failed' 0 \
    "$INSPECTOR" --project "$mixed_versions_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"version_name":null,"version_code":null' \
    'mixed version expressions were collapsed to property values'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["version code expression could not be resolved","version name expression could not be resolved"]' \
    'mixed version expression warnings changed'

  version_mutations_project="$INSPECTION_ROOT/version property mutations app"
  inspection_make_version_mutations "$version_mutations_project"
  inspection_assert_status 'version property mutation inspection failed' 0 \
    "$INSPECTOR" --project "$version_mutations_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"version_name":null,"version_code":null' \
    'later version mutations did not invalidate allowlisted property assignments'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["version code expression could not be resolved","version name expression could not be resolved"]' \
    'version mutation warnings changed'

  for callback_name in all configureEach each forEach
  do
    callback_project="$INSPECTION_ROOT/$callback_name flavor callback app"
    inspection_make_flavor_callback "$callback_project" "$callback_name"
    inspection_assert_status "$callback_name flavor callback inspection failed" 0 \
      "$INSPECTOR" --project "$callback_project" --format json --flavor release
    inspection_assert_schema "$INSPECTION_LAST_STDOUT"
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      '"application_id":null,"namespace":"com.example.callback","application_id_candidates":[]' \
      "$callback_name flavor callback produced a concrete application ID"
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      '"flavors":["release"],"selected_flavor":"release"' \
      "$callback_name callback was reported as a product flavor"
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      '"warnings":["product flavor declarations could not be resolved"]' \
      "$callback_name flavor callback warning changed"
  done

  read_only_callback_project="$INSPECTION_ROOT/read-only flavor callback app"
  inspection_make_flavor_callback "$read_only_callback_project" all read_only
  inspection_assert_status 'read-only flavor callback inspection failed' 0 \
    "$INSPECTOR" --project "$read_only_callback_project" --format json --flavor release
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":"com.example.callback.release","namespace":"com.example.callback","application_id_candidates":["com.example.callback.release"]' \
    'read-only flavor callback poisoned release identity'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"flavors":["release"],"selected_flavor":"release"' \
    'read-only flavor callback changed flavor discovery'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":[],"failures":[]' \
    'read-only flavor callback emitted a warning'

  qualified_default_project="$INSPECTION_ROOT/qualified default version app"
  inspection_make_qualified_write_case "$qualified_default_project" default_version
  inspection_assert_status 'qualified defaultConfig version mutation inspection failed' 0 \
    "$INSPECTOR" --project "$qualified_default_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":"com.example.qualified","namespace":"com.example.qualified","application_id_candidates":["com.example.qualified"]' \
    'qualified defaultConfig version mutation invalidated the application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"version_name":"1.2.3","version_code":null' \
    'qualified defaultConfig version mutation returned the stale version code'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["version code expression could not be resolved"]' \
    'qualified defaultConfig version mutation warning changed'

  qualified_flavor_project="$INSPECTION_ROOT/qualified flavor container app"
  inspection_make_qualified_write_case "$qualified_flavor_project" flavor_container
  inspection_assert_status 'qualified productFlavors container inspection failed' 0 \
    "$INSPECTOR" --project "$qualified_flavor_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":"com.example.qualified","application_id_candidates":[]' \
    'qualified productFlavors container fell back to the base application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"flavors":[],"selected_flavor":null' \
    'qualified productFlavors container produced a speculative flavor'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["product flavor declarations could not be resolved"]' \
    'qualified productFlavors container warning changed'

  qualified_release_project="$INSPECTION_ROOT/qualified release writes app"
  inspection_make_qualified_write_case "$qualified_release_project" release
  inspection_assert_status 'qualified release write inspection failed' 0 \
    "$INSPECTOR" --project "$qualified_release_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":"com.example.qualified","application_id_candidates":[]' \
    'qualified release suffix write returned the earlier application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"release_signing":false,"release_uses_debug_signing":false' \
    'qualified release signing write returned the earlier signing state'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["release application ID suffix expression could not be resolved","release signing expression could not be resolved"]' \
    'qualified release write warnings changed'

  read_only_flavor_project="$INSPECTION_ROOT/read-only qualified flavor query app"
  inspection_make_qualified_write_case "$read_only_flavor_project" read_only_flavor_query
  inspection_assert_status 'read-only qualified productFlavors query inspection failed' 0 \
    "$INSPECTOR" --project "$read_only_flavor_project" --format json --flavor release
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":"com.example.qualified.release","namespace":"com.example.qualified","application_id_candidates":["com.example.qualified.release"]' \
    'read-only qualified productFlavors query poisoned release identity'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"flavors":["release"],"selected_flavor":"release"' \
    'read-only qualified productFlavors query changed flavor discovery'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":[],"failures":[]' \
    'read-only qualified productFlavors query emitted a warning'

  factory_statement_project="$INSPECTION_ROOT/qualified flavor factory statement app"
  inspection_make_qualified_write_case "$factory_statement_project" flavor_factory_statement
  inspection_assert_status 'qualified productFlavors factory statement inspection failed' 0 \
    "$INSPECTOR" --project "$factory_statement_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":"com.example.qualified","application_id_candidates":[]' \
    'qualified productFlavors factory statement fell back to the base application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["product flavor declarations could not be resolved"]' \
    'qualified productFlavors factory statement warning changed'

  setter_call_project="$INSPECTION_ROOT/qualified setter call app"
  inspection_make_qualified_write_case "$setter_call_project" setter_calls
  inspection_assert_status 'qualified Gradle setter call inspection failed' 0 \
    "$INSPECTOR" --project "$setter_call_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":"com.example.qualified","application_id_candidates":[]' \
    'qualified Gradle setter call returned the earlier application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"version_name":"1.2.3","version_code":null' \
    'qualified Gradle setter call returned the earlier version code'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"release_signing":false,"release_uses_debug_signing":false' \
    'qualified Gradle signing call returned the earlier signing state'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["version code expression could not be resolved","release application ID suffix expression could not be resolved","release signing expression could not be resolved"]' \
    'qualified Gradle setter call warnings changed'

  for identity_case in nested inline duplicate mutation
  do
    identity_project="$INSPECTION_ROOT/$identity_case flavor identity app"
    inspection_make_flavor_identity_case "$identity_project" "$identity_case"
    inspection_assert_status "$identity_case flavor identity inspection failed" 0 \
      "$INSPECTOR" --project "$identity_project" --format json --flavor release
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      '"application_id":null,"namespace":"com.example.identity","application_id_candidates":[]' \
      "$identity_case flavor identity produced a concrete application ID"
    case "$identity_case" in
      nested|mutation) identity_warning='application ID suffix expression could not be resolved for flavor release' ;;
      inline|duplicate) identity_warning='application ID expression could not be resolved for flavor release' ;;
    esac
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      "\"warnings\":[\"$identity_warning\"]" \
      "$identity_case flavor identity warning changed"
  done

  compact_defaults_project="$INSPECTION_ROOT/compact default config app"
  inspection_make_default_config_case "$compact_defaults_project" compact
  inspection_assert_status 'compact defaultConfig inspection failed' 0 \
    "$INSPECTOR" --project "$compact_defaults_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":"com.example.defaults","namespace":"com.example.defaults","application_id_candidates":["com.example.defaults"]' \
    'compact defaultConfig application ID was not resolved'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"version_name":"7.7.0","version_code":"77"' \
    'compact defaultConfig versions were not resolved'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":[],"failures":[]' \
    'compact defaultConfig emitted warnings'

  for default_case in repeated_dynamic nested
  do
    default_project="$INSPECTION_ROOT/$default_case default config app"
    inspection_make_default_config_case "$default_project" "$default_case"
    inspection_assert_status "$default_case defaultConfig inspection failed" 0 \
      "$INSPECTOR" --project "$default_project" --format json
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      '"application_id":null,"namespace":"com.example.defaults","application_id_candidates":[]' \
      "$default_case defaultConfig returned a stale application ID"
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      '"version_name":null,"version_code":null' \
      "$default_case defaultConfig returned stale versions"
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      '"warnings":["application ID expression could not be resolved","version code expression could not be resolved","version name expression could not be resolved"]' \
      "$default_case defaultConfig warnings changed"
  done

  for property_source in gradle flutter continuation
  do
    duplicate_property_project="$INSPECTION_ROOT/duplicate $property_source properties app"
    inspection_make_duplicate_properties "$duplicate_property_project" "$property_source"
    inspection_assert_status "duplicate $property_source properties inspection failed" 0 \
      "$INSPECTOR" --project "$duplicate_property_project" --format json
    case "$property_source" in
      gradle) expected_duplicate_versions='"version_name":"2.0.0","version_code":"200"' ;;
      flutter) expected_duplicate_versions='"version_name":"4.0.0","version_code":"400"' ;;
      continuation) expected_duplicate_versions='"version_name":null,"version_code":null' ;;
    esac
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      "$expected_duplicate_versions" \
      "duplicate $property_source properties did not use the later entries"
    case "$property_source" in
      continuation)
        inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
          '"warnings":["version code expression could not be resolved","version name expression could not be resolved"],"failures":[]' \
          'continued property lines did not remain conservatively unresolved'
        ;;
      *)
        inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
          '"warnings":[],"failures":[]' \
          "plain duplicate $property_source properties emitted warnings"
        ;;
    esac
  done

  compact_java_project="$INSPECTION_ROOT/compact Java compatibility app"
  inspection_make_java_case "$compact_java_project" compact
  inspection_assert_status 'compact Java compatibility inspection failed' 0 \
    "$INSPECTOR" --project "$compact_java_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"java_compatibility":"8"' \
    'compact Java 8 compatibility was not normalized'

  for java_case in later_override mixed inconsistent
  do
    java_project="$INSPECTION_ROOT/$java_case Java compatibility app"
    inspection_make_java_case "$java_project" "$java_case"
    inspection_assert_status "$java_case Java compatibility inspection failed" 0 \
      "$INSPECTOR" --project "$java_project" --format json
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      '"java_compatibility":null' \
      "$java_case Java compatibility returned a concrete version"
    inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
      '"warnings":["Java compatibility expression could not be resolved"]' \
      "$java_case Java compatibility warning changed"
  done

  compact_release_project="$INSPECTION_ROOT/compact static release app"
  inspection_make_compact_release_case "$compact_release_project" static
  inspection_assert_status 'compact static release inspection failed' 0 \
    "$INSPECTOR" --project "$compact_release_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":"com.example.compactrelease.store","namespace":"com.example.compactrelease","application_id_candidates":["com.example.compactrelease.store"]' \
    'compact static release suffix was not resolved'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"release_signing":true,"release_uses_debug_signing":false' \
    'compact static release signing was not resolved'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":[],"failures":[]' \
    'compact static release emitted warnings'

  compact_dynamic_release_project="$INSPECTION_ROOT/compact dynamic release app"
  inspection_make_compact_release_case "$compact_dynamic_release_project" dynamic
  inspection_assert_status 'compact dynamic release inspection failed' 0 \
    "$INSPECTOR" --project "$compact_dynamic_release_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":"com.example.compactrelease","application_id_candidates":[]' \
    'compact dynamic release produced a concrete application ID'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"release_signing":false,"release_uses_debug_signing":false' \
    'compact conditional release signing produced a false green'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["release application ID suffix expression could not be resolved","release signing expression could not be resolved"]' \
    'compact dynamic release warnings changed'

  multidimension_project="$INSPECTION_ROOT/multiple flavor dimensions app"
  inspection_make_multidimension "$multidimension_project"
  inspection_assert_status 'multiple flavor dimensions did not remain ambiguous' 2 \
    "$INSPECTOR" --project "$multidimension_project" --format json
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":"com.example.multi","application_id_candidates":[]' \
    'multiple flavor dimensions produced nonexistent application-ID candidates'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["flavor dimension expressions prevent deterministic application ID resolution"]' \
    'multiple flavor dimension warning changed'

  override_only_project="$INSPECTION_ROOT/dependency override app"
  inspection_make_groovy "$override_only_project"
  cat > "$override_only_project/pubspec.yaml" <<'YAML'
name: dependency_override_fixture
environment:
  sdk: ">=3.3.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
dependency_overrides:
  build_runner: ^2.4.9
YAML
  inspection_assert_status 'dependency override inspection failed' 0 \
    "$INSPECTOR" --project "$override_only_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"build_runner":false' 'dependency_overrides was treated as a declared build_runner dependency'

  mkdir -p "$INSPECTION_ROOT/no dependency tools"
  for inspection_tool in jq python python3 ruby
  do
    cat > "$INSPECTION_ROOT/no dependency tools/$inspection_tool" <<'SH'
#!/bin/sh
exit 97
SH
    chmod +x "$INSPECTION_ROOT/no dependency tools/$inspection_tool"
  done
  inspection_assert_status 'inspection required a forbidden JSON dependency' 0 \
    env PATH="$INSPECTION_ROOT/no dependency tools:$PATH" \
    "$INSPECTOR" --project "$groovy_project" --format json
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_status 'Firebase inspection required a forbidden JSON dependency' 0 \
    env PATH="$INSPECTION_ROOT/no dependency tools:$PATH" \
    "$INSPECTOR" --project "$kotlin_project" --format json --flavor release
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"firebase_package_names":["com.acme.mobile.release","com.acme.legacy"]' \
    'dependency-free Firebase inspection changed scoped client mappings'

  unresolved_project="$INSPECTION_ROOT/unresolved expressions"
  inspection_make_unresolved "$unresolved_project"
  inspection_assert_status 'unresolved static expressions were treated as executable' 0 \
    "$INSPECTOR" --project "$unresolved_project" --format json
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"application_id":null,"namespace":null,"application_id_candidates":[]' \
    'unresolved identifiers were reported as concrete values'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"warnings":["application ID expression could not be resolved","namespace expression could not be resolved","version code expression could not be resolved","version name expression could not be resolved"]' \
    'unresolved expression warnings changed'

  monorepo_project="$INSPECTION_ROOT/monorepo workspace/apps/mobile"
  mkdir -p "$INSPECTION_ROOT/monorepo workspace"
  printf 'name: fixture_workspace\nworkspace:\n  - apps/mobile\n' \
    > "$INSPECTION_ROOT/monorepo workspace/pubspec.yaml"
  inspection_make_groovy "$monorepo_project"
  inspection_assert_status 'nested monorepo inspection failed' 0 \
    "$INSPECTOR" --project "$monorepo_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"monorepo":true' 'nested monorepo was not detected'

  dirty_project="$INSPECTION_ROOT/dirty git app"
  inspection_make_groovy "$dirty_project"
  git -C "$dirty_project" init -q || fail 'could not initialize Git fixture'
  git -C "$dirty_project" add . || fail 'could not stage Git fixture'
  git -C "$dirty_project" -c user.name=Fixture -c user.email=fixture@example.invalid \
    -c commit.gpgSign=false \
    commit -qm initial || fail 'could not commit Git fixture'
  printf '# dirty\n' >> "$dirty_project/pubspec.yaml"
  inspection_assert_status 'dirty Git inspection failed' 0 \
    "$INSPECTOR" --project "$dirty_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"git_dirty":true' 'dirty Git state was not detected'
  mkdir "$dirty_project/broken git index"
  inspection_assert_status 'Git status failure inspection failed' 0 \
    env GIT_INDEX_FILE="$dirty_project/broken git index" \
    "$INSPECTOR" --project "$dirty_project" --format json
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"git_dirty":null' 'Git status failure was misreported as a clean worktree'
  inspection_assert_json_fragment "$INSPECTION_ROOT/expected-groovy.json" \
    '"git_dirty":null' 'non-Git baseline fixture changed'

  non_flutter_parent="$INSPECTION_ROOT/non Flutter parent"
  inspection_make_groovy "$non_flutter_parent"
  mkdir -p "$non_flutter_parent/nested child"
  inspection_assert_status 'nested non-Flutter path was silently promoted upward' 2 \
    "$INSPECTOR" --project "$non_flutter_parent/nested child" --format json
  assert_empty_file "$INSPECTION_LAST_STDOUT" 'invalid project root emitted partial JSON'
  grep -F 'pubspec.yaml' "$INSPECTION_LAST_STDERR" >/dev/null 2>&1 ||
    fail 'invalid project root did not name the missing Flutter marker'

  both_dsl_project="$INSPECTION_ROOT/both DSL app"
  inspection_make_groovy "$both_dsl_project"
  printf 'android {}\n' > "$both_dsl_project/android/app/build.gradle.kts"
  inspection_assert_status 'both Android DSL files were accepted' 2 \
    "$INSPECTOR" --project "$both_dsl_project" --format json
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"android_dsl":"ambiguous","gradle_file":null' \
    'ambiguous DSL did not emit a complete typed state'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"failures":["android/app contains both build.gradle and build.gradle.kts"]' \
    'ambiguous DSL failure changed'
  grep -F 'both build.gradle and build.gradle.kts' "$INSPECTION_LAST_STDERR" >/dev/null 2>&1 ||
    fail 'ambiguous DSL diagnostic changed'

  missing_dsl_project="$INSPECTION_ROOT/missing DSL app"
  inspection_write_pubspec "$missing_dsl_project" dev_dependencies
  inspection_assert_status 'missing Android DSL file was accepted' 2 \
    "$INSPECTOR" --project "$missing_dsl_project" --format json
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"android_dsl":"missing","gradle_file":null' \
    'missing DSL did not emit a complete typed state'
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"failures":["android/app contains neither build.gradle nor build.gradle.kts"]' \
    'missing DSL failure changed'
  grep -F 'neither build.gradle nor build.gradle.kts' "$INSPECTION_LAST_STDERR" >/dev/null 2>&1 ||
    fail 'missing DSL diagnostic changed'
  inspection_assert_status 'missing Android DSL human report was not clear' 2 \
    "$INSPECTOR" --project "$missing_dsl_project" --format human
  grep -F 'Android DSL: missing' "$INSPECTION_LAST_STDOUT" >/dev/null 2>&1 ||
    fail 'missing DSL human report omitted the DSL state'
  grep -F 'Failures: android/app contains neither build.gradle nor build.gradle.kts' \
    "$INSPECTION_LAST_STDOUT" >/dev/null 2>&1 ||
    fail 'missing DSL human report omitted the failure'

  inspection_assert_status 'missing inspector arguments were accepted' 2 "$INSPECTOR"
  assert_empty_file "$INSPECTION_LAST_STDOUT" 'usage error wrote to stdout'
  grep -F 'Usage:' "$INSPECTION_LAST_STDERR" >/dev/null 2>&1 || fail 'usage diagnostic changed'
  inspection_assert_status 'invalid output format was accepted' 2 \
    "$INSPECTOR" --project "$groovy_project" --format yaml
  assert_empty_file "$INSPECTION_LAST_STDOUT" 'invalid format wrote to stdout'
  inspection_assert_status '--help was accepted after another option' 2 \
    "$INSPECTOR" --project "$groovy_project" --help
  assert_empty_file "$INSPECTION_LAST_STDOUT" 'ambiguous help arguments wrote to stdout'
  inspection_assert_status 'unknown flavor was accepted' 2 \
    "$INSPECTOR" --project "$kotlin_project" --format json --flavor missing
  inspection_assert_schema "$INSPECTION_LAST_STDOUT"
  inspection_assert_json_fragment "$INSPECTION_LAST_STDOUT" \
    '"failures":["requested flavor is not defined"]' \
    'unknown flavor failure changed'

  [ ! -e "$exec_marker" ] || fail 'an inspection mode evaluated the Gradle project'
  inspection_assert_no_canary_logs
  pass 'inspection'
}

project_transaction() {
  TRANSACTION_ROOT="$TMP_ROOT/project transaction/project with spaces"
  TRANSACTION_CANDIDATE="$TMP_ROOT/project transaction/candidate"
  TRANSACTION_LIBRARY="$PACKAGE_ROOT/scripts/lib/project_transaction.sh"
  mkdir -p "$TRANSACTION_ROOT/android/app" "${TRANSACTION_CANDIDATE%/*}"
  printf 'old bytes\r\n' > "$TRANSACTION_ROOT/android/app/build.gradle"
  chmod 640 "$TRANSACTION_ROOT/android/app/build.gradle"
  printf 'new bytes\r\n' > "$TRANSACTION_CANDIDATE"

  # shellcheck source=/dev/null
  . "$TRANSACTION_LIBRARY"
  type fprs_project_transaction_begin >/dev/null 2>&1 ||
    fail 'missing transaction begin function'
  type fprs_project_transaction_register >/dev/null 2>&1 ||
    fail 'missing transaction register function'
  type fprs_project_transaction_validate >/dev/null 2>&1 ||
    fail 'missing transaction validation function'
  type fprs_project_transaction_commit >/dev/null 2>&1 ||
    fail 'missing transaction commit function'

  fprs_project_transaction_begin "$TRANSACTION_ROOT" ||
    fail 'transaction begin failed'
  fprs_project_transaction_register \
    'android/app/build.gradle' "$TRANSACTION_CANDIDATE" ||
    fail 'transaction registration failed'
  fprs_project_transaction_validate ||
    fail 'transaction validation failed'
  fprs_project_transaction_commit ||
    fail 'transaction commit failed'

  assert_same_file "$TRANSACTION_CANDIDATE" \
    "$TRANSACTION_ROOT/android/app/build.gradle" \
    'transaction did not install the registered candidate'
  assert_mode 640 "$TRANSACTION_ROOT/android/app/build.gradle" \
    'transaction did not preserve the existing file mode'

  printf 'created bytes\n' > "$TRANSACTION_CANDIDATE"
  chmod 600 "$TRANSACTION_CANDIDATE"
  fprs_project_transaction_begin "$TRANSACTION_ROOT" ||
    fail 'create transaction begin failed'
  fprs_project_transaction_register \
    'tool/flutter-play-store-release/generated.txt' "$TRANSACTION_CANDIDATE" ||
    fail 'transaction could not register a target with missing parents'
  fprs_project_transaction_validate ||
    fail 'create transaction validation failed'
  fprs_project_transaction_commit ||
    fail 'create transaction commit failed'
  assert_same_file "$TRANSACTION_CANDIDATE" \
    "$TRANSACTION_ROOT/tool/flutter-play-store-release/generated.txt" \
    'transaction did not create a nested target'
  assert_mode 600 \
    "$TRANSACTION_ROOT/tool/flutter-play-store-release/generated.txt" \
    'transaction did not preserve the candidate mode for a created file'

  transaction_outside="$TMP_ROOT/project transaction/outside"
  mkdir -p "$transaction_outside"
  ln -s "$transaction_outside" "$TRANSACTION_ROOT/escape"
  fprs_project_transaction_begin "$TRANSACTION_ROOT" ||
    fail 'containment transaction begin failed'
  if fprs_project_transaction_register 'escape/refused.txt' "$TRANSACTION_CANDIDATE"; then
    fail 'transaction accepted a physical path outside the selected root'
  else
    transaction_status=$?
  fi
  [ "$transaction_status" -eq 2 ] ||
    fail 'physical containment refusal did not return status 2'
  fprs_project_transaction_abort || fail 'containment transaction abort failed'

  transaction_lexical_root="$TMP_ROOT/project transaction/lexical aliases"
  mkdir -p "$transaction_lexical_root/a" "$transaction_lexical_root/b"
  printf 'pre-existing victim\r\n' > "$transaction_lexical_root/b/victim.txt"
  cp "$transaction_lexical_root/b/victim.txt" "$TMP_ROOT/lexical-victim.expected"
  fprs_project_transaction_begin "$transaction_lexical_root" ||
    fail 'lexical-alias transaction begin failed'
  if fprs_project_transaction_register 'a/../b/victim.txt' "$TRANSACTION_CANDIDATE"; then
    fail 'transaction accepted an internal parent traversal segment'
  else
    transaction_status=$?
  fi
  [ "$transaction_status" -eq 2 ] ||
    fail 'internal parent traversal did not return status 2'
  fprs_project_transaction_abort || fail 'lexical-alias transaction abort failed'
  assert_same_file "$TMP_ROOT/lexical-victim.expected" \
    "$transaction_lexical_root/b/victim.txt" \
    'lexical alias registration changed a pre-existing victim'
  for transaction_bad_relative in 'a/./victim.txt' 'a//victim.txt' './victim.txt' 'a/'
  do
    fprs_project_transaction_begin "$transaction_lexical_root" ||
      fail 'ambiguous-relative transaction begin failed'
    if fprs_project_transaction_register "$transaction_bad_relative" \
      "$TRANSACTION_CANDIDATE"
    then
      fail "transaction accepted ambiguous relative path: $transaction_bad_relative"
    fi
    fprs_project_transaction_abort || fail 'ambiguous-relative transaction abort failed'
  done

  trap 'printf prior-hup >/dev/null' HUP
  trap 'printf prior-int >/dev/null' INT
  trap 'printf prior-term >/dev/null' TERM
  transaction_prior_hup=$(trap -p HUP)
  transaction_prior_int=$(trap -p INT)
  transaction_prior_term=$(trap -p TERM)
  fprs_project_transaction_begin "$transaction_lexical_root" ||
    fail 'trap-preservation transaction begin failed'
  fprs_project_transaction_abort || fail 'trap-preservation abort failed'
  [ "$(trap -p HUP)" = "$transaction_prior_hup" ] &&
    [ "$(trap -p INT)" = "$transaction_prior_int" ] &&
    [ "$(trap -p TERM)" = "$transaction_prior_term" ] ||
    fail 'transaction did not restore prior signal traps exactly'
  trap - HUP INT TERM

  transaction_race_root="$TMP_ROOT/project transaction/race"
  mkdir -p "$transaction_race_root"
  fprs_project_transaction_begin "$transaction_race_root" ||
    fail 'race transaction begin failed'
  fprs_project_transaction_register 'pre-existing-untracked.txt' \
    "$TRANSACTION_CANDIDATE" || fail 'race target registration failed'
  printf 'user-created during planning\n' > \
    "$transaction_race_root/pre-existing-untracked.txt"
  if fprs_project_transaction_validate; then
    fail 'transaction ignored a new pre-existing untracked file'
  else
    transaction_status=$?
  fi
  [ "$transaction_status" -eq 2 ] ||
    fail 'new pre-existing path conflict did not return status 2'
  fprs_project_transaction_abort || fail 'race transaction abort failed'
  grep -F 'user-created during planning' \
    "$transaction_race_root/pre-existing-untracked.txt" >/dev/null 2>&1 ||
    fail 'transaction removed a pre-existing untracked file'

  transaction_reject_candidate() { return 1; }
  printf 'validation original\n' > "$transaction_race_root/validation.txt"
  printf 'validation replacement\n' > "$TRANSACTION_CANDIDATE"
  fprs_project_transaction_begin "$transaction_race_root" ||
    fail 'validation transaction begin failed'
  fprs_project_transaction_register validation.txt "$TRANSACTION_CANDIDATE" ||
    fail 'validation target registration failed'
  if fprs_project_transaction_validate transaction_reject_candidate; then
    fail 'transaction accepted a candidate rejected by pre-write validation'
  fi
  fprs_project_transaction_abort || fail 'validation transaction abort failed'
  [ "$(cat "$transaction_race_root/validation.txt")" = 'validation original' ] ||
    fail 'candidate validation failure changed the project'

  transaction_late_root="$TMP_ROOT/project transaction/late target"
  mkdir -p "$transaction_late_root"
  printf 'first original\n' > "$transaction_late_root/first.txt"
  printf 'first replacement\n' > "$TMP_ROOT/late-first.candidate"
  printf 'late replacement\n' > "$TMP_ROOT/late-second.candidate"
  fprs_project_transaction_test_hook() {
    [ "$1" = project-before-target-validation ] || return 0
    [ "$2" = late.txt ] || return 0
    printf 'late user-owned bytes\r\n' > "$transaction_late_root/late.txt"
    chmod 604 "$transaction_late_root/late.txt"
  }
  fprs_project_transaction_begin "$transaction_late_root" ||
    fail 'late-target transaction begin failed'
  fprs_project_transaction_register first.txt "$TMP_ROOT/late-first.candidate" ||
    fail 'late-target first registration failed'
  fprs_project_transaction_register late.txt "$TMP_ROOT/late-second.candidate" ||
    fail 'late-target second registration failed'
  fprs_project_transaction_validate || fail 'late-target global validation failed'
  if FPRS_TEST_MODE=1 fprs_project_transaction_commit; then
    fail 'transaction overwrote a late-created untracked target'
  else
    transaction_status=$?
  fi
  [ "$transaction_status" -eq 3 ] ||
    fail 'late-created target refusal did not return transaction status 3'
  [ "$(cat "$transaction_late_root/first.txt")" = 'first original' ] ||
    fail 'late-target refusal did not roll back an earlier write'
  printf 'late user-owned bytes\r\n' > "$TMP_ROOT/late-user.expected"
  assert_same_file "$TMP_ROOT/late-user.expected" \
    "$transaction_late_root/late.txt" \
    'late-created untracked target was not preserved byte-for-byte'
  assert_mode 604 "$transaction_late_root/late.txt" \
    'late-created untracked target mode changed'
  unset -f fprs_project_transaction_test_hook

  transaction_late_change_root="$TMP_ROOT/project transaction/late changed target"
  mkdir -p "$transaction_late_change_root"
  printf 'first original\n' > "$transaction_late_change_root/first.txt"
  printf 'tracked original\r\n' > "$transaction_late_change_root/tracked.txt"
  chmod 640 "$transaction_late_change_root/tracked.txt"
  fprs_project_transaction_test_hook() {
    [ "$1" = project-before-target-validation ] || return 0
    [ "$2" = tracked.txt ] || return 0
    printf 'late user edit\r\n' > "$transaction_late_change_root/tracked.txt"
    chmod 604 "$transaction_late_change_root/tracked.txt"
  }
  fprs_project_transaction_begin "$transaction_late_change_root" ||
    fail 'late-change transaction begin failed'
  fprs_project_transaction_register first.txt "$TMP_ROOT/late-first.candidate" ||
    fail 'late-change first registration failed'
  fprs_project_transaction_register tracked.txt "$TMP_ROOT/late-second.candidate" ||
    fail 'late-change tracked registration failed'
  fprs_project_transaction_validate || fail 'late-change global validation failed'
  if FPRS_TEST_MODE=1 fprs_project_transaction_commit; then
    fail 'transaction overwrote a late modification to a tracked target'
  else
    transaction_status=$?
  fi
  [ "$transaction_status" -eq 3 ] ||
    fail 'late-modified target refusal did not return transaction status 3'
  [ "$(cat "$transaction_late_change_root/first.txt")" = 'first original' ] ||
    fail 'late-modified target refusal did not roll back an earlier write'
  printf 'late user edit\r\n' > "$TMP_ROOT/late-user-edit.expected"
  assert_same_file "$TMP_ROOT/late-user-edit.expected" \
    "$transaction_late_change_root/tracked.txt" \
    'late modification was not preserved byte-for-byte'
  assert_mode 604 "$transaction_late_change_root/tracked.txt" \
    'late-modified target mode changed'
  unset -f fprs_project_transaction_test_hook

  transaction_swap_root="$TMP_ROOT/project transaction/parent swap"
  transaction_swap_outside="$TMP_ROOT/project transaction/parent swap outside"
  mkdir -p "$transaction_swap_root/safe" "$transaction_swap_outside"
  printf 'swap candidate\n' > "$TMP_ROOT/swap.candidate"
  fprs_project_transaction_test_hook() {
    [ "$1" = project-before-publish ] || return 0
    [ "$2" = safe/victim.txt ] || return 0
    mv "$transaction_swap_root/safe" "$transaction_swap_root/safe-pinned"
    ln -s "$transaction_swap_outside" "$transaction_swap_root/safe"
  }
  fprs_project_transaction_begin "$transaction_swap_root" ||
    fail 'parent-swap transaction begin failed'
  fprs_project_transaction_register safe/victim.txt "$TMP_ROOT/swap.candidate" ||
    fail 'parent-swap target registration failed'
  fprs_project_transaction_validate || fail 'parent-swap validation failed'
  if FPRS_TEST_MODE=1 fprs_project_transaction_commit; then
    fail 'transaction published through a swapped parent path'
  else
    transaction_status=$?
  fi
  [ "$transaction_status" -eq 3 ] ||
    fail 'parent-swap refusal did not return transaction status 3'
  [ ! -e "$transaction_swap_outside/victim.txt" ] ||
    fail 'parent swap escaped the selected physical root'
  [ ! -e "$transaction_swap_root/safe-pinned/victim.txt" ] ||
    fail 'parent-swap refusal left an installed target in the pinned directory'
  if find "$transaction_swap_root/safe-pinned" -name '.fprs-project-write.*' -print |
    grep . >/dev/null 2>&1
  then
    fail 'parent-swap refusal left an invocation-owned temporary file'
  fi
  rm "$transaction_swap_root/safe"
  mv "$transaction_swap_root/safe-pinned" "$transaction_swap_root/safe"
  unset -f fprs_project_transaction_test_hook

  transaction_ancestor_root="$TMP_ROOT/project transaction/ancestor swap"
  transaction_ancestor_outside="$TMP_ROOT/project transaction/ancestor swap outside"
  mkdir -p "$transaction_ancestor_root/outer/safe" \
    "$transaction_ancestor_outside/safe"
  fprs_project_transaction_test_hook() {
    [ "$1" = project-before-publish ] || return 0
    [ "$2" = outer/safe/victim.txt ] || return 0
    mv "$transaction_ancestor_root/outer" \
      "$transaction_ancestor_root/outer-pinned"
    ln -s "$transaction_ancestor_outside" "$transaction_ancestor_root/outer"
  }
  fprs_project_transaction_begin "$transaction_ancestor_root" ||
    fail 'ancestor-swap transaction begin failed'
  fprs_project_transaction_register outer/safe/victim.txt "$TMP_ROOT/swap.candidate" ||
    fail 'ancestor-swap target registration failed'
  fprs_project_transaction_validate || fail 'ancestor-swap validation failed'
  if FPRS_TEST_MODE=1 fprs_project_transaction_commit; then
    fail 'transaction published through a swapped ancestor path'
  else
    transaction_status=$?
  fi
  [ "$transaction_status" -eq 3 ] ||
    fail 'ancestor-swap refusal did not return transaction status 3'
  [ ! -e "$transaction_ancestor_outside/safe/victim.txt" ] ||
    fail 'ancestor swap escaped the selected physical root'
  [ ! -e "$transaction_ancestor_root/outer-pinned/safe/victim.txt" ] ||
    fail 'ancestor-swap refusal installed a target in the pinned directory'
  if find "$transaction_ancestor_root/outer-pinned" \
    -name '.fprs-project-write.*' -print | grep . >/dev/null 2>&1
  then
    fail 'ancestor-swap refusal left an invocation-owned temporary file'
  fi
  rm "$transaction_ancestor_root/outer"
  mv "$transaction_ancestor_root/outer-pinned" "$transaction_ancestor_root/outer"
  unset -f fprs_project_transaction_test_hook

  transaction_failure_root="$TMP_ROOT/project transaction/failure rollback"
  mkdir -p "$transaction_failure_root/data"
  printf 'tracked original\r\n' > "$transaction_failure_root/data/tracked.txt"
  printf 'untracked original\n' > "$transaction_failure_root/data/untracked.txt"
  chmod 640 "$transaction_failure_root/data/tracked.txt"
  chmod 604 "$transaction_failure_root/data/untracked.txt"
  cp "$transaction_failure_root/data/tracked.txt" "$TMP_ROOT/tracked.expected"
  cp "$transaction_failure_root/data/untracked.txt" "$TMP_ROOT/untracked.expected"
  printf 'tracked replacement\n' > "$TMP_ROOT/tracked.candidate"
  printf 'untracked replacement\r\n' > "$TMP_ROOT/untracked.candidate"
  printf 'created replacement\n' > "$TMP_ROOT/created.candidate"
  for transaction_fail_after in 1 2 3
  do
    cp "$TMP_ROOT/tracked.expected" "$transaction_failure_root/data/tracked.txt"
    cp "$TMP_ROOT/untracked.expected" "$transaction_failure_root/data/untracked.txt"
    chmod 640 "$transaction_failure_root/data/tracked.txt"
    chmod 604 "$transaction_failure_root/data/untracked.txt"
    rm -f "$transaction_failure_root/data/created.txt"
    fprs_project_transaction_begin "$transaction_failure_root" ||
      fail 'rollback transaction begin failed'
    fprs_project_transaction_register data/tracked.txt "$TMP_ROOT/tracked.candidate" ||
      fail 'tracked rollback registration failed'
    fprs_project_transaction_register data/untracked.txt "$TMP_ROOT/untracked.candidate" ||
      fail 'untracked rollback registration failed'
    fprs_project_transaction_register data/created.txt "$TMP_ROOT/created.candidate" ||
      fail 'created rollback registration failed'
    fprs_project_transaction_validate || fail 'rollback validation failed'
    if FPRS_TEST_MODE=1 \
      FPRS_TEST_FAIL_PROJECT_WRITE_AFTER=$transaction_fail_after \
      fprs_project_transaction_commit
    then
      fail "injected project write $transaction_fail_after unexpectedly succeeded"
    else
      transaction_status=$?
    fi
    [ "$transaction_status" -eq 3 ] ||
      fail "injected project write $transaction_fail_after did not return status 3"
    assert_same_file "$TMP_ROOT/tracked.expected" \
      "$transaction_failure_root/data/tracked.txt" \
      "tracked bytes changed after injected write $transaction_fail_after"
    assert_same_file "$TMP_ROOT/untracked.expected" \
      "$transaction_failure_root/data/untracked.txt" \
      "untracked bytes changed after injected write $transaction_fail_after"
    assert_mode 640 "$transaction_failure_root/data/tracked.txt" \
      "tracked mode changed after injected write $transaction_fail_after"
    assert_mode 604 "$transaction_failure_root/data/untracked.txt" \
      "untracked mode changed after injected write $transaction_fail_after"
    [ ! -e "$transaction_failure_root/data/created.txt" ] ||
      fail "created path remained after injected write $transaction_fail_after"
    if find "$transaction_failure_root" -name '.fprs-project-write.*' -print |
      grep . >/dev/null 2>&1
    then
      fail "same-directory temporary file remained after injected write $transaction_fail_after"
    fi
  done

  transaction_signal_root="$TMP_ROOT/project transaction/signal"
  transaction_signal_helper="$TMP_ROOT/project transaction/signal-helper.sh"
  mkdir -p "$transaction_signal_root"
  printf 'signal original\r\n' > "$transaction_signal_root/existing.txt"
  chmod 640 "$transaction_signal_root/existing.txt"
  cp "$transaction_signal_root/existing.txt" "$TMP_ROOT/signal.expected"
  printf 'signal replacement\n' > "$TMP_ROOT/signal.candidate"
  cat > "$transaction_signal_helper" <<'SH'
#!/usr/bin/env bash
set -u
. "$1"
fprs_project_transaction_begin "$2" || exit $?
fprs_project_transaction_register existing.txt "$3" || exit $?
fprs_project_transaction_validate || exit $?
fprs_project_transaction_commit
SH
  chmod 700 "$transaction_signal_helper"
  if env FPRS_TEST_MODE=1 FPRS_TEST_SIGNAL_AT=project-write \
    /bin/bash "$transaction_signal_helper" "$TRANSACTION_LIBRARY" \
    "$transaction_signal_root" "$TMP_ROOT/signal.candidate" \
    > "$TMP_ROOT/signal.stdout" 2> "$TMP_ROOT/signal.stderr"
  then
    fail 'injected transaction signal unexpectedly succeeded'
  else
    transaction_status=$?
  fi
  [ "$transaction_status" -eq 3 ] ||
    fail 'injected transaction signal did not return status 3'
  grep -F 'rollback attempted' "$TMP_ROOT/signal.stderr" >/dev/null 2>&1 ||
    fail 'injected transaction signal did not report rollback'
  assert_same_file "$TMP_ROOT/signal.expected" \
    "$transaction_signal_root/existing.txt" \
    'signal rollback changed original bytes'
  assert_mode 640 "$transaction_signal_root/existing.txt" \
    'signal rollback changed original mode'

  transaction_boundary_helper="$TMP_ROOT/project transaction/boundary-helper.sh"
  cat > "$transaction_boundary_helper" <<'SH'
#!/usr/bin/env bash
set -u
. "$1"
root=$2
candidate=$3
boundary=$4
case "$boundary" in
  project-dir-created) relative='nested/path/created.txt' ;;
  *) relative='existing.txt' ;;
esac
fprs_project_transaction_begin "$root" || exit $?
fprs_project_transaction_register "$relative" "$candidate" || exit $?
fprs_project_transaction_validate || exit $?
FPRS_TEST_MODE=1 FPRS_TEST_SIGNAL_AT=$boundary fprs_project_transaction_commit
SH
  chmod 700 "$transaction_boundary_helper"
  for transaction_boundary in project-dir-created project-temp-created project-published
  do
    transaction_boundary_root="$TMP_ROOT/project transaction/boundary $transaction_boundary"
    mkdir -p "$transaction_boundary_root"
    printf 'boundary original\r\n' > "$transaction_boundary_root/existing.txt"
    chmod 640 "$transaction_boundary_root/existing.txt"
    cp "$transaction_boundary_root/existing.txt" "$TMP_ROOT/boundary.expected"
    if /bin/bash "$transaction_boundary_helper" "$TRANSACTION_LIBRARY" \
      "$transaction_boundary_root" "$TMP_ROOT/signal.candidate" \
      "$transaction_boundary" > "$TMP_ROOT/boundary.stdout" \
      2> "$TMP_ROOT/boundary.stderr"
    then
      fail "transaction signal boundary unexpectedly succeeded: $transaction_boundary"
    else
      transaction_status=$?
    fi
    [ "$transaction_status" -eq 3 ] ||
      fail "transaction signal boundary did not return 3: $transaction_boundary"
    assert_same_file "$TMP_ROOT/boundary.expected" \
      "$transaction_boundary_root/existing.txt" \
      "signal boundary changed original bytes: $transaction_boundary"
    assert_mode 640 "$transaction_boundary_root/existing.txt" \
      "signal boundary changed original mode: $transaction_boundary"
    [ ! -e "$transaction_boundary_root/nested" ] ||
      fail "signal boundary left a created directory: $transaction_boundary"
    if find "$transaction_boundary_root" -name '.fprs-project-write.*' -print |
      grep . >/dev/null 2>&1
    then
      fail "signal boundary left a same-directory temp: $transaction_boundary"
    fi
  done

  transaction_control_helper="$TMP_ROOT/project transaction/control-helper.sh"
  cat > "$transaction_control_helper" <<'SH'
#!/usr/bin/env bash
set -u
. "$1"
root=$2
shift 2
fprs_project_transaction_begin "$root" || exit $?
while [ "$#" -gt 0 ]
do
  [ "$#" -ge 2 ] || exit 97
  fprs_project_transaction_register "$1" "$2" || exit $?
  shift 2
done
fprs_project_transaction_validate || exit $?
fprs_project_transaction_commit
SH
  chmod 700 "$transaction_control_helper"
  transaction_wait_for_control_event() {
    transaction_wait_pid=$1
    transaction_wait_file=$2
    transaction_wait_description=$3
    transaction_wait_attempt=0
    while [ "$transaction_wait_attempt" -lt 500 ]
    do
      [ -s "$transaction_wait_file" ] && return 0
      kill -0 "$transaction_wait_pid" 2>/dev/null || break
      sleep 0.01
      transaction_wait_attempt=$((transaction_wait_attempt + 1))
    done
    kill "$transaction_wait_pid" 2>/dev/null || true
    wait "$transaction_wait_pid" 2>/dev/null || true
    fail "$transaction_wait_description"
  }

  case "${FPRS_REVIEW_CASE-all}" in
    all|shell-signal-windows)
      for transaction_boundary in \
        project-dir-created project-temp-created project-published
      do
        transaction_control_root="$TMP_ROOT/project transaction/shell signal $transaction_boundary"
        transaction_control_dir="$TMP_ROOT/project transaction/shell control $transaction_boundary"
        mkdir -p "$transaction_control_root" "$transaction_control_dir"
        printf 'shell signal original\r\n' > "$transaction_control_root/existing.txt"
        chmod 640 "$transaction_control_root/existing.txt"
        cp "$transaction_control_root/existing.txt" "$TMP_ROOT/shell-signal.expected"
        case "$transaction_boundary" in
          project-dir-created)
            transaction_control_relative='nested/path/created.txt'
            transaction_shell_signal=HUP
            ;;
          project-temp-created)
            transaction_control_relative='existing.txt'
            transaction_shell_signal=INT
            ;;
          *)
            transaction_control_relative='existing.txt'
            transaction_shell_signal=TERM
            ;;
        esac
        env FPRS_TEST_MODE=1 \
          FPRS_TEST_CONTROL_DIR="$transaction_control_dir" \
          FPRS_TEST_PAUSE_AT="$transaction_boundary" \
          python3 -c '
import os
import signal
import sys
for caught in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(caught, signal.SIG_DFL)
os.execv(sys.argv[1], sys.argv[1:])
' /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
          "$transaction_control_root" "$transaction_control_relative" \
          "$TMP_ROOT/signal.candidate" > "$transaction_control_dir/stdout" \
          2> "$transaction_control_dir/stderr" &
        transaction_control_pid=$!
        transaction_wait_for_control_event "$transaction_control_pid" \
          "$transaction_control_dir/event" \
          "transaction did not expose shell signal boundary: $transaction_boundary"
        transaction_control_pgid=$(sed -n '1p' "$transaction_control_dir/event")
        kill -s "$transaction_shell_signal" "$transaction_control_pid" 2>/dev/null ||
          fail "could not signal only the transaction shell: $transaction_boundary"
        transaction_wait_attempt=0
        while kill -0 "$transaction_control_pid" 2>/dev/null &&
          [ "$transaction_wait_attempt" -lt 300 ]
        do
          sleep 0.01
          transaction_wait_attempt=$((transaction_wait_attempt + 1))
        done
        if kill -0 "$transaction_control_pid" 2>/dev/null; then
          kill -TERM -- "-$transaction_control_pgid" 2>/dev/null || true
          wait "$transaction_control_pid" 2>/dev/null || true
          fail "transaction shell did not forward and await rollback: $transaction_boundary"
        fi
        if wait "$transaction_control_pid"; then
          fail "shell-only signal unexpectedly succeeded: $transaction_boundary"
        else
          transaction_status=$?
        fi
        [ "$transaction_status" -eq 3 ] ||
          fail "shell-only signal did not return 3: $transaction_boundary"
        grep -F 'rollback attempted' "$transaction_control_dir/stderr" \
          >/dev/null 2>&1 ||
          fail "shell-only signal did not report rollback: $transaction_boundary"
        assert_same_file "$TMP_ROOT/shell-signal.expected" \
          "$transaction_control_root/existing.txt" \
          "shell-only signal changed original bytes: $transaction_boundary"
        assert_mode 640 "$transaction_control_root/existing.txt" \
          "shell-only signal changed original mode: $transaction_boundary"
        [ ! -e "$transaction_control_root/nested" ] ||
          fail "shell-only signal left a created directory: $transaction_boundary"
        if find "$transaction_control_root" -name '.fprs-project-write.*' -print |
          grep . >/dev/null 2>&1
        then
          fail "shell-only signal left a temporary file: $transaction_boundary"
        fi
      done
      ;;
  esac

  case "${FPRS_REVIEW_CASE-all}" in
    all|signal-windows)
      for transaction_boundary in \
        project-dir-created project-temp-created project-published
      do
        transaction_control_root="$TMP_ROOT/project transaction/group signal $transaction_boundary"
        transaction_control_dir="$TMP_ROOT/project transaction/group control $transaction_boundary"
        mkdir -p "$transaction_control_root" "$transaction_control_dir"
        printf 'group original\r\n' > "$transaction_control_root/existing.txt"
        chmod 640 "$transaction_control_root/existing.txt"
        cp "$transaction_control_root/existing.txt" "$TMP_ROOT/group-signal.expected"
        case "$transaction_boundary" in
          project-dir-created) transaction_control_relative='nested/path/created.txt' ;;
          *) transaction_control_relative='existing.txt' ;;
        esac
        env FPRS_TEST_MODE=1 \
          FPRS_TEST_CONTROL_DIR="$transaction_control_dir" \
          FPRS_TEST_PAUSE_AT="$transaction_boundary" \
          /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
          "$transaction_control_root" "$transaction_control_relative" \
          "$TMP_ROOT/signal.candidate" > "$transaction_control_dir/stdout" \
          2> "$transaction_control_dir/stderr" &
        transaction_control_pid=$!
        transaction_wait_for_control_event "$transaction_control_pid" \
          "$transaction_control_dir/event" \
          "single-process transaction did not expose blocked signal window: $transaction_boundary"
        transaction_control_pgid=$(sed -n '1p' "$transaction_control_dir/event")
        case "$transaction_control_pgid" in ''|*[!0-9]*)
          fail "transaction control event omitted a process group: $transaction_boundary" ;;
        esac
        kill -TERM -- "-$transaction_control_pgid" 2>/dev/null ||
          fail "could not deliver process-group signal: $transaction_boundary"
        if wait "$transaction_control_pid"; then
          fail "process-group signal unexpectedly succeeded: $transaction_boundary"
        else
          transaction_status=$?
        fi
        [ "$transaction_status" -eq 3 ] ||
          fail "process-group signal did not return 3: $transaction_boundary"
        assert_same_file "$TMP_ROOT/group-signal.expected" \
          "$transaction_control_root/existing.txt" \
          "process-group signal changed original bytes: $transaction_boundary"
        assert_mode 640 "$transaction_control_root/existing.txt" \
          "process-group signal changed original mode: $transaction_boundary"
        [ ! -e "$transaction_control_root/nested" ] ||
          fail "process-group signal left a created directory: $transaction_boundary"
        if find "$transaction_control_root" -name '.fprs-project-write.*' -print |
          grep . >/dev/null 2>&1
        then
          fail "process-group signal left a temporary file: $transaction_boundary"
        fi
      done
      ;;
  esac

  case "${FPRS_REVIEW_CASE-all}" in
    all|ancestor-rollback)
      transaction_descriptor_root="$TMP_ROOT/project transaction/descriptor rollback"
      transaction_descriptor_outside="$TMP_ROOT/project transaction/descriptor outside"
      transaction_descriptor_control="$TMP_ROOT/project transaction/descriptor control"
      mkdir -p "$transaction_descriptor_root/outer/safe" \
        "$transaction_descriptor_outside/safe" "$transaction_descriptor_control"
      printf 'descriptor original\r\n' > \
        "$transaction_descriptor_root/outer/safe/first.txt"
      chmod 640 "$transaction_descriptor_root/outer/safe/first.txt"
      cp "$transaction_descriptor_root/outer/safe/first.txt" \
        "$TMP_ROOT/descriptor-original.expected"
      printf 'descriptor replacement\n' > "$TMP_ROOT/descriptor-first.candidate"
      printf 'pause original\n' > "$transaction_descriptor_root/pause.txt"
      printf 'pause replacement\n' > "$TMP_ROOT/descriptor-pause.candidate"
      env FPRS_TEST_MODE=1 \
        FPRS_TEST_CONTROL_DIR="$transaction_descriptor_control" \
        FPRS_TEST_PAUSE_AT=project-before-target-validation \
        FPRS_TEST_PAUSE_RELATIVE=pause.txt \
        /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
        "$transaction_descriptor_root" \
        outer/safe/first.txt "$TMP_ROOT/descriptor-first.candidate" \
        pause.txt "$TMP_ROOT/descriptor-pause.candidate" \
        > "$transaction_descriptor_control/stdout" \
        2> "$transaction_descriptor_control/stderr" &
      transaction_control_pid=$!
      transaction_wait_for_control_event "$transaction_control_pid" \
        "$transaction_descriptor_control/event" \
        'transaction did not pause after publishing before ancestor-swap rollback'
      transaction_control_pgid=$(sed -n '1p' "$transaction_descriptor_control/event")
      mv "$transaction_descriptor_root/outer" \
        "$transaction_descriptor_root/outer-pinned"
      ln -s "$transaction_descriptor_outside" "$transaction_descriptor_root/outer"
      kill -TERM -- "-$transaction_control_pgid" 2>/dev/null ||
        fail 'could not signal descriptor rollback transaction'
      if wait "$transaction_control_pid"; then
        fail 'descriptor rollback signal unexpectedly succeeded'
      else
        transaction_status=$?
      fi
      [ "$transaction_status" -eq 3 ] ||
        fail 'descriptor rollback signal did not return status 3'
      assert_same_file "$TMP_ROOT/descriptor-original.expected" \
        "$transaction_descriptor_root/outer-pinned/safe/first.txt" \
        'ancestor swap redirected or prevented descriptor-relative rollback'
      [ ! -e "$transaction_descriptor_outside/safe/first.txt" ] ||
        fail 'ancestor swap redirected rollback outside the project root'
      rm "$transaction_descriptor_root/outer"
      mv "$transaction_descriptor_root/outer-pinned" \
        "$transaction_descriptor_root/outer"
      ;;
  esac

  case "${FPRS_REVIEW_CASE-all}" in
    all|created-replacement)
      transaction_replacement_root="$TMP_ROOT/project transaction/created replacement"
      transaction_replacement_control="$TMP_ROOT/project transaction/replacement control"
      mkdir -p "$transaction_replacement_root" "$transaction_replacement_control"
      printf 'identical created bytes\n' > "$TMP_ROOT/replacement-created.candidate"
      env FPRS_TEST_MODE=1 \
        FPRS_TEST_CONTROL_DIR="$transaction_replacement_control" \
        FPRS_TEST_PAUSE_AT=project-after-publish \
        FPRS_TEST_PAUSE_RELATIVE=created.txt \
        /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
        "$transaction_replacement_root" created.txt \
        "$TMP_ROOT/replacement-created.candidate" \
        > "$transaction_replacement_control/stdout" \
        2> "$transaction_replacement_control/stderr" &
      transaction_control_pid=$!
      transaction_wait_for_control_event "$transaction_control_pid" \
        "$transaction_replacement_control/event" \
        'transaction did not pause after publishing a created target'
      transaction_control_pgid=$(sed -n '1p' "$transaction_replacement_control/event")
      cp "$TMP_ROOT/replacement-created.candidate" \
        "$transaction_replacement_root/user-replacement"
      chmod 644 "$transaction_replacement_root/user-replacement"
      ln "$transaction_replacement_root/user-replacement" \
        "$transaction_replacement_root/user-proof"
      mv -f "$transaction_replacement_root/user-replacement" \
        "$transaction_replacement_root/created.txt"
      kill -TERM -- "-$transaction_control_pgid" 2>/dev/null ||
        fail 'could not signal created-target replacement transaction'
      if wait "$transaction_control_pid"; then
        fail 'created-target replacement signal unexpectedly succeeded'
      else
        transaction_status=$?
      fi
      [ "$transaction_status" -eq 3 ] ||
        fail 'created-target replacement signal did not return status 3'
      [ -f "$transaction_replacement_root/created.txt" ] &&
        [ "$transaction_replacement_root/created.txt" -ef \
          "$transaction_replacement_root/user-proof" ] ||
        fail 'rollback removed a user replacement with candidate-identical bytes'
      ;;
  esac

  case "${FPRS_REVIEW_CASE-all}" in
    all|atomic-cas-gaps)
      transaction_cas_root="$TMP_ROOT/project transaction/forward existing CAS"
      transaction_cas_control="$TMP_ROOT/project transaction/forward existing control"
      mkdir -p "$transaction_cas_root" "$transaction_cas_control"
      printf 'existing CAS original\n' > "$transaction_cas_root/existing.txt"
      printf 'existing CAS candidate\n' > "$TMP_ROOT/existing-cas.candidate"
      env FPRS_TEST_MODE=1 \
        FPRS_TEST_CONTROL_DIR="$transaction_cas_control" \
        FPRS_TEST_PAUSE_AT=project-existing-before-exchange \
        /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
        "$transaction_cas_root" existing.txt "$TMP_ROOT/existing-cas.candidate" \
        > "$transaction_cas_control/stdout" 2> "$transaction_cas_control/stderr" &
      transaction_control_pid=$!
      transaction_wait_for_control_event "$transaction_control_pid" \
        "$transaction_cas_control/event" \
        'transaction did not expose the existing-target atomic exchange boundary'
      printf 'late existing user replacement\n' > "$transaction_cas_root/user-replacement"
      ln "$transaction_cas_root/user-replacement" "$transaction_cas_root/user-proof"
      mv -f "$transaction_cas_root/user-replacement" "$transaction_cas_root/existing.txt"
      : > "$transaction_cas_control/continue"
      if wait "$transaction_control_pid"; then
        fail 'existing-target CAS accepted a late user replacement'
      else
        transaction_status=$?
      fi
      [ "$transaction_status" -eq 3 ] ||
        fail 'existing-target CAS failure did not return status 3'
      [ "$transaction_cas_root/existing.txt" -ef "$transaction_cas_root/user-proof" ] ||
        fail 'existing-target CAS overwrote a late user replacement'

      transaction_cas_root="$TMP_ROOT/project transaction/forward created CAS"
      transaction_cas_control="$TMP_ROOT/project transaction/forward created control"
      mkdir -p "$transaction_cas_root" "$transaction_cas_control"
      printf 'created CAS candidate\n' > "$TMP_ROOT/created-cas.candidate"
      env FPRS_TEST_MODE=1 \
        FPRS_TEST_CONTROL_DIR="$transaction_cas_control" \
        FPRS_TEST_PAUSE_AT=project-created-before-link \
        /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
        "$transaction_cas_root" created.txt "$TMP_ROOT/created-cas.candidate" \
        > "$transaction_cas_control/stdout" 2> "$transaction_cas_control/stderr" &
      transaction_control_pid=$!
      transaction_wait_for_control_event "$transaction_control_pid" \
        "$transaction_cas_control/event" \
        'transaction did not expose the created-target no-replace boundary'
      printf 'late created user replacement\n' > "$transaction_cas_root/user-replacement"
      ln "$transaction_cas_root/user-replacement" "$transaction_cas_root/user-proof"
      mv "$transaction_cas_root/user-replacement" "$transaction_cas_root/created.txt"
      : > "$transaction_cas_control/continue"
      if wait "$transaction_control_pid"; then
        fail 'created-target CAS accepted a late user target'
      else
        transaction_status=$?
      fi
      [ "$transaction_status" -eq 3 ] ||
        fail 'created-target no-replace failure did not return status 3'
      [ "$transaction_cas_root/created.txt" -ef "$transaction_cas_root/user-proof" ] ||
        fail 'created-target publication overwrote a late user target'

      transaction_cas_root="$TMP_ROOT/project transaction/rollback existing CAS"
      transaction_cas_control="$TMP_ROOT/project transaction/rollback existing control"
      mkdir -p "$transaction_cas_root" "$transaction_cas_control"
      printf 'rollback existing original\n' > "$transaction_cas_root/existing.txt"
      printf 'rollback existing candidate\n' > "$TMP_ROOT/rollback-existing.candidate"
      env FPRS_TEST_MODE=1 FPRS_TEST_FAIL_PROJECT_WRITE_AFTER=1 \
        FPRS_TEST_CONTROL_DIR="$transaction_cas_control" \
        FPRS_TEST_PAUSE_AT=project-rollback-existing-before-exchange \
        /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
        "$transaction_cas_root" existing.txt "$TMP_ROOT/rollback-existing.candidate" \
        > "$transaction_cas_control/stdout" 2> "$transaction_cas_control/stderr" &
      transaction_control_pid=$!
      transaction_wait_for_control_event "$transaction_control_pid" \
        "$transaction_cas_control/event" \
        'rollback did not expose the existing-target atomic exchange boundary'
      printf 'rollback existing user replacement\n' > "$transaction_cas_root/user-replacement"
      ln "$transaction_cas_root/user-replacement" "$transaction_cas_root/user-proof"
      mv -f "$transaction_cas_root/user-replacement" "$transaction_cas_root/existing.txt"
      : > "$transaction_cas_control/continue"
      if wait "$transaction_control_pid"; then
        fail 'injected existing-target rollback unexpectedly succeeded'
      else
        transaction_status=$?
      fi
      [ "$transaction_status" -eq 3 ] ||
        fail 'existing-target rollback CAS did not return status 3'
      [ "$transaction_cas_root/existing.txt" -ef "$transaction_cas_root/user-proof" ] ||
        fail 'existing-target rollback CAS overwrote a user replacement'

      transaction_cas_root="$TMP_ROOT/project transaction/rollback created CAS"
      transaction_cas_control="$TMP_ROOT/project transaction/rollback created control"
      mkdir -p "$transaction_cas_root" "$transaction_cas_control"
      printf 'rollback created candidate\n' > "$TMP_ROOT/rollback-created.candidate"
      env FPRS_TEST_MODE=1 FPRS_TEST_FAIL_PROJECT_WRITE_AFTER=1 \
        FPRS_TEST_CONTROL_DIR="$transaction_cas_control" \
        FPRS_TEST_PAUSE_AT=project-rollback-created-before-exchange \
        /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
        "$transaction_cas_root" created.txt "$TMP_ROOT/rollback-created.candidate" \
        > "$transaction_cas_control/stdout" 2> "$transaction_cas_control/stderr" &
      transaction_control_pid=$!
      transaction_wait_for_control_event "$transaction_control_pid" \
        "$transaction_cas_control/event" \
        'rollback did not expose the created-target sentinel exchange boundary'
      printf 'rollback created user replacement\n' > "$transaction_cas_root/user-replacement"
      ln "$transaction_cas_root/user-replacement" "$transaction_cas_root/user-proof"
      mv -f "$transaction_cas_root/user-replacement" "$transaction_cas_root/created.txt"
      : > "$transaction_cas_control/continue"
      if wait "$transaction_control_pid"; then
        fail 'injected created-target rollback unexpectedly succeeded'
      else
        transaction_status=$?
      fi
      [ "$transaction_status" -eq 3 ] ||
        fail 'created-target rollback CAS did not return status 3'
      [ "$transaction_cas_root/created.txt" -ef "$transaction_cas_root/user-proof" ] ||
        fail 'created-target rollback CAS removed a user replacement'
      ;;
  esac

  case "${FPRS_REVIEW_CASE-all}" in
    all|partial-journals)
      for transaction_failure_boundary in \
        project-after-mkdir-syscall \
        project-after-open-syscall \
        project-after-publish-syscall
      do
        transaction_failure_root="$TMP_ROOT/project transaction/journal $transaction_failure_boundary"
        mkdir -p "$transaction_failure_root"
        printf 'journal original\r\n' > "$transaction_failure_root/existing.txt"
        chmod 640 "$transaction_failure_root/existing.txt"
        cp "$transaction_failure_root/existing.txt" "$TMP_ROOT/journal.expected"
        case "$transaction_failure_boundary" in
          project-after-mkdir-syscall)
            transaction_failure_relative='nested/path/created.txt'
            ;;
          *) transaction_failure_relative='existing.txt' ;;
        esac
        if env FPRS_TEST_MODE=1 \
          FPRS_TEST_FAIL_AT="$transaction_failure_boundary" \
          /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
          "$transaction_failure_root" "$transaction_failure_relative" \
          "$TMP_ROOT/signal.candidate" > "$TMP_ROOT/journal.stdout" \
          2> "$TMP_ROOT/journal.stderr"
        then
          fail "post-syscall journal failure unexpectedly succeeded: $transaction_failure_boundary"
        else
          transaction_status=$?
        fi
        [ "$transaction_status" -eq 3 ] ||
          fail "post-syscall journal failure did not return 3: $transaction_failure_boundary"
        assert_same_file "$TMP_ROOT/journal.expected" \
          "$transaction_failure_root/existing.txt" \
          "partial journal changed original bytes: $transaction_failure_boundary"
        assert_mode 640 "$transaction_failure_root/existing.txt" \
          "partial journal changed original mode: $transaction_failure_boundary"
        if [ "$transaction_failure_boundary" = project-after-mkdir-syscall ]; then
          [ -d "$transaction_failure_root/nested" ] ||
            fail 'unknown directory identity was inferred and deleted'
        else
          [ ! -e "$transaction_failure_root/nested" ] ||
            fail "partial directory journal left a created path: $transaction_failure_boundary"
        fi
        if find "$transaction_failure_root" -name '.fprs-project-write.*' -print |
          grep . >/dev/null 2>&1
        then
          fail "partial journal left a temporary file: $transaction_failure_boundary"
        fi
      done
      ;;
  esac

  case "${FPRS_REVIEW_CASE-all}" in
    all|quarantine-delete)
      transaction_quarantine_root="$TMP_ROOT/project transaction/quarantine created file"
      transaction_quarantine_control="$TMP_ROOT/project transaction/quarantine file control"
      mkdir -p "$transaction_quarantine_root" "$transaction_quarantine_control"
      printf 'quarantine file candidate\n' > "$TMP_ROOT/quarantine-file.candidate"
      env FPRS_TEST_MODE=1 FPRS_TEST_FAIL_PROJECT_WRITE_AFTER=1 \
        FPRS_TEST_CONTROL_DIR="$transaction_quarantine_control" \
        FPRS_TEST_PAUSE_AT=project-created-file-quarantined \
        /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
        "$transaction_quarantine_root" created.txt \
        "$TMP_ROOT/quarantine-file.candidate" \
        > "$transaction_quarantine_control/stdout" \
        2> "$transaction_quarantine_control/stderr" &
      transaction_control_pid=$!
      transaction_wait_for_control_event "$transaction_control_pid" \
        "$transaction_quarantine_control/event" \
        'created-file rollback did not expose the quarantine boundary'
      [ ! -e "$transaction_quarantine_root/created.txt" ] ||
        fail 'created-file quarantine did not atomically vacate the canonical path'
      printf 'canonical file user replacement\n' > \
        "$transaction_quarantine_root/user-replacement"
      ln "$transaction_quarantine_root/user-replacement" \
        "$transaction_quarantine_root/user-proof"
      mv "$transaction_quarantine_root/user-replacement" \
        "$transaction_quarantine_root/created.txt"
      : > "$transaction_quarantine_control/continue"
      if wait "$transaction_control_pid"; then
        fail 'injected created-file quarantine rollback unexpectedly succeeded'
      else
        transaction_status=$?
      fi
      [ "$transaction_status" -eq 3 ] ||
        fail 'created-file quarantine rollback did not return status 3'
      [ "$transaction_quarantine_root/created.txt" -ef \
        "$transaction_quarantine_root/user-proof" ] ||
        fail 'created-file quarantine deletion removed the canonical user replacement'
      if find "$transaction_quarantine_root" \
        -name '.fprs-project-quarantine.*' -print | grep . >/dev/null 2>&1
      then
        fail 'created-file quarantine left an owned inode after successful deletion'
      fi

      transaction_quarantine_root="$TMP_ROOT/project transaction/quarantine mismatch restore"
      transaction_quarantine_control="$TMP_ROOT/project transaction/quarantine mismatch control"
      mkdir -p "$transaction_quarantine_root" "$transaction_quarantine_control"
      printf 'quarantine mismatch candidate\n' > \
        "$TMP_ROOT/quarantine-mismatch.candidate"
      env FPRS_TEST_MODE=1 FPRS_TEST_FAIL_PROJECT_WRITE_AFTER=1 \
        FPRS_TEST_CONTROL_DIR="$transaction_quarantine_control" \
        FPRS_TEST_PAUSE_AT=project-after-publish \
        /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
        "$transaction_quarantine_root" created.txt \
        "$TMP_ROOT/quarantine-mismatch.candidate" \
        > "$transaction_quarantine_control/stdout" \
        2> "$transaction_quarantine_control/stderr" &
      transaction_control_pid=$!
      transaction_wait_for_control_event "$transaction_control_pid" \
        "$transaction_quarantine_control/event" \
        'created-file transaction did not expose the pre-rollback replacement boundary'
      printf 'quarantined user mismatch\n' > \
        "$transaction_quarantine_root/user-replacement"
      ln "$transaction_quarantine_root/user-replacement" \
        "$transaction_quarantine_root/user-proof"
      mv -f "$transaction_quarantine_root/user-replacement" \
        "$transaction_quarantine_root/created.txt"
      : > "$transaction_quarantine_control/continue"
      if wait "$transaction_control_pid"; then
        fail 'injected mismatch quarantine rollback unexpectedly succeeded'
      else
        transaction_status=$?
      fi
      [ "$transaction_status" -eq 3 ] ||
        fail 'mismatch quarantine rollback did not return status 3'
      [ "$transaction_quarantine_root/created.txt" -ef \
        "$transaction_quarantine_root/user-proof" ] ||
        fail 'mismatched quarantined user inode was not restored'
      if find "$transaction_quarantine_root" \
        -name '.fprs-project-quarantine.*' -print | grep . >/dev/null 2>&1
      then
        fail 'restored mismatch remained duplicated in quarantine'
      fi

      transaction_quarantine_root="$TMP_ROOT/project transaction/quarantine created directory"
      transaction_quarantine_control="$TMP_ROOT/project transaction/quarantine directory control"
      mkdir -p "$transaction_quarantine_root" "$transaction_quarantine_control"
      printf 'quarantine directory candidate\n' > \
        "$TMP_ROOT/quarantine-directory.candidate"
      env FPRS_TEST_MODE=1 FPRS_TEST_FAIL_PROJECT_WRITE_AFTER=1 \
        FPRS_TEST_CONTROL_DIR="$transaction_quarantine_control" \
        FPRS_TEST_PAUSE_AT=project-created-directory-quarantined \
        /bin/bash "$transaction_control_helper" "$TRANSACTION_LIBRARY" \
        "$transaction_quarantine_root" nested/path/created.txt \
        "$TMP_ROOT/quarantine-directory.candidate" \
        > "$transaction_quarantine_control/stdout" \
        2> "$transaction_quarantine_control/stderr" &
      transaction_control_pid=$!
      transaction_wait_for_control_event "$transaction_control_pid" \
        "$transaction_quarantine_control/event" \
        'created-directory rollback did not expose the quarantine boundary'
      [ ! -e "$transaction_quarantine_root/nested/path" ] ||
        fail 'created-directory quarantine did not atomically vacate the canonical path'
      mkdir "$transaction_quarantine_root/nested/path"
      printf 'canonical directory user replacement\n' > \
        "$transaction_quarantine_root/nested/path/user-proof"
      : > "$transaction_quarantine_control/continue"
      if wait "$transaction_control_pid"; then
        fail 'injected created-directory quarantine rollback unexpectedly succeeded'
      else
        transaction_status=$?
      fi
      [ "$transaction_status" -eq 3 ] ||
        fail 'created-directory quarantine rollback did not return status 3'
      grep -F 'canonical directory user replacement' \
        "$transaction_quarantine_root/nested/path/user-proof" >/dev/null 2>&1 ||
        fail 'created-directory quarantine deletion removed the canonical user replacement'
      if find "$transaction_quarantine_root" \
        -name '.fprs-project-quarantine.*' -print | grep . >/dev/null 2>&1
      then
        fail 'created-directory quarantine failed to restore its nonempty parent'
      fi
      ;;
  esac

  if grep -E 'git[[:space:]]+(checkout|restore|reset)' \
    "$TRANSACTION_LIBRARY" >/dev/null 2>&1
  then
    fail 'project transaction uses Git for restoration'
  fi
  pass 'project_transaction'
}

gradle_signing() {
  GRADLE_ROOT="$TMP_ROOT/gradle signing"
  GRADLE_SOURCE="$GRADLE_ROOT/build.gradle"
  GRADLE_CANDIDATE="$GRADLE_ROOT/build.gradle.candidate"
  GRADLE_LIBRARY="$PACKAGE_ROOT/scripts/lib/gradle_signing.sh"
  mkdir -p "$GRADLE_ROOT"
  cat > "$GRADLE_SOURCE" <<'GRADLE'
android {
    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}
GRADLE

  # shellcheck source=/dev/null
  . "$GRADLE_LIBRARY"
  type fprs_gradle_signing_candidate >/dev/null 2>&1 ||
    fail 'missing Gradle candidate function'
  cp "$GRADLE_SOURCE" "$GRADLE_ROOT/alias-source.expected"
  ln "$GRADLE_SOURCE" "$GRADLE_ROOT/source-hardlink.gradle"
  if fprs_gradle_signing_candidate groovy "$GRADLE_SOURCE" \
    "$GRADLE_ROOT/source-hardlink.gradle"; then
    fail 'Gradle planner accepted a hardlink output alias to its source'
  else
    gradle_status=$?
  fi
  [ "$gradle_status" -eq 2 ] ||
    fail 'Gradle hardlink output alias did not return status 2'
  assert_same_file "$GRADLE_ROOT/alias-source.expected" "$GRADLE_SOURCE" \
    'Gradle hardlink output alias mutated the source'
  ln -s "$GRADLE_SOURCE" "$GRADLE_ROOT/source-symlink.gradle"
  if fprs_gradle_signing_candidate groovy "$GRADLE_SOURCE" \
    "$GRADLE_ROOT/source-symlink.gradle"; then
    fail 'Gradle planner accepted a symlink output alias to its source'
  fi
  printf 'unrelated candidate owner\n' > "$GRADLE_ROOT/existing-output.gradle"
  if fprs_gradle_signing_candidate groovy "$GRADLE_SOURCE" \
    "$GRADLE_ROOT/existing-output.gradle"; then
    fail 'Gradle planner accepted an unsafe pre-existing output'
  fi
  [ "$(cat "$GRADLE_ROOT/existing-output.gradle")" = 'unrelated candidate owner' ] ||
    fail 'Gradle planner changed an unsafe pre-existing output'

  case "${FPRS_GRADLE_REVIEW_CASE-all}" in
    all|late-output-alias)
      gradle_publish_helper="$GRADLE_ROOT/publish-helper.sh"
      cat > "$gradle_publish_helper" <<'SH'
#!/usr/bin/env bash
set -u
. "$1"
fprs_gradle_signing_candidate "$2" "$3" "$4"
SH
      chmod 700 "$gradle_publish_helper"
      for gradle_late_alias_type in symlink hardlink
      do
        gradle_late_control="$GRADLE_ROOT/late-$gradle_late_alias_type-control"
        gradle_late_output="$GRADLE_ROOT/late-$gradle_late_alias_type.gradle"
        mkdir -p "$gradle_late_control"
        env FPRS_TEST_MODE=1 \
          FPRS_TEST_GRADLE_CONTROL_DIR="$gradle_late_control" \
          /bin/bash "$gradle_publish_helper" "$GRADLE_LIBRARY" groovy \
          "$GRADLE_SOURCE" "$gradle_late_output" \
          > "$gradle_late_control/stdout" 2> "$gradle_late_control/stderr" &
        gradle_late_pid=$!
        gradle_late_attempt=0
        while [ "$gradle_late_attempt" -lt 500 ]
        do
          [ -s "$gradle_late_control/before-publish" ] && break
          kill -0 "$gradle_late_pid" 2>/dev/null || break
          sleep 0.01
          gradle_late_attempt=$((gradle_late_attempt + 1))
        done
        if [ ! -s "$gradle_late_control/before-publish" ]; then
          kill "$gradle_late_pid" 2>/dev/null || true
          wait "$gradle_late_pid" 2>/dev/null || true
          fail "Gradle planner did not expose exclusive late-$gradle_late_alias_type publication boundary"
        fi
        case "$gradle_late_alias_type" in
          symlink) ln -s "$GRADLE_SOURCE" "$gradle_late_output" ;;
          hardlink) ln "$GRADLE_SOURCE" "$gradle_late_output" ;;
        esac
        : > "$gradle_late_control/continue"
        if wait "$gradle_late_pid"; then
          fail "Gradle planner followed a late $gradle_late_alias_type output alias"
        else
          gradle_status=$?
        fi
        [ "$gradle_status" -eq 2 ] ||
          fail "late $gradle_late_alias_type output alias did not return status 2"
        assert_same_file "$GRADLE_ROOT/alias-source.expected" "$GRADLE_SOURCE" \
          "late $gradle_late_alias_type output alias mutated the source"
        rm "$gradle_late_output"
      done
      ;;
  esac

  fprs_gradle_signing_candidate groovy "$GRADLE_SOURCE" \
    "$GRADLE_CANDIDATE" || fail 'Groovy Gradle candidate generation failed'
  grep -F 'BEGIN flutter-play-store-release schema=1' \
    "$GRADLE_CANDIDATE" >/dev/null 2>&1 ||
    fail 'Gradle candidate omitted the owned signing block'
  if LC_ALL=C grep "$(printf '\r')" "$GRADLE_CANDIDATE" >/dev/null 2>&1; then
    fail 'Gradle candidate introduced CRLF into an LF source'
  fi
  if grep -F 'signingConfig signingConfigs.debug' \
    "$GRADLE_CANDIDATE" >/dev/null 2>&1; then
    fail 'Gradle candidate retained stock debug release signing'
  fi
  gradle_store_file_count=$(grep -c 'storeFile' "$GRADLE_CANDIDATE")
  [ "$gradle_store_file_count" -gt 0 ] ||
    fail 'Gradle candidate did not connect storeFile'

  for gradle_property in storeFile storePassword keyAlias keyPassword
  do
    gradle_assignment_count=$(grep -Ec \
      "^[[:space:]]*$gradle_property([[:space:]]+|[[:space:]]*=[[:space:]]*)" \
      "$GRADLE_CANDIDATE")
    [ "$gradle_assignment_count" -eq 1 ] ||
      fail "$gradle_property was not connected exactly once in Groovy"
  done
  grep -F 'fprsPropertiesEnvironment = "ANDROID_KEY_PROPERTIES_PATH"' \
    "$GRADLE_CANDIDATE" >/dev/null 2>&1 ||
    fail 'Groovy block omitted the key-properties override'
  grep -F 'providers.environmentVariable(fprsPropertiesEnvironment).orNull' \
    "$GRADLE_CANDIDATE" >/dev/null 2>&1 ||
    fail 'Groovy block does not use its emitted override contract'
  grep -F 'fprsPropertiesFallback = "key.properties"' \
    "$GRADLE_CANDIDATE" >/dev/null 2>&1 ||
    fail 'Groovy block omitted the android/key.properties fallback'
  grep -F 'rootProject.file(fprsPropertiesFallback)' \
    "$GRADLE_CANDIDATE" >/dev/null 2>&1 ||
    fail 'Groovy block does not use its emitted fallback contract'
  grep -F 'gradle.startParameter.taskNames.any' "$GRADLE_CANDIDATE" >/dev/null 2>&1 ||
    fail 'Groovy block does not inspect directly requested tasks'
  gradle_guard_line=$(grep -n 'if (fprsReleaseSigningTaskRequested)' \
    "$GRADLE_CANDIDATE" | sed -n '1s/:.*//p')
  gradle_load_line=$(grep -n 'withInputStream' "$GRADLE_CANDIDATE" |
    sed -n '1s/:.*//p')
  [ -n "$gradle_guard_line" ] && [ -n "$gradle_load_line" ] &&
    [ "$gradle_guard_line" -lt "$gradle_load_line" ] ||
    fail 'Groovy block reads key properties outside the direct release-task guard'
  if grep -E 'taskGraph|println|logger\.' \
    "$GRADLE_CANDIDATE" >/dev/null 2>&1; then
    fail 'Groovy signing guard uses a late task graph or secret-shaped output'
  fi

  cp "$GRADLE_SOURCE" "$GRADLE_ROOT/groovy.source.expected"
  chmod 640 "$GRADLE_SOURCE"
  fprs_gradle_signing_candidate groovy "$GRADLE_CANDIDATE" \
    "$GRADLE_ROOT/groovy.second" || fail 'second Groovy generation failed'
  assert_same_file "$GRADLE_CANDIDATE" "$GRADLE_ROOT/groovy.second" \
    'second Groovy generation changed the candidate'
  assert_same_file "$GRADLE_ROOT/groovy.source.expected" "$GRADLE_SOURCE" \
    'Gradle planner modified its source file'

  gradle_kotlin_source="$GRADLE_ROOT/build.gradle.kts"
  gradle_kotlin_candidate="$GRADLE_ROOT/build.gradle.kts.candidate"
  cat > "$gradle_kotlin_source" <<'KOTLIN'
android {
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
KOTLIN
  chmod 644 "$gradle_kotlin_source"
  fprs_gradle_signing_candidate kotlin "$gradle_kotlin_source" \
    "$gradle_kotlin_candidate" release ||
    fail 'Kotlin Gradle candidate generation failed'
  if grep -F 'signingConfigs.getByName("debug")' \
    "$gradle_kotlin_candidate" >/dev/null 2>&1; then
    fail 'Kotlin Gradle candidate retained stock debug release signing'
  fi
  for gradle_property in storeFile storePassword keyAlias keyPassword
  do
    gradle_assignment_count=$(grep -Ec \
      "^[[:space:]]*$gradle_property[[:space:]]*=" \
      "$gradle_kotlin_candidate")
    [ "$gradle_assignment_count" -eq 1 ] ||
      fail "$gradle_property was not connected exactly once in Kotlin"
  done
  gradle_guard_line=$(grep -n 'if (fprsReleaseSigningTaskRequested)' \
    "$gradle_kotlin_candidate" | sed -n '1s/:.*//p')
  gradle_load_line=$(grep -n 'inputStream().use' "$gradle_kotlin_candidate" |
    sed -n '1s/:.*//p')
  [ -n "$gradle_guard_line" ] && [ -n "$gradle_load_line" ] &&
    [ "$gradle_guard_line" -lt "$gradle_load_line" ] ||
    fail 'Kotlin block reads key properties outside the direct release-task guard'
  assert_mode 644 "$gradle_kotlin_candidate" \
    'Kotlin candidate did not preserve source mode'
  fprs_gradle_signing_candidate kotlin "$gradle_kotlin_candidate" \
    "$GRADLE_ROOT/kotlin.second" release || fail 'second Kotlin generation failed'
  assert_same_file "$gradle_kotlin_candidate" "$GRADLE_ROOT/kotlin.second" \
    'second Kotlin generation changed the candidate'

  case "${FPRS_GRADLE_REVIEW_CASE-all}" in
    all|emitted-guard)
      type fprs_gradle_signing_extract_emitted_contract >/dev/null 2>&1 ||
        fail 'missing emitted Gradle guard contract extractor'
      type fprs_gradle_signing_contract_task_requires_credentials >/dev/null 2>&1 ||
        fail 'missing emitted-contract task evaluator'
      type fprs_gradle_signing_contract_properties_path >/dev/null 2>&1 ||
        fail 'missing emitted-contract properties path evaluator'
      type fprs_gradle_signing_contract_guard_check >/dev/null 2>&1 ||
        fail 'missing emitted-contract credential evaluator'
      type fprs_gradle_signing_validate_emitted_guard >/dev/null 2>&1 ||
        fail 'missing emitted Gradle guard structural validator'
      fprs_gradle_signing_validate_emitted_guard groovy "$GRADLE_CANDIDATE" ||
        fail 'structural validator rejected the emitted Groovy guard'
      fprs_gradle_signing_validate_emitted_guard kotlin "$gradle_kotlin_candidate" ||
        fail 'structural validator rejected the emitted Kotlin guard'
      gradle_mutated_guard="$GRADLE_ROOT/mutated-inverted-guard.gradle"
      awk '
        !changed && /if \(fprsReleaseSigningTaskRequested\)/ {
          sub(/if \(fprsReleaseSigningTaskRequested\)/,
              "if (!fprsReleaseSigningTaskRequested)")
          changed = 1
        }
        { print }
      ' "$GRADLE_CANDIDATE" > "$gradle_mutated_guard"
      if fprs_gradle_signing_validate_emitted_guard groovy "$gradle_mutated_guard"
      then
        fail 'structural validator accepted an inverted release guard'
      else
        gradle_status=$?
      fi
      [ "$gradle_status" -eq 2 ] ||
        fail 'inverted release guard did not return structural status 2'
      gradle_mutated_guard="$GRADLE_ROOT/mutated-task-any.gradle"
      sed 's/gradle\.startParameter\.taskNames\.any/gradle.startParameter.taskNames.collect/' \
        "$GRADLE_CANDIDATE" > "$gradle_mutated_guard"
      if fprs_gradle_signing_validate_emitted_guard groovy "$gradle_mutated_guard"
      then
        fail 'structural validator accepted a guard without requested-task any'
      else
        gradle_status=$?
      fi
      [ "$gradle_status" -eq 2 ] ||
        fail 'removed requested-task any did not return structural status 2'
      gradle_mutated_guard="$GRADLE_ROOT/mutated-load-outside-guard.gradle"
      awk '
        /def fprsKeyProperties =/ {
          print
          print "    fprsKeyPropertiesFile.withInputStream { fprsInput -> fprsKeyProperties.load(fprsInput) }"
          next
        }
        /fprsKeyPropertiesFile\.withInputStream/ { next }
        { print }
      ' "$GRADLE_CANDIDATE" > "$gradle_mutated_guard"
      if fprs_gradle_signing_validate_emitted_guard groovy "$gradle_mutated_guard"
      then
        fail 'structural validator accepted credential loading outside the release guard'
      else
        gradle_status=$?
      fi
      [ "$gradle_status" -eq 2 ] ||
        fail 'unguarded credential load did not return structural status 2'
      gradle_groovy_contract="$GRADLE_ROOT/groovy.contract"
      gradle_kotlin_contract="$GRADLE_ROOT/kotlin.contract"
      fprs_gradle_signing_extract_emitted_contract "$GRADLE_CANDIDATE" \
        "$gradle_groovy_contract" || fail 'could not extract Groovy emitted guard contract'
      fprs_gradle_signing_extract_emitted_contract "$gradle_kotlin_candidate" \
        "$gradle_kotlin_contract" || fail 'could not extract Kotlin emitted guard contract'
      assert_same_file "$gradle_groovy_contract" "$gradle_kotlin_contract" \
        'Groovy and Kotlin emitted different signing guard contracts'
      for gradle_contract_key in \
        terminal_task_prefixes containing_task_prefixes release_token \
        property_keys properties_environment properties_fallback
      do
        gradle_contract_value=$(sed -n \
          "s/^$gradle_contract_key=//p" "$gradle_groovy_contract")
        [ -n "$gradle_contract_value" ] ||
          fail "emitted signing contract omitted $gradle_contract_key"
      done
      for gradle_nonrelease_task in \
        help tasks properties assembleDebug bundleQaDebug testDebugUnitTest lintRelease
      do
        if fprs_gradle_signing_contract_task_requires_credentials \
          "$gradle_groovy_contract" "$gradle_nonrelease_task"
        then
          fail "emitted contract required credentials for $gradle_nonrelease_task"
        fi
      done
      for gradle_release_task in \
        :app:bundleRelease assembleProdRelease publishReleaseBundle
      do
        fprs_gradle_signing_contract_task_requires_credentials \
          "$gradle_groovy_contract" "$gradle_release_task" ||
          fail "emitted contract bypassed credentials for $gradle_release_task"
      done
      gradle_contract_root="$GRADLE_ROOT/emitted contract/android"
      mkdir -p "$gradle_contract_root/app"
      gradle_contract_fallback=$(
        unset ANDROID_KEY_PROPERTIES_PATH
        fprs_gradle_signing_contract_properties_path \
          "$gradle_groovy_contract" "$gradle_contract_root"
      ) || fail 'emitted contract fallback path selection failed'
      [ "$gradle_contract_fallback" = "$gradle_contract_root/key.properties" ] ||
        fail 'emitted contract selected the wrong fallback properties path'
      gradle_contract_environment=$(sed -n \
        's/^properties_environment=//p' "$gradle_groovy_contract")
      gradle_contract_override="$GRADLE_ROOT/emitted-override.properties"
      gradle_contract_selected=$(env \
        "$gradle_contract_environment=$gradle_contract_override" \
        /bin/bash -c '. "$1"; fprs_gradle_signing_contract_properties_path "$2" "$3"' \
        _ "$GRADLE_LIBRARY" "$gradle_groovy_contract" "$gradle_contract_root") ||
        fail 'emitted contract override path selection failed'
      [ "$gradle_contract_selected" = "$gradle_contract_override" ] ||
        fail 'emitted contract did not select its override environment path'
      if fprs_gradle_signing_contract_guard_check "$gradle_groovy_contract" \
        assembleDebug "$gradle_contract_root" \
        > "$GRADLE_ROOT/emitted-debug.stdout" \
        2> "$GRADLE_ROOT/emitted-debug.stderr"
      then
        :
      else
        fail 'emitted contract required credentials for a debug task'
      fi
      if fprs_gradle_signing_contract_guard_check "$gradle_groovy_contract" \
        bundleRelease "$gradle_contract_root" \
        > "$GRADLE_ROOT/emitted-release.stdout" \
        2> "$GRADLE_ROOT/emitted-release.stderr"
      then
        fail 'emitted contract accepted missing release credentials'
      fi
      printf 'emitted keystore bytes\n' > "$gradle_contract_root/app/upload.jks"
      cat > "$gradle_contract_root/key.properties" <<'PROPERTIES'
storeFile=upload.jks
storePassword=FPRS_EMITTED_STORE_PASSWORD_CANARY_72ae
keyAlias=FPRS_EMITTED_ALIAS_CANARY_2c41
keyPassword=FPRS_EMITTED_KEY_PASSWORD_CANARY_693b
PROPERTIES
      fprs_gradle_signing_contract_guard_check "$gradle_groovy_contract" \
        publishReleaseBundle "$gradle_contract_root" \
        > "$GRADLE_ROOT/emitted-valid.stdout" \
        2> "$GRADLE_ROOT/emitted-valid.stderr" ||
        fail 'emitted contract rejected complete fallback credentials'
      cp "$gradle_contract_root/key.properties" "$gradle_contract_override"
      env "$gradle_contract_environment=$gradle_contract_override" \
        /bin/bash -c '. "$1"; fprs_gradle_signing_contract_guard_check "$2" assembleProdRelease "$3"' \
        _ "$GRADLE_LIBRARY" "$gradle_groovy_contract" "$gradle_contract_root" \
        > "$GRADLE_ROOT/emitted-override.stdout" \
        2> "$GRADLE_ROOT/emitted-override.stderr" ||
        fail 'emitted contract rejected complete override credentials'
      if grep -R -E 'FPRS_EMITTED_(STORE_PASSWORD|ALIAS|KEY_PASSWORD)_CANARY' \
        "$GRADLE_ROOT"/*.stdout "$GRADLE_ROOT"/*.stderr >/dev/null 2>&1
      then
        fail 'emitted signing contract leaked a credential value'
      fi
      ;;
  esac

  gradle_crlf_source="$GRADLE_ROOT/crlf build.gradle"
  gradle_crlf_candidate="$GRADLE_ROOT/crlf candidate.gradle"
  awk '{ printf "%s\r\n", $0 }' "$GRADLE_SOURCE" > "$gradle_crlf_source"
  chmod 604 "$gradle_crlf_source"
  fprs_gradle_signing_candidate groovy "$gradle_crlf_source" \
    "$gradle_crlf_candidate" || fail 'CRLF Gradle generation failed'
  awk 'substr($0, length($0), 1) != "\r" { exit 1 }' \
    "$gradle_crlf_candidate" || fail 'Gradle candidate changed CRLF line endings'
  assert_mode 604 "$gradle_crlf_candidate" \
    'Gradle candidate changed a nondefault file mode'

  gradle_custom_source="$GRADLE_ROOT/custom signing.gradle"
  gradle_custom_candidate="$GRADLE_ROOT/custom candidate.gradle"
  cat > "$gradle_custom_source" <<'GRADLE'
android {
    signingConfigs {
        upload {
            storeFile file("user-owned.jks")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.upload
        }
    }
}
GRADLE
  fprs_gradle_signing_candidate groovy "$gradle_custom_source" \
    "$gradle_custom_candidate" || fail 'valid user-owned signing was rejected'
  [ "$FPRS_GRADLE_SIGNING_CLASSIFICATION" = preserve ] ||
    fail 'valid user-owned signing was not classified as preserve'
  assert_same_file "$gradle_custom_source" "$gradle_custom_candidate" \
    'valid user-owned signing was modified'

  gradle_conflict_source="$GRADLE_ROOT/conflict.gradle"
  cat > "$gradle_conflict_source" <<'GRADLE'
android {
    buildTypes {
        release {
            signingConfig signingConfigs.debug
            signingConfig signingConfigs.release
        }
    }
}
GRADLE
  if fprs_gradle_signing_candidate groovy "$gradle_conflict_source" \
    "$GRADLE_ROOT/conflict.candidate"; then
    fail 'simultaneous debug and release signing was accepted'
  else
    gradle_status=$?
  fi
  [ "$gradle_status" -eq 2 ] ||
    fail 'simultaneous signing conflict did not return status 2'

  cat > "$gradle_conflict_source" <<'GRADLE'
android {
    buildTypes {
        release {
            signingConfig signingConfigs.upload
        }
    }
}
GRADLE
  if fprs_gradle_signing_candidate groovy "$gradle_conflict_source" \
    "$GRADLE_ROOT/missing-config.candidate"; then
    fail 'undeclared custom signing config was accepted'
  fi

  cat > "$gradle_conflict_source" <<'GRADLE'
android {
    // BEGIN flutter-play-store-release schema=1
    // END flutter-play-store-release
    // BEGIN flutter-play-store-release schema=1
    // END flutter-play-store-release
}
GRADLE
  if fprs_gradle_signing_candidate groovy "$gradle_conflict_source" \
    "$GRADLE_ROOT/multiple-marker.candidate"; then
    fail 'multiple owned marker blocks were accepted'
  fi

  cat > "$gradle_conflict_source" <<'GRADLE'
// BEGIN flutter-play-store-release schema=1
// END flutter-play-store-release
android {
}
GRADLE
  if fprs_gradle_signing_candidate groovy "$gradle_conflict_source" \
    "$GRADLE_ROOT/outside-marker.candidate"; then
    fail 'owned marker outside the structural android scope was accepted'
  fi

  cat > "$gradle_conflict_source" <<'GRADLE'
/*
// BEGIN flutter-play-store-release schema=1
// END flutter-play-store-release
android {
    buildTypes { release { signingConfig signingConfigs.debug } }
}
*/
def documentation = """
android {
    // BEGIN flutter-play-store-release schema=1
    buildTypes { release { signingConfig signingConfigs.debug } }
    // END flutter-play-store-release
}
"""
android {
}
GRADLE
  fprs_gradle_signing_candidate groovy "$gradle_conflict_source" \
    "$GRADLE_ROOT/comment-string.candidate" ||
    fail 'marker/scope text inside comments or multiline strings caused a conflict'
  grep -F 'def documentation = """' "$GRADLE_ROOT/comment-string.candidate" \
    >/dev/null 2>&1 || fail 'Gradle planner did not preserve multiline user text'

  case "${FPRS_GRADLE_REVIEW_CASE-all}" in
    all|compact-signing)
      if [ "${FPRS_COMPACT_SIGNING_DSL-all}" != kotlin ]; then
        gradle_compact_source="$GRADLE_ROOT/compact-signing.gradle"
        cat > "$gradle_compact_source" <<'GRADLE'
android {
    buildTypes { release { signingConfig signingConfigs.debug } }
}
GRADLE
        cp "$gradle_compact_source" "$GRADLE_ROOT/compact-signing.expected"
        if fprs_gradle_signing_candidate groovy "$gradle_compact_source" \
          "$GRADLE_ROOT/compact-signing.candidate"
        then
          fail 'compact Groovy debug signing was merged with generated release signing'
        else
          gradle_status=$?
        fi
        [ "$gradle_status" -eq 2 ] ||
          fail 'compact Groovy signing conflict did not return status 2'
        [ ! -e "$GRADLE_ROOT/compact-signing.candidate" ] ||
          fail 'compact Groovy signing conflict published a candidate'
        assert_same_file "$GRADLE_ROOT/compact-signing.expected" \
          "$gradle_compact_source" \
          'compact Groovy signing conflict changed the source'

        gradle_unsupported_selector="$GRADLE_ROOT/unsupported-selector.gradle"
        cat > "$gradle_unsupported_selector" <<'GRADLE'
android {
    buildTypes {
        getByName('release') {
            signingConfig signingConfigs.debug
        }
    }
}
GRADLE
        cp "$gradle_unsupported_selector" \
          "$GRADLE_ROOT/unsupported-selector.expected"
        if fprs_gradle_signing_candidate groovy \
          "$gradle_unsupported_selector" \
          "$GRADLE_ROOT/unsupported-selector.candidate"
        then
          fail 'unsupported release selector retained debug signing during merge'
        else
          gradle_status=$?
        fi
        [ "$gradle_status" -eq 2 ] ||
          fail 'unsupported release selector conflict did not return status 2'
        [ ! -e "$GRADLE_ROOT/unsupported-selector.candidate" ] ||
          fail 'unsupported release selector conflict published a candidate'
        assert_same_file "$GRADLE_ROOT/unsupported-selector.expected" \
          "$gradle_unsupported_selector" \
          'unsupported release selector conflict changed the source'

        gradle_multi_token_source="$GRADLE_ROOT/multi-token-signing.gradle"
        cat > "$gradle_multi_token_source" <<'GRADLE'
def signingConfig = null; android { buildTypes { release { signingConfig signingConfigs.debug } } }
android {
}
GRADLE
        cp "$gradle_multi_token_source" \
          "$GRADLE_ROOT/multi-token-signing.expected"
        if fprs_gradle_signing_candidate groovy "$gradle_multi_token_source" \
          "$GRADLE_ROOT/multi-token-signing.candidate"
        then
          fail 'later same-line signing token retained debug signing during merge'
        else
          gradle_status=$?
        fi
        [ "$gradle_status" -eq 2 ] ||
          fail 'multi-token signing conflict did not return status 2'
        [ ! -e "$GRADLE_ROOT/multi-token-signing.candidate" ] ||
          fail 'multi-token signing conflict published a candidate'
        assert_same_file "$GRADLE_ROOT/multi-token-signing.expected" \
          "$gradle_multi_token_source" \
          'multi-token signing conflict changed the source'

        gradle_adjacent_token_source="$GRADLE_ROOT/adjacent-token-signing.gradle"
        cat > "$gradle_adjacent_token_source" <<'GRADLE'
def signingConfig = null; android {signingConfig signingConfigs.debug}
android {
}
GRADLE
        cp "$gradle_adjacent_token_source" \
          "$GRADLE_ROOT/adjacent-token-signing.expected"
        if fprs_gradle_signing_candidate groovy \
          "$gradle_adjacent_token_source" \
          "$GRADLE_ROOT/adjacent-token-signing.candidate"
        then
          fail 'brace-adjacent signing token was missed during merge'
        else
          gradle_status=$?
        fi
        [ "$gradle_status" -eq 2 ] ||
          fail 'brace-adjacent signing conflict did not return status 2'
        [ ! -e "$GRADLE_ROOT/adjacent-token-signing.candidate" ] ||
          fail 'brace-adjacent signing conflict published a candidate'
        assert_same_file "$GRADLE_ROOT/adjacent-token-signing.expected" \
          "$gradle_adjacent_token_source" \
          'brace-adjacent signing conflict changed the source'
      fi

      if [ "${FPRS_COMPACT_SIGNING_DSL-all}" != groovy ]; then
        gradle_compact_kotlin_source="$GRADLE_ROOT/compact-signing.gradle.kts"
        cat > "$gradle_compact_kotlin_source" <<'KOTLIN'
android {
    buildTypes { getByName("release") { signingConfig = signingConfigs.getByName("debug") } }
}
KOTLIN
        cp "$gradle_compact_kotlin_source" \
          "$GRADLE_ROOT/compact-signing-kotlin.expected"
        if fprs_gradle_signing_candidate kotlin "$gradle_compact_kotlin_source" \
          "$GRADLE_ROOT/compact-signing-kotlin.candidate"
        then
          fail 'compact Kotlin debug signing was merged with generated release signing'
        else
          gradle_status=$?
        fi
        [ "$gradle_status" -eq 2 ] ||
          fail 'compact Kotlin signing conflict did not return status 2'
        [ ! -e "$GRADLE_ROOT/compact-signing-kotlin.candidate" ] ||
          fail 'compact Kotlin signing conflict published a candidate'
        assert_same_file "$GRADLE_ROOT/compact-signing-kotlin.expected" \
          "$gradle_compact_kotlin_source" \
          'compact Kotlin signing conflict changed the source'

        gradle_compact_decoy="$GRADLE_ROOT/compact-signing-decoy.gradle.kts"
        cat > "$gradle_compact_decoy" <<'KOTLIN'
/* android { buildTypes { getByName("release") { signingConfig = signingConfigs.getByName("debug") } } } */
val compactSigningDocumentation = "android { buildTypes { release { signingConfig signingConfigs.debug } } }"
android {
}
KOTLIN
        fprs_gradle_signing_candidate kotlin "$gradle_compact_decoy" \
          "$GRADLE_ROOT/compact-signing-decoy.candidate" ||
          fail 'compact signing text inside comments or strings caused a conflict'
        grep -F 'val compactSigningDocumentation' \
          "$GRADLE_ROOT/compact-signing-decoy.candidate" >/dev/null 2>&1 ||
          fail 'compact signing string decoy was not preserved'
      fi
      ;;
  esac

  case "${FPRS_GRADLE_REVIEW_CASE-all}" in
    all|slashy-strings)
      cat > "$gradle_conflict_source" <<'GRADLE'
def slashyDocumentation = /
android {
    \/\/ BEGIN flutter-play-store-release schema=1
    buildTypes { release { signingConfig signingConfigs.debug } }
    \/\/ END flutter-play-store-release
}
/
def dollarSlashyDocumentation = $/
android {
    // BEGIN flutter-play-store-release schema=1
    buildTypes { release { signingConfig signingConfigs.debug } }
    // END flutter-play-store-release
}
/$
def escapedDollarSlashyDocumentation = $/
$/$$
}
// BEGIN flutter-play-store-release schema=1
android { buildTypes { release { signingConfig signingConfigs.debug } } }
// END flutter-play-store-release
/$
android {
}
GRADLE
      fprs_gradle_signing_candidate groovy "$gradle_conflict_source" \
        "$GRADLE_ROOT/slashy-string.candidate" ||
        fail 'slashy or dollar-slashy documentation changed structural Gradle scanning'
      grep -F 'def dollarSlashyDocumentation = $/' \
        "$GRADLE_ROOT/slashy-string.candidate" >/dev/null 2>&1 ||
        fail 'Gradle planner did not preserve dollar-slashy user text'
      ;;
  esac

  case "${FPRS_GRADLE_REVIEW_CASE-all}" in
    all|setter-signing)
      gradle_setter_source="$GRADLE_ROOT/setter-signing.gradle"
      cat > "$gradle_setter_source" <<'GRADLE'
android {
    signingConfigs {
        upload {
            storeFile file("user-owned.jks")
        }
    }
    buildTypes {
        release {
            setSigningConfig(signingConfigs.upload)
        }
    }
}
GRADLE
      fprs_gradle_signing_candidate groovy "$gradle_setter_source" \
        "$GRADLE_ROOT/setter-signing.candidate" ||
        fail 'declared setter-form user signing was rejected'
      [ "$FPRS_GRADLE_SIGNING_CLASSIFICATION" = preserve ] ||
        fail 'setter-form user signing was not classified as preserve'
      assert_same_file "$gradle_setter_source" \
        "$GRADLE_ROOT/setter-signing.candidate" \
        'setter-form user signing was overwritten by an owned block'

      gradle_setter_kotlin_source="$GRADLE_ROOT/setter-signing.gradle.kts"
      cat > "$gradle_setter_kotlin_source" <<'KOTLIN'
android {
    signingConfigs {
        create("upload") {
            storeFile = file("user-owned.jks")
        }
    }
    buildTypes {
        getByName("release") {
            setSigningConfig(signingConfigs.getByName("upload"))
        }
    }
}
KOTLIN
      fprs_gradle_signing_candidate kotlin "$gradle_setter_kotlin_source" \
        "$GRADLE_ROOT/setter-signing-kotlin.candidate" ||
        fail 'declared Kotlin setter-form user signing was rejected'
      [ "$FPRS_GRADLE_SIGNING_CLASSIFICATION" = preserve ] ||
        fail 'Kotlin setter-form user signing was not classified as preserve'
      assert_same_file "$gradle_setter_kotlin_source" \
        "$GRADLE_ROOT/setter-signing-kotlin.candidate" \
        'Kotlin setter-form user signing was overwritten by an owned block'

      gradle_unbalanced_setter="$GRADLE_ROOT/unbalanced-setter.gradle"
      cat > "$gradle_unbalanced_setter" <<'GRADLE'
android {
    signingConfigs {
        upload {
            storeFile file("user-owned.jks")
        }
    }
    buildTypes {
        release {
            setSigningConfig(signingConfigs.upload
        }
    }
}
GRADLE
      if fprs_gradle_signing_candidate groovy "$gradle_unbalanced_setter" \
        "$GRADLE_ROOT/unbalanced-setter.candidate"
      then
        fail 'missing-close setter syntax was accepted as direct signing'
      else
        gradle_status=$?
      fi
      [ "$gradle_status" -eq 2 ] ||
        fail 'missing-close setter syntax did not return status 2'

      cat > "$gradle_unbalanced_setter" <<'GRADLE'
android {
    signingConfigs {
        upload {
            storeFile file("user-owned.jks")
        }
    }
    buildTypes {
        release {
            setSigningConfig signingConfigs.upload)
        }
    }
}
GRADLE
      if fprs_gradle_signing_candidate groovy "$gradle_unbalanced_setter" \
        "$GRADLE_ROOT/unbalanced-command-setter.candidate"
      then
        fail 'missing-open setter syntax was accepted as direct signing'
      else
        gradle_status=$?
      fi
      [ "$gradle_status" -eq 2 ] ||
        fail 'missing-open setter syntax did not return status 2'
      ;;
  esac

  cat > "$gradle_conflict_source" <<'GRADLE'
android {
    buildTypes {
        release {
        }
    }
    buildTypes {
        release {
        }
    }
}
GRADLE
  if fprs_gradle_signing_candidate groovy "$gradle_conflict_source" \
    "$GRADLE_ROOT/multiple-release.candidate"; then
    fail 'multiple structural release scopes were accepted'
  else
    gradle_status=$?
  fi
  [ "$gradle_status" -eq 2 ] ||
    fail 'multiple release scopes did not return status 2'

  cat > "$gradle_conflict_source" <<'GRADLE'
// android { }
android {
}
android {
}
GRADLE
  if fprs_gradle_signing_candidate groovy "$gradle_conflict_source" \
    "$GRADLE_ROOT/multiple-android.candidate"; then
    fail 'multiple structural android scopes were accepted'
  fi

  type fprs_gradle_signing_task_requires_credentials >/dev/null 2>&1 ||
    fail 'missing pure Gradle release-task guard helper'
  type fprs_gradle_signing_properties_path >/dev/null 2>&1 ||
    fail 'missing pure key-properties path helper'
  type fprs_gradle_signing_guard_check >/dev/null 2>&1 ||
    fail 'missing pure signing credential guard helper'
  for gradle_nonrelease_task in help tasks properties assembleDebug bundleQaDebug testDebugUnitTest lintRelease
  do
    if fprs_gradle_signing_task_requires_credentials "$gradle_nonrelease_task"; then
      fail "non-signing task required release credentials: $gradle_nonrelease_task"
    fi
  done
  for gradle_release_task in :app:bundleRelease assembleProdRelease publishReleaseBundle
  do
    fprs_gradle_signing_task_requires_credentials "$gradle_release_task" ||
      fail "release signing task bypassed credentials: $gradle_release_task"
  done
  gradle_guard_root="$GRADLE_ROOT/guard project/android"
  mkdir -p "$gradle_guard_root/app"
  gradle_fallback_path=$(unset ANDROID_KEY_PROPERTIES_PATH; \
    fprs_gradle_signing_properties_path "$gradle_guard_root") ||
    fail 'key-properties fallback resolution failed'
  [ "$gradle_fallback_path" = "$gradle_guard_root/key.properties" ] ||
    fail 'key-properties fallback did not resolve under the Android root'
  gradle_override_path=$(ANDROID_KEY_PROPERTIES_PATH="$GRADLE_ROOT/override.properties" \
    fprs_gradle_signing_properties_path "$gradle_guard_root") ||
    fail 'key-properties override resolution failed'
  [ "$gradle_override_path" = "$GRADLE_ROOT/override.properties" ] ||
    fail 'ANDROID_KEY_PROPERTIES_PATH did not take precedence'
  if ! fprs_gradle_signing_guard_check assembleDebug \
    "$GRADLE_ROOT/missing.properties" "$gradle_guard_root/app" \
    > "$GRADLE_ROOT/debug-guard.stdout" 2> "$GRADLE_ROOT/debug-guard.stderr"
  then
    fail 'debug task required missing release credentials'
  fi
  assert_empty_file "$GRADLE_ROOT/debug-guard.stdout" \
    'debug signing guard wrote output'
  assert_empty_file "$GRADLE_ROOT/debug-guard.stderr" \
    'debug signing guard emitted a credential diagnostic'
  if fprs_gradle_signing_guard_check bundleRelease \
    "$GRADLE_ROOT/missing.properties" "$gradle_guard_root/app" \
    > "$GRADLE_ROOT/release-guard.stdout" 2> "$GRADLE_ROOT/release-guard.stderr"
  then
    fail 'release task accepted missing signing properties'
  fi
  grep -F 'release signing properties file is missing' \
    "$GRADLE_ROOT/release-guard.stderr" >/dev/null 2>&1 ||
    fail 'release signing guard omitted a redacted missing-file diagnostic'
  printf 'keystore bytes\n' > "$GRADLE_ROOT/upload.jks"
  cat > "$GRADLE_ROOT/valid.properties" <<PROPERTIES
storeFile=$GRADLE_ROOT/upload.jks
storePassword=FPRS_STORE_PASSWORD_CANARY_ef52
keyAlias=FPRS_ALIAS_CANARY_6b31
keyPassword=FPRS_KEY_PASSWORD_CANARY_91ad
PROPERTIES
  fprs_gradle_signing_guard_check publishReleaseBundle \
    "$GRADLE_ROOT/valid.properties" "$gradle_guard_root/app" \
    > "$GRADLE_ROOT/valid-guard.stdout" 2> "$GRADLE_ROOT/valid-guard.stderr" ||
    fail 'release task rejected complete signing credentials'
  assert_empty_file "$GRADLE_ROOT/valid-guard.stdout" \
    'valid signing guard wrote output'
  assert_empty_file "$GRADLE_ROOT/valid-guard.stderr" \
    'valid signing guard wrote a diagnostic'
  if grep -R -E 'FPRS_(STORE_PASSWORD|ALIAS|KEY_PASSWORD)_CANARY' \
    "$GRADLE_ROOT"/*.stderr "$GRADLE_ROOT"/*.stdout >/dev/null 2>&1; then
    fail 'signing guard leaked a credential value'
  fi
  pass 'gradle_signing'
}

bootstrap_core_run() {
  bootstrap_description=$1
  bootstrap_expected_status=$2
  shift 2
  bootstrap_case_index=$((bootstrap_case_index + 1))
  BOOTSTRAP_LAST_STDOUT="$BOOTSTRAP_LOGS/$bootstrap_case_index.stdout"
  BOOTSTRAP_LAST_STDERR="$BOOTSTRAP_LOGS/$bootstrap_case_index.stderr"
  if "$@" > "$BOOTSTRAP_LAST_STDOUT" 2> "$BOOTSTRAP_LAST_STDERR"; then
    bootstrap_actual_status=0
  else
    bootstrap_actual_status=$?
  fi
  if [ "$bootstrap_actual_status" -ne "$bootstrap_expected_status" ]; then
    sed -n '1,120p' "$BOOTSTRAP_LAST_STDOUT" >&2
    sed -n '1,120p' "$BOOTSTRAP_LAST_STDERR" >&2
    fail "$bootstrap_description (expected exit $bootstrap_expected_status, got $bootstrap_actual_status)"
  fi
}

bootstrap_core() {
  BOOTSTRAP="$PACKAGE_ROOT/scripts/bootstrap_android_fastlane.sh"
  BOOTSTRAP_ROOT="$TMP_ROOT/bootstrap core"
  BOOTSTRAP_LOGS="$BOOTSTRAP_ROOT/logs"
  bootstrap_case_index=0
  mkdir -p "$BOOTSTRAP_LOGS"

  bootstrap_dry_project="$BOOTSTRAP_ROOT/dry run project with spaces"
  bootstrap_dry_baseline="$BOOTSTRAP_ROOT/dry baseline"
  inspection_make_minimal_kotlin "$bootstrap_dry_project"
  cp -R "$bootstrap_dry_project" "$bootstrap_dry_baseline"
  bootstrap_core_run 'fresh bootstrap dry run failed' 0 \
    "$BOOTSTRAP" --project "$bootstrap_dry_project" --dry-run
  diff -r "$bootstrap_dry_baseline" "$bootstrap_dry_project" >/dev/null 2>&1 ||
    fail 'bootstrap dry run changed the project'
  bootstrap_plan_count=$(grep -c '^PLAN ' "$BOOTSTRAP_LAST_STDOUT" || true)
  [ "$bootstrap_plan_count" -eq 15 ] ||
    fail "bootstrap dry run did not plan all 15 targets (got $bootstrap_plan_count)"
  awk '/^PLAN / { print $3 }' "$BOOTSTRAP_LAST_STDOUT" > "$BOOTSTRAP_ROOT/plan.paths"
  LC_ALL=C sort "$BOOTSTRAP_ROOT/plan.paths" > "$BOOTSTRAP_ROOT/plan.sorted"
  assert_same_file "$BOOTSTRAP_ROOT/plan.sorted" "$BOOTSTRAP_ROOT/plan.paths" \
    'bootstrap plan was not sorted by target path'
  grep -F 'PLAN merge android/app/build.gradle.kts' \
    "$BOOTSTRAP_LAST_STDOUT" >/dev/null 2>&1 ||
    fail 'bootstrap did not classify the Gradle candidate as a merge'
  grep -F 'PLAN create android/Gemfile' "$BOOTSTRAP_LAST_STDOUT" >/dev/null 2>&1 ||
    fail 'bootstrap did not classify an absent generated target as create'
  ! grep -E '^APPLY ' "$BOOTSTRAP_LAST_STDOUT" >/dev/null 2>&1 ||
    fail 'bootstrap dry run reported applied changes'

  bootstrap_conflict_project="$BOOTSTRAP_ROOT/conflict project"
  inspection_make_minimal_kotlin "$bootstrap_conflict_project"
  mkdir -p "$bootstrap_conflict_project/.github/workflows"
  printf 'name: user-owned workflow\n' > \
    "$bootstrap_conflict_project/.github/workflows/release-android.yml"
  cp -R "$bootstrap_conflict_project" "$BOOTSTRAP_ROOT/conflict baseline"
  bootstrap_core_run 'default bootstrap conflict did not fail' 2 \
    "$BOOTSTRAP" --project "$bootstrap_conflict_project" --dry-run
  grep -F 'PLAN fail-conflict .github/workflows/release-android.yml' \
    "$BOOTSTRAP_LAST_STDOUT" >/dev/null 2>&1 ||
    fail 'default conflict was not classified as fail-conflict'
  diff -r "$BOOTSTRAP_ROOT/conflict baseline" "$bootstrap_conflict_project" \
    >/dev/null 2>&1 || fail 'conflict planning changed the project'

  bootstrap_core_run 'skip conflict did not report incomplete setup' 1 \
    "$BOOTSTRAP" --project "$bootstrap_conflict_project" \
    --dry-run --conflict skip
  grep -F 'PLAN skip-conflict .github/workflows/release-android.yml' \
    "$BOOTSTRAP_LAST_STDOUT" >/dev/null 2>&1 ||
    fail 'skip conflict was not classified as skip-conflict'
  diff -r "$BOOTSTRAP_ROOT/conflict baseline" "$bootstrap_conflict_project" \
    >/dev/null 2>&1 || fail 'skip conflict changed the project'

  bootstrap_skip_apply_project="$BOOTSTRAP_ROOT/skip apply project"
  inspection_make_minimal_kotlin "$bootstrap_skip_apply_project"
  mkdir -p "$bootstrap_skip_apply_project/.github/workflows"
  printf 'name: preserved user workflow\n' > \
    "$bootstrap_skip_apply_project/.github/workflows/release-android.yml"
  cp -R "$bootstrap_skip_apply_project" "$BOOTSTRAP_ROOT/skip apply baseline"
  bootstrap_core_run 'non-dry skip did not report incomplete setup' 1 \
    "$BOOTSTRAP" --project "$bootstrap_skip_apply_project" --conflict skip
  diff -r "$BOOTSTRAP_ROOT/skip apply baseline" "$bootstrap_skip_apply_project" \
    >/dev/null 2>&1 || fail 'non-dry skip made partial project changes'

  bootstrap_core_run 'missing bootstrap arguments were accepted' 2 "$BOOTSTRAP"
  bootstrap_core_run 'invalid conflict mode was accepted' 2 \
    "$BOOTSTRAP" --project "$bootstrap_dry_project" --conflict overwrite

  bootstrap_apply_project="$BOOTSTRAP_ROOT/apply project"
  inspection_make_minimal_kotlin "$bootstrap_apply_project"
  bootstrap_core_run 'fresh bootstrap apply failed' 0 \
    "$BOOTSTRAP" --project "$bootstrap_apply_project"
  grep -F 'APPLY merge android/app/build.gradle.kts' \
    "$BOOTSTRAP_LAST_STDOUT" >/dev/null 2>&1 ||
    fail 'bootstrap apply did not report the committed Gradle merge'
  grep -F 'APPLY create android/Gemfile' \
    "$BOOTSTRAP_LAST_STDOUT" >/dev/null 2>&1 ||
    fail 'bootstrap apply did not report the committed file creation'
  grep -F 'BEGIN flutter-play-store-release schema=1' \
    "$bootstrap_apply_project/android/app/build.gradle.kts" >/dev/null 2>&1 ||
    fail 'bootstrap apply did not install the Gradle signing candidate'
  for bootstrap_created_path in \
    android/Gemfile \
    android/fastlane/Fastfile \
    .github/workflows/release-android.yml \
    docs/PLAY_STORE_RELEASE.md \
    tool/flutter-play-store-release/decode_secret.sh \
    tool/flutter-play-store-release/managed-files.sha256
  do
    [ -f "$bootstrap_apply_project/$bootstrap_created_path" ] ||
      fail "bootstrap apply omitted $bootstrap_created_path"
  done
  cp -R "$bootstrap_apply_project" "$BOOTSTRAP_ROOT/apply baseline"
  bootstrap_core_run 'second bootstrap apply failed' 0 \
    "$BOOTSTRAP" --project "$bootstrap_apply_project"
  diff -r "$BOOTSTRAP_ROOT/apply baseline" "$bootstrap_apply_project" \
    >/dev/null 2>&1 || fail 'second bootstrap apply changed the project'

  bootstrap_merge_project="$BOOTSTRAP_ROOT/merge ownership project"
  inspection_make_minimal_kotlin "$bootstrap_merge_project"
  mkdir -p "$bootstrap_merge_project/android/fastlane"
  printf 'source "https://rubygems.org"\n' > "$bootstrap_merge_project/android/Gemfile"
  printf 'platform :android do\nend\n' > "$bootstrap_merge_project/android/fastlane/Fastfile"
  printf '# user plugin declarations\n' > "$bootstrap_merge_project/android/fastlane/Pluginfile"
  bootstrap_core_run 'first merge bootstrap failed' 0 \
    "$BOOTSTRAP" --project "$bootstrap_merge_project"
  for bootstrap_merge_path in \
    android/Gemfile android/fastlane/Fastfile android/fastlane/Pluginfile
  do
    bootstrap_marker_count=$(grep -c '^# BEGIN flutter-play-store-release schema=1$' \
      "$bootstrap_merge_project/$bootstrap_merge_path")
    [ "$bootstrap_marker_count" -eq 1 ] ||
      fail "first merge did not create one owned block: $bootstrap_merge_path"
  done
  cp -R "$bootstrap_merge_project" "$BOOTSTRAP_ROOT/merge ownership baseline"
  bootstrap_core_run 'second merge bootstrap failed' 0 \
    "$BOOTSTRAP" --project "$bootstrap_merge_project"
  diff -r "$BOOTSTRAP_ROOT/merge ownership baseline" "$bootstrap_merge_project" \
    >/dev/null 2>&1 || fail 'second merge bootstrap appended or changed an owned block'

  bootstrap_bad_marker_project="$BOOTSTRAP_ROOT/malformed merge marker project"
  inspection_make_minimal_kotlin "$bootstrap_bad_marker_project"
  printf '# BEGIN flutter-play-store-release schema=1\n' > \
    "$bootstrap_bad_marker_project/android/Gemfile"
  bootstrap_core_run 'malformed merge marker was accepted' 2 \
    "$BOOTSTRAP" --project "$bootstrap_bad_marker_project" --dry-run
  grep -F 'PLAN fail-conflict android/Gemfile' "$BOOTSTRAP_LAST_STDOUT" \
    >/dev/null 2>&1 || fail 'malformed merge marker was not planned as a conflict'

  for bootstrap_fail_after in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
  do
    bootstrap_failure_project="$BOOTSTRAP_ROOT/failure $bootstrap_fail_after"
    bootstrap_failure_baseline="$BOOTSTRAP_ROOT/failure baseline $bootstrap_fail_after"
    inspection_make_minimal_kotlin "$bootstrap_failure_project"
    cp -R "$bootstrap_failure_project" "$bootstrap_failure_baseline"
    bootstrap_core_run "bootstrap write failure $bootstrap_fail_after did not roll back" 3 \
      env FPRS_TEST_MODE=1 \
      FPRS_TEST_FAIL_PROJECT_WRITE_AFTER="$bootstrap_fail_after" \
      "$BOOTSTRAP" --project "$bootstrap_failure_project"
    grep -F 'rollback attempted' "$BOOTSTRAP_LAST_STDERR" >/dev/null 2>&1 ||
      fail "bootstrap write failure $bootstrap_fail_after did not report rollback"
    diff -r "$bootstrap_failure_baseline" "$bootstrap_failure_project" \
      >/dev/null 2>&1 ||
      fail "bootstrap write failure $bootstrap_fail_after changed project bytes"
  done
  pass 'bootstrap_core'
}

bootstrap_full_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

bootstrap_full_assert_snapshot() {
  expected_tree=$1
  actual_tree=$2
  description=$3
  diff -r "$expected_tree" "$actual_tree" >/dev/null 2>&1 ||
    fail "$description"
}

bootstrap_full_assert_sidecar() {
  project=$1
  sidecar="$project/tool/flutter-play-store-release/managed-files.sha256"
  [ -f "$sidecar" ] || fail 'bootstrap omitted the managed-file sidecar'
  [ "$(sed -n '1p' "$sidecar")" = 'package_id=flutter-play-store-release' ] ||
    fail 'managed-file sidecar omitted the package identity'
  [ "$(sed -n '2p' "$sidecar")" = 'schema_version=1' ] ||
    fail 'managed-file sidecar omitted the schema version'
  sed -n '3,$p' "$sidecar" > "$BOOTSTRAP_FULL_ROOT/sidecar.records"
  [ -s "$BOOTSTRAP_FULL_ROOT/sidecar.records" ] ||
    fail 'managed-file sidecar omitted body hashes'
  : > "$BOOTSTRAP_FULL_ROOT/sidecar.paths"
  while IFS=' ' read -r managed_hash managed_path managed_extra
  do
    [ -n "$managed_hash" ] && [ -n "$managed_path" ] && [ -z "$managed_extra" ] ||
      fail 'managed-file sidecar contains a malformed record'
    case "$managed_hash" in
      *[!0-9a-f]*|'') fail 'managed-file sidecar contains a non-SHA-256 hash' ;;
    esac
    [ "${#managed_hash}" -eq 64 ] ||
      fail 'managed-file sidecar contains a non-SHA-256 hash'
    [ "$managed_path" != 'tool/flutter-play-store-release/managed-files.sha256' ] ||
      fail 'managed-file sidecar hashes itself'
    [ -f "$project/$managed_path" ] && [ ! -L "$project/$managed_path" ] ||
      fail "managed-file sidecar names an invalid file: $managed_path"
    [ "$(bootstrap_full_sha256 "$project/$managed_path")" = "$managed_hash" ] ||
      fail "managed-file sidecar hash does not match: $managed_path"
    printf '%s\n' "$managed_path" >> "$BOOTSTRAP_FULL_ROOT/sidecar.paths"
  done < "$BOOTSTRAP_FULL_ROOT/sidecar.records"
  LC_ALL=C sort -u "$BOOTSTRAP_FULL_ROOT/sidecar.paths" > \
    "$BOOTSTRAP_FULL_ROOT/sidecar.paths.sorted"
  assert_same_file "$BOOTSTRAP_FULL_ROOT/sidecar.paths.sorted" \
    "$BOOTSTRAP_FULL_ROOT/sidecar.paths" \
    'managed-file sidecar paths are not sorted and unique'
}

bootstrap_full_conflict() {
  description=$1
  project=$2
  baseline=$3
  bootstrap_full_run "$description" 2 "$BOOTSTRAP" --project "$project"
  bootstrap_full_assert_snapshot "$baseline" "$project" \
    "$description changed the project before reporting the conflict"
}

bootstrap_full_run() {
  bootstrap_description=$1
  bootstrap_expected_status=$2
  shift 2
  bootstrap_case_index=$((bootstrap_case_index + 1))
  BOOTSTRAP_LAST_STDOUT="$BOOTSTRAP_FULL_LOGS/$bootstrap_case_index.stdout"
  BOOTSTRAP_LAST_STDERR="$BOOTSTRAP_FULL_LOGS/$bootstrap_case_index.stderr"
  if "$@" > "$BOOTSTRAP_LAST_STDOUT" 2> "$BOOTSTRAP_LAST_STDERR"; then
    bootstrap_actual_status=0
  else
    bootstrap_actual_status=$?
  fi
  if [ "$bootstrap_actual_status" -ne "$bootstrap_expected_status" ]; then
    sed -n '1,120p' "$BOOTSTRAP_LAST_STDOUT" >&2
    sed -n '1,120p' "$BOOTSTRAP_LAST_STDERR" >&2
    fail "$bootstrap_description (expected exit $bootstrap_expected_status, got $bootstrap_actual_status)"
  fi
}

bootstrap_full() {
  BOOTSTRAP="$PACKAGE_ROOT/scripts/bootstrap_android_fastlane.sh"
  BOOTSTRAP_FULL_ROOT="$TMP_ROOT/bootstrap full"
  BOOTSTRAP_FULL_LOGS="$BOOTSTRAP_FULL_ROOT/logs"
  bootstrap_case_index=0
  mkdir -p "$BOOTSTRAP_FULL_LOGS"

  full_project="$BOOTSTRAP_FULL_ROOT/fresh project"
  inspection_make_minimal_kotlin "$full_project"
  bootstrap_full_run 'full bootstrap failed for an absent target set' 0 \
    "$BOOTSTRAP" --project "$full_project"
  cat > "$BOOTSTRAP_FULL_ROOT/generated.paths" <<'PATHS'
.github/workflows/release-android.yml
.gitignore
android/Gemfile
android/Gemfile.lock
android/app/build.gradle.kts
android/fastlane/.env.example
android/fastlane/Appfile
android/fastlane/Fastfile
android/fastlane/Pluginfile
android/fastlane/lib/flutter_play_store_release.rb
android/key.properties.example
docs/PLAY_STORE_RELEASE.md
tool/flutter-play-store-release/decode_secret.sh
tool/flutter-play-store-release/install_flutter_sdk.sh
tool/flutter-play-store-release/managed-files.sha256
PATHS
  while IFS= read -r generated_path
  do
    [ -f "$full_project/$generated_path" ] ||
      fail "full bootstrap omitted generated path: $generated_path"
  done < "$BOOTSTRAP_FULL_ROOT/generated.paths"
  bootstrap_full_assert_sidecar "$full_project"
  grep -F 'android/Gemfile.lock' "$BOOTSTRAP_FULL_ROOT/sidecar.paths" >/dev/null 2>&1 ||
    fail 'managed-file sidecar omitted Gemfile.lock'
  grep -F 'APP_PACKAGE_NAME=com.example.kotlin' \
    "$full_project/android/fastlane/.env.example" >/dev/null 2>&1 ||
    fail 'bootstrap did not substitute the inspected application ID'
  for generated_helper in decode_secret.sh install_flutter_sdk.sh
  do
    assert_same_file "$PACKAGE_ROOT/scripts/$generated_helper" \
      "$full_project/tool/flutter-play-store-release/$generated_helper" \
      "bootstrap did not copy CI helper $generated_helper byte-for-byte"
  done
  for ignore_line in \
    'android/fastlane/.env' 'android/key.properties' 'android/*.jks' \
    'android/*.keystore' 'google-play-service-account.json' \
    '**/google-play-service-account.json' 'fastlane/report.xml' \
    'fastlane/Preview.html' 'fastlane/screenshots/' 'fastlane/test_output/'
  do
    [ "$(grep -F -x -c -- "$ignore_line" "$full_project/.gitignore")" -eq 1 ] ||
      fail "bootstrap did not merge one exact ignore rule: $ignore_line"
  done
  if git -C "$full_project" check-ignore --no-index -q \
    android/fastlane/.env.example android/key.properties.example 2>/dev/null; then
    fail 'bootstrap ignore rules made example files uncommittable'
  fi
  if rg -n 'CHANGE_ME_APPLICATION_ID' "$full_project" \
    -g '!android/fastlane/.env.example' -g '!docs/PLAY_STORE_RELEASE.md' \
    >/dev/null 2>&1; then
    fail 'resolved bootstrap left an active application-ID placeholder'
  fi
  cp -R "$full_project" "$BOOTSTRAP_FULL_ROOT/fresh baseline"
  bootstrap_full_run 'second full bootstrap was not idempotent' 0 \
    "$BOOTSTRAP" --project "$full_project"
  bootstrap_full_assert_snapshot "$BOOTSTRAP_FULL_ROOT/fresh baseline" \
    "$full_project" 'second full bootstrap changed the project'

  dry_project="$BOOTSTRAP_FULL_ROOT/deterministic dry run"
  inspection_make_minimal_kotlin "$dry_project"
  bootstrap_full_run 'first deterministic dry run failed' 0 \
    "$BOOTSTRAP" --project "$dry_project" --dry-run
  cp "$BOOTSTRAP_LAST_STDOUT" "$BOOTSTRAP_FULL_ROOT/dry.stdout"
  cp "$BOOTSTRAP_LAST_STDERR" "$BOOTSTRAP_FULL_ROOT/dry.stderr"
  bootstrap_full_run 'second deterministic dry run failed' 0 \
    "$BOOTSTRAP" --project "$dry_project" --dry-run
  assert_same_file "$BOOTSTRAP_FULL_ROOT/dry.stdout" "$BOOTSTRAP_LAST_STDOUT" \
    'bootstrap dry-run stdout was not deterministic'
  assert_same_file "$BOOTSTRAP_FULL_ROOT/dry.stderr" "$BOOTSTRAP_LAST_STDERR" \
    'bootstrap dry-run stderr was not deterministic'

  owned_package="$BOOTSTRAP_FULL_ROOT/package copy"
  cp -R "$PACKAGE_ROOT" "$owned_package"
  owned_project="$BOOTSTRAP_FULL_ROOT/owned update project"
  inspection_make_minimal_kotlin "$owned_project"
  bootstrap_full_run 'initial owned-file bootstrap failed' 0 \
    "$owned_package/scripts/bootstrap_android_fastlane.sh" --project "$owned_project"
  printf '# canonical update\n' >> "$owned_package/templates/Appfile"
  bootstrap_full_run 'verified owned file was not safely updated' 0 \
    "$owned_package/scripts/bootstrap_android_fastlane.sh" --project "$owned_project"
  grep -F '# canonical update' "$owned_project/android/fastlane/Appfile" >/dev/null 2>&1 ||
    fail 'verified owned Appfile was not updated from the canonical template'
  grep -F 'PLAN update-owned android/fastlane/Appfile' \
    "$BOOTSTRAP_LAST_STDOUT" >/dev/null 2>&1 ||
    fail 'verified owned Appfile was not classified as update-owned'

  edited_project="$BOOTSTRAP_FULL_ROOT/edited owned project"
  inspection_make_minimal_kotlin "$edited_project"
  bootstrap_full_run 'initial edited-owned fixture bootstrap failed' 0 \
    "$BOOTSTRAP" --project "$edited_project"
  printf '# user edit\n' >> "$edited_project/android/fastlane/Appfile"
  cp -R "$edited_project" "$BOOTSTRAP_FULL_ROOT/edited owned baseline"
  bootstrap_full_conflict 'edited owned file was overwritten' "$edited_project" \
    "$BOOTSTRAP_FULL_ROOT/edited owned baseline"

  merge_project="$BOOTSTRAP_FULL_ROOT/safe merge project"
  inspection_make_minimal_kotlin "$merge_project"
  mkdir -p "$merge_project/android/fastlane"
  printf 'source "https://rubygems.org"\n' > "$merge_project/android/Gemfile"
  printf 'platform :ios do\n  lane :custom do\n  end\nend\n' > \
    "$merge_project/android/fastlane/Fastfile"
  printf '# existing compatible plugin file\n' > \
    "$merge_project/android/fastlane/Pluginfile"
  bootstrap_full_run 'safe Gemfile/Fastfile/Pluginfile merge failed' 0 \
    "$BOOTSTRAP" --project "$merge_project"
  ruby -c "$merge_project/android/Gemfile" >/dev/null 2>&1 ||
    fail 'merged Gemfile is not valid Ruby'
  ruby -c "$merge_project/android/fastlane/Fastfile" >/dev/null 2>&1 ||
    fail 'merged Fastfile is not valid Ruby'
  grep -F 'gem "fastlane", "= 2.237.0"' "$merge_project/android/Gemfile" >/dev/null 2>&1 ||
    fail 'safe Gemfile merge omitted the exact Fastlane pin'
  [ "$(grep -c 'eval_gemfile' "$merge_project/android/Gemfile")" -eq 1 ] ||
    fail 'safe Gemfile merge did not produce exactly one Pluginfile import'
  grep -F 'gem "fastlane-plugin-firebase_app_distribution", "= 1.0.0"' \
    "$merge_project/android/fastlane/Pluginfile" >/dev/null 2>&1 ||
    fail 'safe Pluginfile merge omitted the exact plugin pin'
  for required_lane in doctor prepare build release release_play_store firebase_distribution
  do
    [ "$(grep -E -c "lane[[:space:]]+:$required_lane([^A-Za-z0-9_]|$)" \
      "$merge_project/android/fastlane/Fastfile")" -eq 1 ] ||
      fail "safe Fastfile merge omitted or duplicated lane: $required_lane"
  done

  bundle_stub_dir="$BOOTSTRAP_FULL_ROOT/bundle stub"
  mkdir -p "$bundle_stub_dir"
  cat > "$bundle_stub_dir/bundle" <<'SH'
#!/bin/sh
set -u
[ "$#" -eq 3 ] && [ "$1" = '_4.0.16_' ] && [ "$2" = lock ] &&
  [ "$3" = --local ] || exit 91
[ -n "${BUNDLE_GEMFILE:-}" ] && [ -f "$BUNDLE_GEMFILE" ] || exit 92
[ -n "${FPRS_TEST_BUNDLE_LOCK_FIXTURE:-}" ] &&
  [ -f "$FPRS_TEST_BUNDLE_LOCK_FIXTURE" ] || exit 93
printf '%s\n' "$*" > "${FPRS_TEST_BUNDLE_MARKER:?}"
cp "$FPRS_TEST_BUNDLE_LOCK_FIXTURE" "${BUNDLE_GEMFILE}.lock"
SH
  chmod 755 "$bundle_stub_dir/bundle"
  awk '
    /^  fastlane-plugin-firebase_app_distribution \(= 1\.0\.0\)$/ {
      print
      print "  rake (= 13.4.2)"
      next
    }
    { print }
  ' "$PACKAGE_ROOT/templates/Gemfile.lock" > "$BOOTSTRAP_FULL_ROOT/extra-dependency.lock"

  extra_dependency_project="$BOOTSTRAP_FULL_ROOT/extra dependency merge"
  inspection_make_minimal_kotlin "$extra_dependency_project"
  printf '%s\n' \
    'source "https://rubygems.org"' \
    'gem "rake", "= 13.4.2"' > "$extra_dependency_project/android/Gemfile"
  bootstrap_full_run 'compatible extra dependency produced a stale canonical lock' 0 \
    env PATH="$bundle_stub_dir:$PATH" \
    FPRS_TEST_BUNDLE_LOCK_FIXTURE="$BOOTSTRAP_FULL_ROOT/extra-dependency.lock" \
    FPRS_TEST_BUNDLE_MARKER="$BOOTSTRAP_FULL_ROOT/bundle-local.marker" \
    "$BOOTSTRAP" --project "$extra_dependency_project"
  [ "$(cat "$BOOTSTRAP_FULL_ROOT/bundle-local.marker" 2>/dev/null)" = \
    '_4.0.16_ lock --local' ] ||
    fail 'merged dependency lock was not regenerated with exact Bundler local mode'
  grep -F '  rake (= 13.4.2)' "$extra_dependency_project/android/Gemfile.lock" \
    >/dev/null 2>&1 || fail 'regenerated lock omitted the compatible extra dependency'

  bundle_failure_dir="$BOOTSTRAP_FULL_ROOT/failing bundle stub"
  mkdir -p "$bundle_failure_dir"
  cat > "$bundle_failure_dir/bundle" <<'SH'
#!/bin/sh
printf '%s\n' "$*" > "${FPRS_TEST_BUNDLE_MARKER:?}"
exit 17
SH
  chmod 755 "$bundle_failure_dir/bundle"
  extra_failure_project="$BOOTSTRAP_FULL_ROOT/extra dependency unavailable"
  inspection_make_minimal_kotlin "$extra_failure_project"
  printf '%s\n' \
    'source "https://rubygems.org"' \
    'gem "rake", "= 13.4.2"' > "$extra_failure_project/android/Gemfile"
  cp -R "$extra_failure_project" "$BOOTSTRAP_FULL_ROOT/extra dependency unavailable baseline"
  bootstrap_full_run 'unavailable local dependency did not conflict before writes' 2 \
    env PATH="$bundle_failure_dir:$PATH" \
    FPRS_TEST_BUNDLE_MARKER="$BOOTSTRAP_FULL_ROOT/bundle-failure.marker" \
    "$BOOTSTRAP" --project "$extra_failure_project"
  [ "$(cat "$BOOTSTRAP_FULL_ROOT/bundle-failure.marker" 2>/dev/null)" = \
    '_4.0.16_ lock --local' ] ||
    fail 'local dependency failure did not use exact Bundler local mode'
  bootstrap_full_assert_snapshot \
    "$BOOTSTRAP_FULL_ROOT/extra dependency unavailable baseline" \
    "$extra_failure_project" 'local dependency failure made project changes'

  direct_eval_project="$BOOTSTRAP_FULL_ROOT/direct eval import"
  inspection_make_minimal_kotlin "$direct_eval_project"
  cat > "$direct_eval_project/android/Gemfile" <<'RUBY'
source "https://rubygems.org"
gem "fastlane", "= 2.237.0"
eval_gemfile(File.join(__dir__, "fastlane", "Pluginfile")) if File.exist?(File.join(__dir__, "fastlane", "Pluginfile"))
RUBY
  bootstrap_full_run 'matching direct Pluginfile import was rejected' 0 \
    "$BOOTSTRAP" --project "$direct_eval_project"

  variable_eval_project="$BOOTSTRAP_FULL_ROOT/variable eval import"
  inspection_make_minimal_kotlin "$variable_eval_project"
  cat > "$variable_eval_project/android/Gemfile" <<'RUBY'
source "https://rubygems.org"
gem "fastlane", "= 2.237.0"
plugins_path = File.join(__dir__, "fastlane", "Pluginfile")
eval_gemfile(plugins_path) if File.exist?(plugins_path)
RUBY
  bootstrap_full_run 'unique adjacent variable Pluginfile import was rejected' 0 \
    "$BOOTSTRAP" --project "$variable_eval_project"

  for eval_conflict_kind in redirected reassigned mismatched-guard duplicate dynamic
  do
    eval_strict_project="$BOOTSTRAP_FULL_ROOT/eval strict $eval_conflict_kind"
    inspection_make_minimal_kotlin "$eval_strict_project"
    case "$eval_conflict_kind" in
      redirected)
        cat > "$eval_strict_project/android/Gemfile" <<'RUBY'
source "https://rubygems.org"
plugins_path = File.join(__dir__, "fastlane", "Pluginfile")
redirected_path = plugins_path
eval_gemfile(redirected_path) if File.exist?(redirected_path)
RUBY
        ;;
      reassigned)
        cat > "$eval_strict_project/android/Gemfile" <<'RUBY'
source "https://rubygems.org"
plugins_path = File.join(__dir__, "fastlane", "Pluginfile")
plugins_path = ENV.fetch("PLUGINFILE")
eval_gemfile(plugins_path) if File.exist?(plugins_path)
RUBY
        ;;
      mismatched-guard)
        cat > "$eval_strict_project/android/Gemfile" <<'RUBY'
source "https://rubygems.org"
eval_gemfile(File.join(__dir__, "fastlane", "Pluginfile")) if File.exist?("other/Pluginfile")
RUBY
        ;;
      duplicate)
        cat > "$eval_strict_project/android/Gemfile" <<'RUBY'
source "https://rubygems.org"
eval_gemfile("fastlane/Pluginfile")
eval_gemfile("fastlane/Pluginfile")
RUBY
        ;;
      dynamic)
        cat > "$eval_strict_project/android/Gemfile" <<'RUBY'
source "https://rubygems.org"
eval_gemfile(ENV.fetch("PLUGINFILE"))
RUBY
        ;;
    esac
    cp -R "$eval_strict_project" \
      "$BOOTSTRAP_FULL_ROOT/eval strict $eval_conflict_kind baseline"
    bootstrap_full_conflict "unsafe $eval_conflict_kind Pluginfile import was accepted" \
      "$eval_strict_project" \
      "$BOOTSTRAP_FULL_ROOT/eval strict $eval_conflict_kind baseline"
  done

  lane_project="$BOOTSTRAP_FULL_ROOT/lane conflict"
  inspection_make_minimal_kotlin "$lane_project"
  mkdir -p "$lane_project/android/fastlane"
  printf 'lane :doctor do\nend\n' > "$lane_project/android/fastlane/Fastfile"
  cp -R "$lane_project" "$BOOTSTRAP_FULL_ROOT/lane conflict baseline"
  bootstrap_full_conflict 'required Fastlane lane conflict was accepted' \
    "$lane_project" "$BOOTSTRAP_FULL_ROOT/lane conflict baseline"

  plugin_project="$BOOTSTRAP_FULL_ROOT/plugin conflict"
  inspection_make_minimal_kotlin "$plugin_project"
  mkdir -p "$plugin_project/android/fastlane"
  printf 'gem "fastlane-plugin-firebase_app_distribution", "= 0.9.0"\n' > \
    "$plugin_project/android/fastlane/Pluginfile"
  cp -R "$plugin_project" "$BOOTSTRAP_FULL_ROOT/plugin conflict baseline"
  bootstrap_full_conflict 'incompatible plugin declaration was accepted' \
    "$plugin_project" "$BOOTSTRAP_FULL_ROOT/plugin conflict baseline"

  gem_project="$BOOTSTRAP_FULL_ROOT/gem conflict"
  inspection_make_minimal_kotlin "$gem_project"
  printf 'source "https://rubygems.org"\ngem "fastlane", ">= 2.0"\n' > \
    "$gem_project/android/Gemfile"
  cp -R "$gem_project" "$BOOTSTRAP_FULL_ROOT/gem conflict baseline"
  bootstrap_full_conflict 'conflicting Fastlane constraint was accepted' \
    "$gem_project" "$BOOTSTRAP_FULL_ROOT/gem conflict baseline"

  eval_project="$BOOTSTRAP_FULL_ROOT/eval conflict"
  inspection_make_minimal_kotlin "$eval_project"
  printf 'source "https://rubygems.org"\neval_gemfile(ENV.fetch("PLUGINFILE"))\n' > \
    "$eval_project/android/Gemfile"
  cp -R "$eval_project" "$BOOTSTRAP_FULL_ROOT/eval conflict baseline"
  bootstrap_full_conflict 'dynamic eval_gemfile import was accepted' \
    "$eval_project" "$BOOTSTRAP_FULL_ROOT/eval conflict baseline"

  workflow_project="$BOOTSTRAP_FULL_ROOT/workflow conflict"
  inspection_make_minimal_kotlin "$workflow_project"
  mkdir -p "$workflow_project/.github/workflows"
  printf 'name: user release\n' > "$workflow_project/.github/workflows/release-android.yml"
  cp -R "$workflow_project" "$BOOTSTRAP_FULL_ROOT/workflow conflict baseline"
  bootstrap_full_conflict 'unowned workflow was overwritten' "$workflow_project" \
    "$BOOTSTRAP_FULL_ROOT/workflow conflict baseline"

  unresolved_project="$BOOTSTRAP_FULL_ROOT/unresolved application ID"
  inspection_make_unresolved "$unresolved_project"
  bootstrap_full_run 'unresolved application ID did not return incomplete status' 1 \
    "$BOOTSTRAP" --project "$unresolved_project"
  grep -F 'CHANGE_ME_APPLICATION_ID' \
    "$unresolved_project/android/fastlane/.env.example" >/dev/null 2>&1 ||
    fail 'unresolved bootstrap omitted the example application-ID placeholder'
  grep -F 'application ID is unresolved' "$BOOTSTRAP_LAST_STDERR" >/dev/null 2>&1 ||
    fail 'unresolved bootstrap omitted an actionable incomplete diagnostic'
  for active_path in android/fastlane/Appfile android/fastlane/Fastfile \
    .github/workflows/release-android.yml android/app/build.gradle
  do
    if grep -F 'CHANGE_ME_APPLICATION_ID' "$unresolved_project/$active_path" >/dev/null 2>&1; then
      fail "unresolved bootstrap put a placeholder in active configuration: $active_path"
    fi
  done

  flavor_project="$BOOTSTRAP_FULL_ROOT/flavor substitution"
  inspection_make_minimal_kotlin "$flavor_project"
  cat > "$flavor_project/android/app/build.gradle.kts" <<'KOTLIN'
android {
    namespace = "com.acme.mobile"
    flavorDimensions += "environment"
    defaultConfig {
        applicationId = "com.acme.mobile"
        versionCode = 1
        versionName = "1.0.0"
    }
    productFlavors {
        create("release") {
            applicationId = "com.acme.mobile.release"
        }
    }
}
KOTLIN
  bootstrap_full_run 'validated release flavor bootstrap failed' 0 \
    "$BOOTSTRAP" --project "$flavor_project" --flavor release
  grep -F 'APP_PACKAGE_NAME=com.acme.mobile.release' \
    "$flavor_project/android/fastlane/.env.example" >/dev/null 2>&1 ||
    fail 'bootstrap did not substitute the flavor application ID'
  grep -F 'FLUTTER_FLAVOR=release' \
    "$flavor_project/android/fastlane/.env.example" >/dev/null 2>&1 ||
    fail 'bootstrap did not substitute the validated flavor'

  crlf_project="$BOOTSTRAP_FULL_ROOT/crlf gitignore"
  inspection_make_minimal_kotlin "$crlf_project"
  printf 'build/\r\n' > "$crlf_project/.gitignore"
  bootstrap_full_run 'CRLF .gitignore bootstrap failed' 0 \
    "$BOOTSTRAP" --project "$crlf_project"
  python3 - "$crlf_project/.gitignore" <<'PY' ||
import sys

data = open(sys.argv[1], "rb").read()
raise SystemExit(0 if b"\n" not in data.replace(b"\r\n", b"") else 1)
PY
    fail 'bootstrap changed the existing .gitignore line-ending convention'

  for bootstrap_fail_after in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
  do
    full_failure_project="$BOOTSTRAP_FULL_ROOT/rollback $bootstrap_fail_after"
    full_failure_baseline="$BOOTSTRAP_FULL_ROOT/rollback baseline $bootstrap_fail_after"
    inspection_make_minimal_kotlin "$full_failure_project"
    cp -R "$full_failure_project" "$full_failure_baseline"
    bootstrap_full_run "full bootstrap write failure $bootstrap_fail_after did not roll back" 3 \
      env FPRS_TEST_MODE=1 \
      FPRS_TEST_FAIL_PROJECT_WRITE_AFTER="$bootstrap_fail_after" \
      "$BOOTSTRAP" --project "$full_failure_project"
    grep -F 'rollback attempted' "$BOOTSTRAP_LAST_STDERR" >/dev/null 2>&1 ||
      fail "full bootstrap write failure $bootstrap_fail_after omitted rollback status"
    bootstrap_full_assert_snapshot "$full_failure_baseline" "$full_failure_project" \
      "full bootstrap write failure $bootstrap_fail_after changed the project"
  done

  pass 'bootstrap_full'
}

fastlane_templates() {
  ruby -c "$PACKAGE_ROOT/templates/FlutterPlayStoreRelease.rb" >/dev/null ||
    fail 'FlutterPlayStoreRelease.rb has invalid Ruby syntax'
  ruby -c "$PACKAGE_ROOT/templates/Fastfile" >/dev/null ||
    fail 'Fastfile has invalid Ruby syntax'
  ruby "$PACKAGE_ROOT/tests/fastlane_helper_test.rb" ||
    fail 'Fastlane helper and adapter tests failed'
  ruby "$PACKAGE_ROOT/tests/authorization_hardening_test.rb" --name /authorization/ ||
    fail 'Authorization hardening regression tests failed'
  grep -F 'gem "fastlane", "= 2.237.0"' "$PACKAGE_ROOT/templates/Gemfile" >/dev/null 2>&1 ||
    fail 'Gemfile does not pin Fastlane 2.237.0 exactly'
  grep -F 'gem "fastlane-plugin-firebase_app_distribution", "= 1.0.0"' \
    "$PACKAGE_ROOT/templates/Pluginfile" >/dev/null 2>&1 ||
    fail 'Pluginfile does not pin Firebase App Distribution 1.0.0 exactly'
  grep -E '^[[:space:]]+4\.0\.16$' "$PACKAGE_ROOT/templates/Gemfile.lock" >/dev/null 2>&1 ||
    fail 'Gemfile.lock was not generated with Bundler 4.0.16'
  for fastlane_platform in ruby aarch64-linux x86_64-linux arm64-darwin x86_64-darwin
  do
    grep -F "  $fastlane_platform" "$PACKAGE_ROOT/templates/Gemfile.lock" >/dev/null 2>&1 ||
      fail "Gemfile.lock is missing supported platform: $fastlane_platform"
  done
  grep -F '  fastlane (= 2.237.0)' "$PACKAGE_ROOT/templates/Gemfile.lock" >/dev/null 2>&1 ||
    fail 'Gemfile.lock does not preserve the exact Fastlane dependency'
  grep -F '  fastlane-plugin-firebase_app_distribution (= 1.0.0)' \
    "$PACKAGE_ROOT/templates/Gemfile.lock" >/dev/null 2>&1 ||
    fail 'Gemfile.lock does not preserve the exact Firebase plugin dependency'
  pass 'fastlane_templates'
}

installer_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

installer_make_archive() {
  archive_path=$1
  archive_kind=$2
  archive_version=${3:-3.38.1}
  ARCHIVE_PATH=$archive_path ARCHIVE_KIND=$archive_kind \
    ARCHIVE_VERSION=$archive_version python3 - <<'PY'
import io, os, tarfile

path = os.environ["ARCHIVE_PATH"]
kind = os.environ["ARCHIVE_KIND"]
version = os.environ["ARCHIVE_VERSION"]

def add(tf, name, data=b"", mode=0o644, kind_override=None, linkname="", uid=0):
    item = tarfile.TarInfo(name)
    item.mode = mode
    item.uid = uid
    item.gid = 0
    item.uname = ""
    item.gname = ""
    if kind_override is not None:
        item.type = kind_override
        item.linkname = linkname
        item.size = 0
    else:
        item.size = len(data)
    tf.addfile(item, None if kind_override is not None else io.BytesIO(data))

with tarfile.open(path, "w:xz", format=tarfile.PAX_FORMAT) as tf:
    add(tf, "flutter", kind_override=tarfile.DIRTYPE, mode=0o755)
    add(tf, "flutter/bin", kind_override=tarfile.DIRTYPE, mode=0o755)
    script = ("#!/bin/sh\n"
              + ("[ -n \"${FPRS_TEST_FLUTTER_MARKER:-}\" ] && : > \"$FPRS_TEST_FLUTTER_MARKER\"\nsleep 30\n" if kind == "slow" else "")
              + "printf '%s\\n' '{\"frameworkVersion\":\"" + version + "\"}'\n").encode()
    add(tf, "flutter/bin/flutter", script,
        mode=0o4755 if kind == "setuid" else 0o755,
        uid=2147483648 if kind == "unsafe-owner" else 0)
    if kind == "absolute":
        add(tf, "/absolute-escape", b"bad")
    elif kind == "parent":
        add(tf, "flutter/../../parent-escape", b"bad")
    elif kind == "duplicate":
        add(tf, "flutter/bin/../bin/flutter", b"duplicate")
    elif kind == "contained-parent":
        add(tf, "flutter/tmp/../bin/tool", b"normalizes inside flutter")
    elif kind == "contained-link-parent":
        add(tf, "flutter/safe-link", kind_override=tarfile.SYMTYPE,
            linkname="tmp/../bin/tool", mode=0o777)
    elif kind == "symlink":
        add(tf, "flutter/escape", kind_override=tarfile.SYMTYPE,
            linkname="../../escape", mode=0o777)
    elif kind == "hardlink":
        add(tf, "flutter/hard-escape", kind_override=tarfile.LNKTYPE,
            linkname="../../escape", mode=0o644)
    elif kind == "fifo":
        add(tf, "flutter/fifo", kind_override=tarfile.FIFOTYPE)
    elif kind == "device":
        add(tf, "flutter/device", kind_override=tarfile.CHRTYPE)
    elif kind == "socket":
        add(tf, "flutter/socket", kind_override=b"s")
PY
}

installer_write_manifest() {
  manifest_path=$1
  base_url=$2
  archive_name=$3
  archive_sha=$4
  manifest_version=$5
  manifest_channel=$6
  manifest_arch=$7
  manifest_duplicate=${8:-false}
  MANIFEST_PATH=$manifest_path BASE_URL=$base_url ARCHIVE_NAME=$archive_name \
    ARCHIVE_SHA=$archive_sha MANIFEST_VERSION=$manifest_version \
    MANIFEST_CHANNEL=$manifest_channel MANIFEST_ARCH=$manifest_arch \
    MANIFEST_DUPLICATE=$manifest_duplicate python3 - <<'PY'
import json, os
release = {
    "version": os.environ["MANIFEST_VERSION"],
    "channel": os.environ["MANIFEST_CHANNEL"],
    "dart_sdk_arch": os.environ["MANIFEST_ARCH"],
    "archive": os.environ["ARCHIVE_NAME"],
    "sha256": os.environ["ARCHIVE_SHA"],
}
releases = [release]
if os.environ["MANIFEST_DUPLICATE"] == "true":
    releases.append(dict(release))
with open(os.environ["MANIFEST_PATH"], "w", encoding="utf-8") as handle:
    json.dump({"base_url": os.environ["BASE_URL"], "releases": releases}, handle)
PY
}

installer_expect() {
  description=$1
  expected=$2
  shift 2
  installer_stdout=$INSTALLER_ROOT/stdout
  installer_stderr=$INSTALLER_ROOT/stderr
  if FPRS_TEST_MODE=1 "$INSTALLER" "$@" >"$installer_stdout" 2>"$installer_stderr"; then
    installer_status=0
  else
    installer_status=$?
  fi
  if [ "$expected" -eq 0 ]; then
    [ "$installer_status" -eq 0 ] || {
      cat "$installer_stderr" >&2
      fail "$description (expected success, got $installer_status)"
    }
  else
    [ "$installer_status" -ne 0 ] || fail "$description (unexpected success)"
  fi
}

flutter_sdk_installer() {
  INSTALLER=$PACKAGE_ROOT/scripts/install_flutter_sdk.sh
  INSTALLER_ROOT=$TMP_ROOT/flutter-sdk-installer
  mkdir -p "$INSTALLER_ROOT/releases/stable/linux"

  if "$INSTALLER" --version >"$INSTALLER_ROOT/argument.stdout" \
    2>"$INSTALLER_ROOT/argument.stderr"
  then
    installer_argument_status=0
  else
    installer_argument_status=$?
  fi
  [ "$installer_argument_status" -eq 2 ] ||
    fail "incomplete installer arguments did not return status 2"

  installer_expect 'installer help did not exit successfully' 0 --help
  grep -F 'Usage: install_flutter_sdk.sh' "$INSTALLER_ROOT/stderr" \
    >/dev/null 2>&1 || fail 'installer help omitted usage text'

  good_archive=$INSTALLER_ROOT/releases/stable/linux/flutter_linux_3.38.1-stable.tar.xz
  installer_make_archive "$good_archive" good
  good_sha=$(installer_sha256 "$good_archive")
  manifest=$INSTALLER_ROOT/releases_linux.json
  installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
    'releases/stable/linux/flutter_linux_3.38.1-stable.tar.xz' "$good_sha" \
    3.38.1 stable x64

  destination=$INSTALLER_ROOT/sdk
  installer_expect 'verified local Flutter archive did not install' 0 \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$destination" --manifest-url "file://$manifest"
  [ -x "$destination/bin/flutter" ] || fail 'installed Flutter executable is missing'
  [ "$("$destination/bin/flutter" --version --machine)" = \
    '{"frameworkVersion":"3.38.1"}' ] || fail 'installed Flutter version is wrong'

  installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
    'releases/stable/linux/flutter_linux_3.38.1-stable.tar.xz' "$good_sha" \
    3.38.1 stable x64 true
  installer_expect 'duplicate manifest match was accepted' 1 \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$INSTALLER_ROOT/duplicate-sdk" --manifest-url "file://$manifest"

  installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
    'releases/stable/linux/flutter_linux_3.38.1-stable.tar.xz' "$good_sha" \
    9.9.9 stable x64
  installer_expect 'missing version was accepted' 1 \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$INSTALLER_ROOT/missing-sdk" --manifest-url "file://$manifest"
  installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
    'releases/stable/linux/flutter_linux_3.38.1-stable.tar.xz' "$good_sha" \
    3.38.1 stable arm64
  installer_expect 'wrong architecture was accepted' 1 \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$INSTALLER_ROOT/arch-sdk" --manifest-url "file://$manifest"
  installer_write_manifest "$manifest" 'https://attacker.invalid/flutter' \
    'archive.tar.xz' "$good_sha" 3.38.1 stable x64
  installer_expect 'hostile base_url was accepted' 1 \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$INSTALLER_ROOT/base-sdk" --manifest-url "file://$manifest"
  installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
    '../outside.tar.xz' "$good_sha" 3.38.1 stable x64
  installer_expect 'relative archive traversal was accepted' 1 \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$INSTALLER_ROOT/traversal-sdk" --manifest-url "file://$manifest"

  installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
    'releases/stable/linux/flutter_linux_3.38.1-stable.tar.xz' \
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    3.38.1 stable x64
  installer_expect 'SHA mismatch was accepted' 1 \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$INSTALLER_ROOT/sha-sdk" --manifest-url "file://$manifest"
  [ ! -e "$INSTALLER_ROOT/sha-sdk" ] || fail 'SHA failure extracted an SDK'

  partial=$INSTALLER_ROOT/releases/stable/linux/partial.tar.xz
  dd if="$good_archive" of="$partial" bs=64 count=1 >/dev/null 2>&1
  installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
    'releases/stable/linux/partial.tar.xz' "$good_sha" 3.38.1 stable x64
  installer_expect 'partial download was accepted' 1 \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$INSTALLER_ROOT/partial-sdk" --manifest-url "file://$manifest"

  for hostile_kind in absolute parent duplicate contained-parent contained-link-parent \
    symlink hardlink fifo device socket setuid unsafe-owner
  do
    hostile_archive=$INSTALLER_ROOT/releases/stable/linux/$hostile_kind.tar.xz
    installer_make_archive "$hostile_archive" "$hostile_kind"
    hostile_sha=$(installer_sha256 "$hostile_archive")
    installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
      "releases/stable/linux/$hostile_kind.tar.xz" "$hostile_sha" \
      3.38.1 stable x64
    installer_expect "unsafe archive member was accepted: $hostile_kind" 1 \
      --version 3.38.1 --channel stable --architecture x64 \
      --destination "$INSTALLER_ROOT/$hostile_kind-sdk" --manifest-url "file://$manifest"
  done

  wrong_version_archive=$INSTALLER_ROOT/releases/stable/linux/wrong-version.tar.xz
  installer_make_archive "$wrong_version_archive" good 3.38.2
  wrong_version_sha=$(installer_sha256 "$wrong_version_archive")
  installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
    'releases/stable/linux/wrong-version.tar.xz' "$wrong_version_sha" \
    3.38.1 stable x64
  installer_expect 'extracted version mismatch was accepted' 1 \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$INSTALLER_ROOT/version-sdk" --manifest-url "file://$manifest"

  preserved=$INSTALLER_ROOT/preserved-sdk
  mkdir -p "$preserved"
  printf 'owned bytes\n' > "$preserved/user-file"
  installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
    'releases/stable/linux/flutter_linux_3.38.1-stable.tar.xz' "$good_sha" \
    3.38.1 stable x64
  installer_expect 'nonempty existing destination was replaced' 1 \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$preserved" --manifest-url "file://$manifest"
  grep -F 'owned bytes' "$preserved/user-file" >/dev/null 2>&1 ||
    fail 'existing destination was not preserved'

  slow_archive=$INSTALLER_ROOT/releases/stable/linux/slow.tar.xz
  installer_make_archive "$slow_archive" slow
  slow_sha=$(installer_sha256 "$slow_archive")
  installer_write_manifest "$manifest" "file://$INSTALLER_ROOT" \
    'releases/stable/linux/slow.tar.xz' "$slow_sha" 3.38.1 stable x64
  signal_marker=$INSTALLER_ROOT/flutter-started
  FPRS_TEST_MODE=1 FPRS_TEST_FLUTTER_MARKER=$signal_marker "$INSTALLER" \
    --version 3.38.1 --channel stable --architecture x64 \
    --destination "$INSTALLER_ROOT/signal-sdk" --manifest-url "file://$manifest" \
    >"$INSTALLER_ROOT/signal.stdout" 2>"$INSTALLER_ROOT/signal.stderr" &
  installer_pid=$!
  installer_wait=0
  while [ ! -e "$signal_marker" ] && [ "$installer_wait" -lt 100 ]; do
    sleep 0.05
    installer_wait=$((installer_wait + 1))
  done
  [ -e "$signal_marker" ] || fail 'signal test did not reach extracted version verification'
  kill -TERM "$installer_pid"
  if wait "$installer_pid"; then
    installer_signal_status=0
  else
    installer_signal_status=$?
  fi
  [ "$installer_signal_status" -ne 0 ] || fail 'installer ignored TERM'
  [ ! -e "$INSTALLER_ROOT/signal-sdk" ] || fail 'signal left a destination behind'
  if find "$INSTALLER_ROOT" -maxdepth 1 -name '.flutter-sdk-install.*' -print | grep . >/dev/null 2>&1; then
    fail 'installer left private staging files after a signal'
  fi
  pass 'flutter_sdk_installer'
}

workflow_template() {
  workflow=$PACKAGE_ROOT/templates/release-android.yml
  workflow_harness=$TMP_ROOT/workflow-harness
  mkdir -p "$workflow_harness"
  for required_text in \
    'types: [published]' \
    'workflow_dispatch:' \
    'permissions:' \
    'contents: read' \
    'group: play-store-release' \
    'cancel-in-progress: false' \
    'queue: max' \
    'timeout-minutes:' \
    'ref: ${{ github.sha }}' \
    'fetch-depth: 0' \
    'persist-credentials: false' \
    'git check-ref-format' \
    'refs/tags/${release_tag}^{commit}' \
    'play-store-production' \
    'play-store-nonproduction' \
    'ANDROID_KEY_PROPERTIES_PATH' \
    'SLACK_NOTIFICATION_OWNER: github-actions' \
    'RELEASE_RESULT_PATH: ${{ runner.temp }}/release-result.json' \
    'bundle exec fastlane android release' \
    'if: ${{ always() }}'
  do
    grep -F -- "$required_text" "$workflow" >/dev/null 2>&1 ||
      fail "workflow is missing: $required_text"
  done
  for input_name in version_name flutter_version track release_status run_tests \
    rollout distribution_target firebase_artifact_type firebase_release_notes \
    confirm_firebase_package_match confirm_firebase_aab_play_linked \
    confirm_dual_delivery confirm_play_release_policy confirm_slack_notification \
    retry_unknown_upload confirm_upload_reconciled reconciled_version_name \
    reconciled_version_code reconciled_artifact_sha256 reconciled_destinations \
    reconciled_provider_state \
    confirm_production
  do
    grep -E "^[[:space:]]{6}$input_name:" "$workflow" >/dev/null 2>&1 ||
      fail "workflow input is missing: $input_name"
  done
  ! grep -E '^[[:space:]]{6}ref:' "$workflow" >/dev/null 2>&1 ||
    fail 'workflow exposes a custom mutable ref input'
  grep -F -- '--architecture x64' "$workflow" >/dev/null 2>&1 ||
    fail 'workflow does not install the x64 Flutter archive explicitly'
  ! grep -E 'uses:[[:space:]]+[^#]*(flutter-action|fastlane-action)' "$workflow" >/dev/null 2>&1 ||
    fail 'workflow uses a third-party Flutter or Fastlane wrapper action'
  if ! ruby -ryaml - "$workflow" "$workflow_harness" <<'RUBY'
require "fileutils"

workflow_path, harness_root = ARGV
document = YAML.safe_load(File.read(workflow_path), aliases: false)
raise "workflow root is not a mapping" unless document.is_a?(Hash)
events = document["on"] || document[true]
raise "release published trigger is missing" unless events.dig("release", "types") == ["published"]
dispatch = events.fetch("workflow_dispatch").fetch("inputs")
expected_inputs = {
  "version_name" => "string", "flutter_version" => "string", "track" => "choice",
  "release_status" => "choice", "rollout" => "string", "run_tests" => "boolean",
  "distribution_target" => "choice", "firebase_artifact_type" => "choice",
  "firebase_release_notes" => "string", "confirm_firebase_package_match" => "boolean",
  "confirm_firebase_aab_play_linked" => "boolean", "confirm_dual_delivery" => "boolean",
  "confirm_play_release_policy" => "boolean", "confirm_slack_notification" => "boolean",
  "retry_unknown_upload" => "boolean", "confirm_upload_reconciled" => "boolean",
  "reconciled_version_name" => "string", "reconciled_version_code" => "string",
  "reconciled_artifact_sha256" => "string", "reconciled_destinations" => "string",
  "reconciled_provider_state" => "string",
  "confirm_production" => "boolean"
}
raise "manual inputs differ from the contract" unless dispatch.keys.sort == expected_inputs.keys.sort
expected_inputs.each do |name, type|
  raise "manual input #{name} has wrong type" unless dispatch.fetch(name).fetch("type") == type
end
raise "custom mutable ref input is forbidden" if dispatch.key?("ref")
raise "permissions are not contents-read only" unless document["permissions"] == {"contents" => "read"}
concurrency = document.fetch("concurrency")
raise "repository-wide concurrency is wrong" unless concurrency == {
  "group" => "play-store-release", "cancel-in-progress" => false, "queue" => "max"
}

jobs = document.fetch("jobs")
raise "preflight unexpectedly has an Environment" if jobs.fetch("preflight").key?("environment")
release_job = jobs.fetch("release")
raise "release Environment is not the fixed preflight output" unless
  release_job.fetch("environment") == "${{ needs.preflight.outputs.deployment_environment }}"
steps = release_job.fetch("steps")
by_name = steps.to_h { |step| [step.fetch("name"), step] }
checkout = by_name.fetch("Checkout immutable event commit")
raise "checkout is not bound to github.sha" unless checkout.fetch("with").fetch("ref") == "${{ github.sha }}"

uses = steps.map { |step| step["uses"] }.compact
bad_uses = uses.reject { |ref| ref.start_with?("./") || ref.match?(/\A[^@]+@[0-9a-f]{40}\z/) }
raise "mutable action refs: #{bad_uses.inspect}" unless bad_uses.empty?
%w[actions/checkout actions/setup-java ruby/setup-ruby].each do |action|
  raise "missing or duplicate baseline action: #{action}" unless uses.count { |ref| ref.start_with?("#{action}@") } == 1
end

steps.each do |step|
  run = step["run"].to_s
  if run.match?(/\$\{\{\s*(?:inputs\.|github\.event\.|github\.ref|github\.sha)/)
    raise "untrusted expression interpolated in run step: #{step.fetch("name")}"
  end
  if step["if"].to_s.match?(/secrets\./)
    raise "secret used in step condition: #{step.fetch("name")}"
  end
end

validation = by_name.fetch("Validate source, release tag, and every untrusted input")
validation_env = validation.fetch("env")
expected_mappings = {
  "VERSION_NAME" => "inputs.version_name", "TRACK" => "inputs.track",
  "RELEASE_STATUS" => "inputs.release_status", "DISTRIBUTION_TARGET" => "inputs.distribution_target",
  "RELEASE_TAG" => "github.event.release.tag_name",
  "FIREBASE_RELEASE_NOTES" => "inputs.firebase_release_notes",
  "RETRY_UNKNOWN_UPLOAD" => "inputs.retry_unknown_upload",
  "CONFIRM_UPLOAD_RECONCILED" => "inputs.confirm_upload_reconciled",
  "RECONCILED_VERSION_NAME" => "inputs.reconciled_version_name",
  "RECONCILED_VERSION_CODE" => "inputs.reconciled_version_code",
  "RECONCILED_ARTIFACT_SHA256" => "inputs.reconciled_artifact_sha256",
  "RECONCILED_DESTINATIONS" => "inputs.reconciled_destinations",
  "RECONCILED_PROVIDER_STATE" => "inputs.reconciled_provider_state"
}
expected_mappings.each do |name, expression|
  raise "missing step-local mapping for #{name}" unless validation_env.fetch(name).include?(expression)
end
release_run = by_name.fetch("Release one routed Android artifact").fetch("run")
%w[RETRY_UNKNOWN_UPLOAD CONFIRM_UPLOAD_RECONCILED RECONCILED_VERSION_NAME
  RECONCILED_VERSION_CODE RECONCILED_ARTIFACT_SHA256 RECONCILED_DESTINATIONS
  RECONCILED_PROVIDER_STATE].each do |name|
  raise "release step does not forward #{name}" unless release_run.include?(name)
end
slack_run = by_name.fetch("Send the single optional Slack notification").fetch("run")
unless slack_run.include?("retry_unknown") && slack_run.include?('== "false"')
  raise "marked reconciliation retries must suppress workflow Slack notifications"
end

secret_uses = Hash.new { |hash, key| hash[key] = [] }
steps.each do |step|
  step.fetch("env", {}).each do |name, value|
    value.to_s.scan(/secrets\.([A-Z0-9_]+)/).flatten.each do |secret|
      secret_uses[secret] << [step.fetch("name"), name]
    end
  end
  %w[run if with].each do |field|
    raise "secret escaped step env in #{step.fetch("name")}: #{field}" if step[field].to_s.include?("secrets.")
  end
end
expected_secret_steps = {
  "APP_PACKAGE_NAME" => ["Restore only target-required credentials and signing material"],
  "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64" => ["Restore only target-required credentials and signing material"],
  "FIREBASE_SERVICE_ACCOUNT_JSON_BASE64" => ["Restore only target-required credentials and signing material"],
  "ANDROID_KEYSTORE_BASE64" => ["Restore only target-required credentials and signing material"],
  "ANDROID_KEYSTORE_PASSWORD" => ["Restore only target-required credentials and signing material"],
  "ANDROID_KEY_ALIAS" => ["Restore only target-required credentials and signing material"],
  "ANDROID_KEY_PASSWORD" => ["Restore only target-required credentials and signing material"],
  "FIREBASE_APP_ID" => ["Run local Fastlane release doctor", "Release one routed Android artifact"],
  "FIREBASE_TESTER_GROUPS" => ["Release one routed Android artifact"],
  "FIREBASE_TESTERS" => ["Release one routed Android artifact"],
  "SLACK_WEBHOOK_URL" => ["Send the single optional Slack notification"]
}
raise "workflow secret set differs from contract" unless secret_uses.keys.sort == expected_secret_steps.keys.sort
expected_secret_steps.each do |secret, expected_steps|
  actual_steps = secret_uses.fetch(secret).map(&:first)
  raise "wrong step scope for #{secret}: #{actual_steps.inspect}" unless actual_steps == expected_steps
end
raw_names = expected_secret_steps.keys.grep(/BASE64|PASSWORD|KEY_ALIAS|APP_PACKAGE_NAME/)
release_env = by_name.fetch("Release one routed Android artifact").fetch("env")
raise "raw secret reached release step" unless (release_env.keys & raw_names).empty?
jobs.each_value do |job|
  raise "job-level raw secret environment" if job.fetch("env", {}).values.any? { |value| value.to_s.include?("secrets.") }
end

{
  "preflight.sh" => jobs.fetch("preflight").fetch("steps").find { |step|
    step.fetch("name") == "Validate dispatch policy and route a fixed Environment"
  }.fetch("run"),
  "validate.sh" => validation.fetch("run")
}.each do |name, body|
  path = File.join(harness_root, name)
  File.write(path, body, mode: "wx", perm: 0o700)
end
RUBY
  then
    fail 'workflow structural contract failed'
  fi
  grep -F '[ -e android/key.properties ]' "$workflow" >/dev/null 2>&1 ||
    fail 'workflow does not preserve a pre-existing project key.properties'
  grep -F 'java_properties_escape' "$workflow" >/dev/null 2>&1 ||
    fail 'workflow does not escape Java properties values'
  ! grep -E '(GITHUB_OUTPUT|GITHUB_STEP_SUMMARY).*(BASE64|PASSWORD|WEBHOOK|KEY_ALIAS)' "$workflow" >/dev/null 2>&1 ||
    fail 'workflow writes secret material to an output or summary'

  workflow_run_counter=0
  workflow_run_expect() {
    workflow_run_description=$1
    workflow_run_expected=$2
    workflow_run_directory=$3
    workflow_run_script=$4
    shift 4
    workflow_run_counter=$((workflow_run_counter + 1))
    if (
      CDPATH= cd -- "$workflow_run_directory" &&
        env "$@" bash "$workflow_run_script"
    ) >"$workflow_harness/run-$workflow_run_counter.stdout" \
      2>"$workflow_harness/run-$workflow_run_counter.stderr"
    then
      workflow_run_status=0
    else
      workflow_run_status=$?
    fi
    if [ "$workflow_run_expected" -eq 0 ]; then
      [ "$workflow_run_status" -eq 0 ] || {
        cat "$workflow_harness/run-$workflow_run_counter.stderr" >&2
        fail "$workflow_run_description (expected success, got $workflow_run_status)"
      }
    else
      [ "$workflow_run_status" -ne 0 ] ||
        fail "$workflow_run_description (unexpected success)"
    fi
  }

  workflow_gate_case() {
    workflow_gate_description=$1
    workflow_gate_expected=$2
    workflow_gate_route=$3
    workflow_gate_event=$4
    workflow_gate_track=$5
    workflow_gate_confirm=$6
    workflow_gate_release_enabled=${7-true}
    workflow_gate_attempt=${8-1}
    workflow_gate_retry=${9-false}
    workflow_gate_reconciled=${10-false}
    workflow_gate_reconciled_name=${11-}
    workflow_gate_reconciled_code=${12-}
    workflow_gate_reconciled_sha=${13-}
    workflow_gate_reconciled_destinations=${14-}
    workflow_gate_reconciled_state=${15-}
    workflow_gate_output=$workflow_harness/gate-$workflow_run_counter.output
    workflow_run_expect "$workflow_gate_description" "$workflow_gate_expected" \
      "$workflow_harness" "$workflow_harness/preflight.sh" \
      GITHUB_OUTPUT="$workflow_gate_output" EVENT_NAME="$workflow_gate_event" \
      GITHUB_RUN_ATTEMPT="$workflow_gate_attempt" \
      ENABLE_GITHUB_RELEASE_DEPLOY="$workflow_gate_release_enabled" \
      VERSION_NAME=v1.2.3 FLUTTER_VERSION=3.38.1 TRACK="$workflow_gate_track" \
      RELEASE_STATUS=completed ROLLOUT= RUN_TESTS=true DISTRIBUTION_TARGET=play-store \
      FIREBASE_ARTIFACT_TYPE=AAB FIREBASE_RELEASE_NOTES=notes \
      CONFIRM_FIREBASE_PACKAGE_MATCH=false CONFIRM_FIREBASE_AAB_PLAY_LINKED=false \
      CONFIRM_DUAL_DELIVERY=false CONFIRM_PLAY_RELEASE_POLICY=false \
      CONFIRM_SLACK_NOTIFICATION=false \
      RETRY_UNKNOWN_UPLOAD="$workflow_gate_retry" CONFIRM_UPLOAD_RECONCILED="$workflow_gate_reconciled" \
      RECONCILED_VERSION_NAME="$workflow_gate_reconciled_name" \
      RECONCILED_VERSION_CODE="$workflow_gate_reconciled_code" \
      RECONCILED_ARTIFACT_SHA256="$workflow_gate_reconciled_sha" \
      RECONCILED_DESTINATIONS="$workflow_gate_reconciled_destinations" \
      RECONCILED_PROVIDER_STATE="$workflow_gate_reconciled_state" \
      CONFIRM_PRODUCTION="$workflow_gate_confirm"
    if [ "$workflow_gate_expected" -eq 0 ]; then
      grep -Fx "deployment_environment=$workflow_gate_route" "$workflow_gate_output" >/dev/null 2>&1 ||
        fail "$workflow_gate_description did not select $workflow_gate_route"
    else
      [ ! -e "$workflow_gate_output" ] || [ ! -s "$workflow_gate_output" ] ||
        fail "$workflow_gate_description emitted an Environment after rejection"
    fi
  }

  workflow_gate_case 'release event bypassed default-off opt-in' 1 '' release internal false false
  workflow_gate_case 'workflow rerun bypassed reconciliation guard' 1 '' workflow_dispatch internal false true 2
  workflow_gate_case 'release routing failed' 0 play-store-nonproduction release internal false true
  workflow_gate_case 'nonproduction manual routing failed' 0 play-store-nonproduction workflow_dispatch beta false
  workflow_gate_case 'unconfirmed production was accepted' 1 '' workflow_dispatch production false
  workflow_gate_case 'confirmed production routing failed' 0 play-store-production workflow_dispatch production true
  workflow_retry_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  workflow_gate_case 'exact reconciled retry was rejected' 0 play-store-nonproduction \
    workflow_dispatch internal false true 1 true true v1.2.3 42 \
    "$workflow_retry_sha" play-store not-delivered
  workflow_gate_case 'unconfirmed reconciled retry was accepted' 1 '' \
    workflow_dispatch internal false true 1 true false v1.2.3 42 \
    "$workflow_retry_sha" play-store not-delivered
  workflow_gate_case 'unmarked reconciliation tuple was accepted' 1 '' \
    workflow_dispatch internal false true 1 false false v1.2.3 42 \
    "$workflow_retry_sha" play-store not-delivered
  workflow_gate_case 'oversized reconciled version code was accepted' 1 '' \
    workflow_dispatch internal false true 1 true true v1.2.3 99999999999999999999 \
    "$workflow_retry_sha" play-store not-delivered
  workflow_gate_case 'reconciled version code above Play maximum was accepted' 1 '' \
    workflow_dispatch internal false true 1 true true v1.2.3 2100000001 \
    "$workflow_retry_sha" play-store not-delivered

  workflow_repo=$workflow_harness/repository
  mkdir -p "$workflow_repo"
  git -C "$workflow_repo" init -q
  git -C "$workflow_repo" config user.email tests@example.invalid
  git -C "$workflow_repo" config user.name 'Workflow Tests'
  printf 'old\n' > "$workflow_repo/state.txt"
  git -C "$workflow_repo" add state.txt
  git -C "$workflow_repo" commit -q -m old
  workflow_old_sha=$(git -C "$workflow_repo" rev-parse HEAD)
  printf 'current\n' > "$workflow_repo/state.txt"
  git -C "$workflow_repo" add state.txt
  git -C "$workflow_repo" commit -q -m current
  workflow_head_sha=$(git -C "$workflow_repo" rev-parse HEAD)
  git -C "$workflow_repo" tag v1.2.3 "$workflow_head_sha"
  git -C "$workflow_repo" tag -a v1.2.4 -m annotated "$workflow_head_sha"
  git -C "$workflow_repo" tag v1.2.5 "$workflow_old_sha"
  git -C "$workflow_repo" tag v1.2.6 "$workflow_head_sha"
  git -C "$workflow_repo" tag -f v1.2.6 "$workflow_old_sha" >/dev/null

  workflow_validate_case() {
    workflow_validate_description=$1
    workflow_validate_expected=$2
    workflow_validate_event=$3
    workflow_validate_tag=$4
    workflow_validate_version=$5
    workflow_validate_track=$6
    workflow_validate_status=$7
    workflow_validate_target=$8
    workflow_validate_notes=$9
    workflow_validate_retry=${10-false}
    workflow_validate_reconciled=${11-false}
    workflow_validate_reconciled_name=${12-}
    workflow_validate_reconciled_code=${13-}
    workflow_validate_reconciled_sha=${14-}
    workflow_validate_reconciled_destinations=${15-}
    workflow_validate_reconciled_state=${16-}
    workflow_validate_root=$workflow_harness/validate-$workflow_run_counter
    mkdir -p "$workflow_validate_root"
    workflow_run_expect "$workflow_validate_description" "$workflow_validate_expected" \
      "$workflow_repo" "$workflow_harness/validate.sh" \
      RUNNER_TEMP="$workflow_validate_root" EVENT_NAME="$workflow_validate_event" \
      RELEASE_TAG="$workflow_validate_tag" VERSION_NAME="$workflow_validate_version" \
      FLUTTER_VERSION=3.38.1 REPOSITORY_FLUTTER_VERSION= \
      TRACK="$workflow_validate_track" RELEASE_STATUS="$workflow_validate_status" ROLLOUT= \
      RUN_TESTS=true DISTRIBUTION_TARGET="$workflow_validate_target" \
      FIREBASE_ARTIFACT_TYPE=AAB FIREBASE_RELEASE_NOTES="$workflow_validate_notes" \
      CONFIRM_FIREBASE_PACKAGE_MATCH=false CONFIRM_FIREBASE_AAB_PLAY_LINKED=false \
      CONFIRM_DUAL_DELIVERY=true CONFIRM_PLAY_RELEASE_POLICY=false \
      CONFIRM_SLACK_NOTIFICATION=false CONFIRM_PRODUCTION=false \
      RETRY_UNKNOWN_UPLOAD="$workflow_validate_retry" \
      CONFIRM_UPLOAD_RECONCILED="$workflow_validate_reconciled" \
      RECONCILED_VERSION_NAME="$workflow_validate_reconciled_name" \
      RECONCILED_VERSION_CODE="$workflow_validate_reconciled_code" \
      RECONCILED_ARTIFACT_SHA256="$workflow_validate_reconciled_sha" \
      RECONCILED_DESTINATIONS="$workflow_validate_reconciled_destinations" \
      RECONCILED_PROVIDER_STATE="$workflow_validate_reconciled_state" \
      RELEASE_EVENT_SLACK_AUTHORIZED=false
    WORKFLOW_LAST_VALIDATE_ROOT=$workflow_validate_root
  }

  workflow_validate_case 'lightweight release tag was rejected' 0 release v1.2.3 '' internal completed play-store notes
  [ "$(cat "$WORKFLOW_LAST_VALIDATE_ROOT/toris-flutter-play-store-release-inputs/version_name")" = v1.2.3 ] ||
    fail 'lightweight release tag was not used as version name'
  workflow_validate_case 'annotated release tag was rejected' 0 release v1.2.4 '' internal completed play-store notes
  workflow_validate_case 'mismatched release tag was accepted' 1 release v1.2.5 '' internal completed play-store notes
  workflow_validate_case 'moved release tag was accepted' 1 release v1.2.6 '' internal completed play-store notes

  workflow_injection_marker=$workflow_harness/injection-executed
  workflow_release_tag_canary='bad tag;$(touch '"$workflow_injection_marker"')'
  workflow_validate_case 'invalid release tag was accepted' 1 release \
    "$workflow_release_tag_canary" '' internal completed play-store notes
  [ ! -e "$workflow_injection_marker" ] || fail 'release-tag injection canary executed'

  git -C "$workflow_repo" checkout -q --detach "$workflow_head_sha"
  workflow_notes_canary='notes $(touch '"$workflow_injection_marker"') ; `touch ignored`'
  workflow_validate_case 'manual native-SHA validation failed' 0 workflow_dispatch '' \
    v2.0.0 internal completed both "$workflow_notes_canary"
  [ "$(git -C "$workflow_repo" rev-parse HEAD)" = "$workflow_head_sha" ] ||
    fail 'manual validation changed the native triggering SHA'
  printf '%s' "$workflow_notes_canary" > "$workflow_harness/notes.expected"
  assert_same_file "$workflow_harness/notes.expected" \
    "$WORKFLOW_LAST_VALIDATE_ROOT/toris-flutter-play-store-release-inputs/firebase_release_notes" \
    'Firebase notes injection canary was not preserved as inert data'
  [ ! -e "$workflow_injection_marker" ] || fail 'Firebase notes injection canary executed'

  workflow_validate_case 'exact retry tuple was not stored' 0 workflow_dispatch '' \
    v2.0.0 internal completed play-store notes true true v2.0.0 42 \
    "$workflow_retry_sha" play-store not-delivered
  [ "$(cat "$WORKFLOW_LAST_VALIDATE_ROOT/toris-flutter-play-store-release-inputs/retry_unknown")" = true ] ||
    fail 'validated retry marker was not stored'
  [ "$(cat "$WORKFLOW_LAST_VALIDATE_ROOT/toris-flutter-play-store-release-inputs/reconciled_version_code")" = 42 ] ||
    fail 'validated reconciliation version code was not stored'
  workflow_validate_case 'validation accepted a reconciled version code above Play maximum' 1 \
    workflow_dispatch '' v2.0.0 internal completed play-store notes true true v2.0.0 \
    2100000001 "$workflow_retry_sha" play-store not-delivered

  workflow_shell_canary='$(touch '"$workflow_injection_marker"')'
  workflow_validate_case 'version injection was accepted' 1 workflow_dispatch '' \
    "v2.0.0$workflow_shell_canary" internal completed play-store notes
  workflow_validate_case 'track injection was accepted' 1 workflow_dispatch '' \
    v2.0.0 "internal$workflow_shell_canary" completed play-store notes
  workflow_validate_case 'status injection was accepted' 1 workflow_dispatch '' \
    v2.0.0 internal "completed$workflow_shell_canary" play-store notes
  workflow_validate_case 'distribution target injection was accepted' 1 workflow_dispatch '' \
    v2.0.0 internal completed "both$workflow_shell_canary" notes
  workflow_validate_case 'reconciled version code injection was accepted' 1 workflow_dispatch '' \
    v2.0.0 internal completed play-store notes true true v2.0.0 \
    "42$workflow_shell_canary" "$workflow_retry_sha" play-store not-delivered
  [ ! -e "$workflow_injection_marker" ] || fail 'workflow input injection canary executed'
  pass 'workflow_template'
}

release_validator_run() {
  validator_description=$1
  validator_expected=$2
  shift 2
  validator_index=$((validator_index + 1))
  VALIDATOR_STDOUT="$VALIDATOR_ROOT/$validator_index.stdout"
  VALIDATOR_STDERR="$VALIDATOR_ROOT/$validator_index.stderr"
  if "$@" >"$VALIDATOR_STDOUT" 2>"$VALIDATOR_STDERR"; then
    validator_actual=0
  else
    validator_actual=$?
  fi
  [ "$validator_actual" -eq "$validator_expected" ] || {
    sed -n '1,160p' "$VALIDATOR_STDOUT" >&2
    sed -n '1,160p' "$VALIDATOR_STDERR" >&2
    fail "$validator_description (expected exit $validator_expected, got $validator_actual)"
  }
}

release_validator_snapshot_tree() {
  snapshot_root=$1
  snapshot_output=$2
  find "$snapshot_root" -print | LC_ALL=C sort | while IFS= read -r snapshot_path
  do
    snapshot_relative=${snapshot_path#$snapshot_root}
    if [ -L "$snapshot_path" ]; then
      printf 'L %s %s\n' "$snapshot_relative" "$(readlink "$snapshot_path")"
    elif [ -d "$snapshot_path" ]; then
      printf 'D %s %s\n' "$snapshot_relative" \
        "$(stat -f '%Lp' "$snapshot_path" 2>/dev/null || stat -c '%a' "$snapshot_path")"
    elif [ -f "$snapshot_path" ]; then
      printf 'F %s %s %s\n' "$snapshot_relative" \
        "$(stat -f '%Lp' "$snapshot_path" 2>/dev/null || stat -c '%a' "$snapshot_path")" \
        "$(bootstrap_full_sha256 "$snapshot_path")"
    else
      printf 'O %s\n' "$snapshot_relative"
    fi
  done > "$snapshot_output"
}

release_validator_write_properties() {
  properties_path=$1
  properties_store_file=$2
  printf '%s\n' \
    "storeFile=$properties_store_file" \
    'storePassword=test-password' \
    'keyAlias=upload' \
    'keyPassword=test-key-password' > "$properties_path"
}

release_validator() {
  VALIDATOR="$PACKAGE_ROOT/scripts/validate_release_setup.sh"
  VALIDATOR_ROOT="$TMP_ROOT/release validator"
  validator_project="$VALIDATOR_ROOT/project with spaces"
  validator_stubs="$VALIDATOR_ROOT/stubs"
  validator_log="$VALIDATOR_ROOT/commands.log"
  validator_forbidden="$VALIDATOR_ROOT/external-contact"
  validator_index=0
  mkdir -p "$validator_stubs"

  inspection_make_minimal_kotlin "$validator_project"
  "$PACKAGE_ROOT/scripts/bootstrap_android_fastlane.sh" --project "$validator_project" \
    >"$VALIDATOR_ROOT/bootstrap.stdout" 2>"$VALIDATOR_ROOT/bootstrap.stderr" ||
    fail 'could not create the validator fixture'
  mkdir -p "$validator_project/.dart_tool/sentinel" \
    "$validator_project/android/app/src/main/java/io/flutter/plugins" \
    "$validator_project/generated-empty-directory"
  printf 'locked dependencies\n' > "$validator_project/pubspec.lock"
  printf '{"plugins":[],"date_created":"sentinel"}\n' \
    > "$validator_project/.flutter-plugins-dependencies"
  printf 'final class GeneratedPluginRegistrant {}\n' \
    > "$validator_project/android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java"
  printf 'dart tool sentinel\n' > "$validator_project/.dart_tool/sentinel/state"

  for validator_tool in flutter ruby bundle java git python3 curl gh fastlane
  do
    cat >"$validator_stubs/$validator_tool" <<'STUB'
#!/usr/bin/env bash
tool=${0##*/}
printf '%s %s\n' "$tool" "$*" >> "${FPRS_COMMAND_LOG:?}"
case "$tool" in
  curl|gh|fastlane)
    : > "${FPRS_FORBIDDEN_MARKER:?}"
    exit 97
    ;;
  git)
    [ "${FPRS_TRACKED_SECRET-}" = 1 ] && printf '%s\n' 'android/upload.jks'
    exit 0
    ;;
  ruby)
    [ "${FPRS_RUBY_BROKEN-}" = 1 ] && exit 91
    case " $* " in
      *' -c '*) [ "${FPRS_RUBY_SYNTAX_FAIL-}" = 1 ] && exit 1 ;;
      *' YAML.safe_load'*) [ "${FPRS_YAML_INVALID-}" = 1 ] && exit 1 ;;
    esac
    case " $* " in
      *' require "yaml" '*) [ "${FPRS_NO_YAML_PARSER-}" = 1 ] && exit 1 ;;
    esac
    exit 0
    ;;
  python3)
    [ "${FPRS_PYTHON_BROKEN-}" = 1 ] && exit 92
    printf '%s\n' "${FPRS_PYTHON_VERSION:-Python 3.13.5}"
    exit 0
    ;;
  bundle)
    [ "${FPRS_BUNDLER_BROKEN-}" = 1 ] && exit 93
    if [ "${1-}" = --version ]; then
      printf 'Bundler version %s\n' "${FPRS_BUNDLER_VERSION:-4.0.16}"
    fi
    exit 0
    ;;
esac
exit 0
STUB
    chmod +x "$validator_stubs/$validator_tool"
  done

  validator_env="PATH=$validator_stubs:$PATH"
  : > "$validator_log"
  release_validator_snapshot_tree "$validator_project" "$VALIDATOR_ROOT/before.tree"
  release_validator_run 'read-only doctor failed' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -E '^PASS (package_name|plugin|track|toolchain\.flutter):' \
    "$VALIDATOR_STDOUT" >/dev/null 2>&1 || fail 'doctor omitted Fastlane-parity check names'
  grep -E '^(PASS|WARN) signing:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'doctor omitted the Fastlane-parity signing check name'
  grep -F 'WARN project.commands:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'doctor did not report project commands as not run'
  validator_project_resolved=$(CDPATH= cd -- "$validator_project" && pwd -P) ||
    fail 'could not resolve validator fixture path'
  printf -v validator_expected_project_command \
    '%q --project %q --context setup --run-project-commands' \
    "$VALIDATOR" "$validator_project_resolved"
  grep -F "WARN project.commands: Project-mutating validation commands were not run; explicitly opt in from setup/build context | command: $validator_expected_project_command" \
    "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'doctor did not recommend the skill-root validator with the resolved project path'
  grep -F 'python3 --version' "$validator_log" >/dev/null 2>&1 ||
    fail 'validator fabricated Python readiness without invoking its version check'
  grep -F 'bundle --version' "$validator_log" >/dev/null 2>&1 ||
    fail 'validator fabricated Bundler readiness without invoking its version check'
  ! grep -E 'flutter (pub get|analyze|test|build)' "$validator_log" >/dev/null 2>&1 ||
    fail 'doctor ran a project-mutating Flutter command'
  release_validator_snapshot_tree "$validator_project" "$VALIDATOR_ROOT/after.tree"
  assert_same_file "$VALIDATOR_ROOT/before.tree" "$VALIDATOR_ROOT/after.tree" \
    'doctor changed the project tree'
  cp "$VALIDATOR_STDOUT" "$VALIDATOR_ROOT/doctor.first"
  release_validator_run 'repeated doctor failed' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  assert_same_file "$VALIDATOR_ROOT/doctor.first" "$VALIDATOR_STDOUT" \
    'repeated doctor output was not deterministic'
  awk '{ name=$2; sub(/:$/, "", name); print name }' "$VALIDATOR_STDOUT" \
    > "$VALIDATOR_ROOT/check-names"
  LC_ALL=C sort "$VALIDATOR_ROOT/check-names" > "$VALIDATOR_ROOT/check-names.sorted"
  assert_same_file "$VALIDATOR_ROOT/check-names.sorted" "$VALIDATOR_ROOT/check-names" \
    'human validator checks were not sorted by stable name'

  release_validator_run 'resolved package recommendation failed' 0 env \
    -u APP_PACKAGE_NAME "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    "$VALIDATOR" --project "$validator_project"
  grep -F 'WARN package_name: APP_PACKAGE_NAME is not configured | command: export APP_PACKAGE_NAME=com.example.kotlin' \
    "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'missing package name did not recommend the resolved release application ID'
  signing_recommendation=$(grep -F 'WARN signing:' "$VALIDATOR_STDOUT" || true)
  case "$signing_recommendation" in
    *'Android release signing input is incomplete; create mode-0600 android/key.properties and replace every placeholder before retrying'*' | command: '*) ;;
    *) fail 'missing signing input did not explain safe creation and placeholder replacement' ;;
  esac
  signing_recommendation_command=${signing_recommendation#* | command: }
  case "$signing_recommendation_command" in
    *'install -m 600 '*'"${EDITOR:-vi}" '*'! grep -Eq '*) ;;
    *) fail 'signing remediation did not enforce mode 0600, editing, and placeholder rejection' ;;
  esac
  if EDITOR=true bash -c "$signing_recommendation_command"; then
    fail 'signing remediation succeeded without replacing template placeholders'
  fi
  [ -f "$validator_project/android/key.properties" ] ||
    fail 'signing remediation did not create android/key.properties'
  validator_key_properties_mode=$(stat -f '%Lp' \
    "$validator_project/android/key.properties" 2>/dev/null ||
    stat -c '%a' "$validator_project/android/key.properties")
  [ "$validator_key_properties_mode" = 600 ] ||
    fail "signing remediation created android/key.properties with mode $validator_key_properties_mode"
  rm -f "$validator_project/android/key.properties"

  release_validator_run 'broken Python was fabricated as ready' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    FPRS_PYTHON_BROKEN=1 APP_PACKAGE_NAME=com.example.kotlin \
    "$VALIDATOR" --project "$validator_project"
  grep -F 'WARN toolchain.python3:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'broken Python did not become an explicit warning'
  release_validator_run 'wrong Bundler was fabricated as ready' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    FPRS_BUNDLER_VERSION=3.6.9 APP_PACKAGE_NAME=com.example.kotlin \
    "$VALIDATOR" --project "$validator_project"
  grep -F 'WARN toolchain.bundler:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'wrong Bundler version did not become an explicit warning'
  release_validator_run 'broken deploy prerequisites were not hard failures' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    FPRS_PYTHON_BROKEN=1 FPRS_BUNDLER_BROKEN=1 \
    "$VALIDATOR" --context deploy
  grep -F 'FAIL toolchain.python3:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'broken Python was not a deploy-context failure'
  grep -F 'FAIL toolchain.bundler:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'broken Bundler was not a deploy-context failure'

  validator_no_ruby_bin="$VALIDATOR_ROOT/no-ruby-bin"
  mkdir -p "$validator_no_ruby_bin"
  for validator_system_tool in bash dirname mktemp rm sort awk sed grep stat shasum \
    sha256sum tr cat
  do
    validator_system_path=$(command -v "$validator_system_tool" 2>/dev/null || true)
    case "$validator_system_path" in
      /*) ln -s "$validator_system_path" "$validator_no_ruby_bin/$validator_system_tool" ;;
    esac
  done
  for validator_stub_tool in flutter bundle java git python3 curl gh fastlane
  do
    ln -s "$validator_stubs/$validator_stub_tool" \
      "$validator_no_ruby_bin/$validator_stub_tool"
  done
  release_validator_run 'Ruby-absent package validation failed' 0 env \
    PATH="$validator_no_ruby_bin" FPRS_COMMAND_LOG="$validator_log" \
    FPRS_FORBIDDEN_MARKER="$validator_forbidden" "$VALIDATOR"
  grep -F 'WARN toolchain.ruby:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'absent Ruby did not become an explicit warning'

  validator_bad_shape="$VALIDATOR_ROOT/bad shape"
  mkdir -p "$validator_bad_shape/android/app"
  release_validator_run 'bad project shape was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    "$VALIDATOR" --project "$validator_bad_shape"
  grep -F 'FAIL project.shape:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'bad project shape did not emit its named failure'
  grep -F 'FAIL project.inspection:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'failed inspection did not emit its named failure'

  mv "$validator_project/android/fastlane/Appfile" "$VALIDATOR_ROOT/Appfile.saved"
  release_validator_run 'missing required generated file was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL fastlane.files:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'missing generated file did not emit fastlane.files'
  mv "$VALIDATOR_ROOT/Appfile.saved" "$validator_project/android/fastlane/Appfile"

  cp "$validator_project/android/fastlane/Appfile" "$VALIDATOR_ROOT/Appfile.good"
  printf '\n# corrupt owned body\n' >> "$validator_project/android/fastlane/Appfile"
  release_validator_run 'corrupt managed hash was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL ownership.hashes:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'corrupt managed hash did not emit ownership.hashes'
  cp "$VALIDATOR_ROOT/Appfile.good" "$validator_project/android/fastlane/Appfile"

  cp "$validator_project/.gitignore" "$VALIDATOR_ROOT/examples-ignore.good"
  printf 'android/key.properties.example\n' >> "$validator_project/.gitignore"
  release_validator_run 'ignored example file was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL gitignore.required:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'example-file ignore exception did not fail'
  cp "$VALIDATOR_ROOT/examples-ignore.good" "$validator_project/.gitignore"

  release_validator_run 'Ruby syntax failure was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    FPRS_RUBY_SYNTAX_FAIL=1 APP_PACKAGE_NAME=com.example.kotlin \
    "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL ruby.syntax:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'Ruby syntax failure did not emit ruby.syntax'

  cp "$validator_project/tool/flutter-play-store-release/decode_secret.sh" \
    "$VALIDATOR_ROOT/decode.good"
  printf '\nif then\n' >> "$validator_project/tool/flutter-play-store-release/decode_secret.sh"
  release_validator_run 'generated shell syntax failure was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL shell.project:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'generated shell syntax failure did not emit shell.project'
  cp "$VALIDATOR_ROOT/decode.good" \
    "$validator_project/tool/flutter-play-store-release/decode_secret.sh"

  release_validator_run 'parser-present invalid YAML was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    FPRS_YAML_INVALID=1 APP_PACKAGE_NAME=com.example.kotlin \
    "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL yaml.parser:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'parser-present invalid YAML did not emit yaml.parser'

  validator_signing_root="$VALIDATOR_ROOT/private-signing"
  mkdir -p "$validator_signing_root"
  chmod 700 "$validator_signing_root"
  printf 'keystore bytes\n' > "$validator_signing_root/upload.jks"
  validator_valid_properties="$validator_signing_root/key.properties"
  release_validator_write_properties "$validator_valid_properties" \
    "$validator_signing_root/upload.jks"
  chmod 600 "$validator_valid_properties"
  release_validator_run 'valid private signing override was rejected' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    ANDROID_KEY_PROPERTIES_PATH="$validator_valid_properties" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'PASS signing:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'valid private signing override did not pass signing'

  validator_incomplete_properties="$validator_signing_root/incomplete.properties"
  printf 'storeFile=%s\n' "$validator_signing_root/upload.jks" \
    > "$validator_incomplete_properties"
  chmod 600 "$validator_incomplete_properties"
  release_validator_run 'incomplete explicit signing override was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    ANDROID_KEY_PROPERTIES_PATH="$validator_incomplete_properties" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL signing:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'incomplete explicit signing override did not fail'

  validator_mode_properties="$validator_signing_root/mode.properties"
  release_validator_write_properties "$validator_mode_properties" \
    "$validator_signing_root/upload.jks"
  chmod 644 "$validator_mode_properties"
  release_validator_run 'public-mode signing override was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    ANDROID_KEY_PROPERTIES_PATH="$validator_mode_properties" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"

  validator_relative_properties="$validator_signing_root/relative.properties"
  release_validator_write_properties "$validator_relative_properties" 'upload.jks'
  chmod 600 "$validator_relative_properties"
  release_validator_run 'relative override storeFile was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    ANDROID_KEY_PROPERTIES_PATH="$validator_relative_properties" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"

  validator_missing_properties="$validator_signing_root/missing.properties"
  release_validator_write_properties "$validator_missing_properties" \
    "$validator_signing_root/missing.jks"
  chmod 600 "$validator_missing_properties"
  release_validator_run 'missing override keystore was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    ANDROID_KEY_PROPERTIES_PATH="$validator_missing_properties" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"

  release_validator_write_properties "$validator_project/android/key.properties" \
    "$validator_signing_root/upload.jks"
  release_validator_run 'CI workspace key.properties was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    CI=true APP_PACKAGE_NAME=com.example.kotlin \
    "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL signing:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'CI workspace key.properties did not fail signing'
  rm -f "$validator_project/android/key.properties"

  printf 'storeFile=%s\n' "$validator_signing_root/upload.jks" \
    > "$validator_project/android/key.properties"
  release_validator_run 'incomplete local signing was fabricated as ready' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'WARN signing:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'incomplete local key.properties did not become a warning'
  rm -f "$validator_project/android/key.properties"

  printf '%s\n' \
    "storeFile:$validator_signing_root/upload.jks" \
    'storePassword:test-password' \
    'keyAlias:upload' \
    'keyPassword:test-key-password' > "$validator_project/android/key.properties"
  release_validator_run 'colon-separated local properties were fabricated as ready' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'WARN signing:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'colon-separated local properties did not match Fastlane doctor warning semantics'
  release_validator_run 'deploy accepted colon-separated local properties' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project" \
    --context deploy
  grep -F 'FAIL signing:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'colon-separated local properties did not match Fastlane deploy failure semantics'
  rm -f "$validator_project/android/key.properties"

  release_validator_run 'complete raw signing inputs were rejected' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    ANDROID_KEYSTORE_PATH="$validator_signing_root/upload.jks" \
    ANDROID_KEYSTORE_PASSWORD=test-password ANDROID_KEY_ALIAS=upload \
    ANDROID_KEY_PASSWORD=test-key-password APP_PACKAGE_NAME=com.example.kotlin \
    "$VALIDATOR" --project "$validator_project"
  grep -F 'PASS signing:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'complete raw signing inputs did not pass signing'

  validator_groovy="$VALIDATOR_ROOT/groovy project"
  inspection_write_pubspec "$validator_groovy" dev_dependencies
  inspection_write_wrapper "$validator_groovy" 8.7
  cat > "$validator_groovy/android/settings.gradle" <<'GRADLE'
plugins {
    id "com.android.application" version "8.5.2" apply false
}
GRADLE
  cat > "$validator_groovy/android/app/build.gradle" <<'GRADLE'
android {
    namespace "com.example.release"
    defaultConfig {
        applicationId "com.example.release"
        versionCode 45
        versionName "1.2.3"
    }
}
GRADLE
  "$PACKAGE_ROOT/scripts/bootstrap_android_fastlane.sh" --project "$validator_groovy" \
    >"$VALIDATOR_ROOT/groovy-bootstrap.stdout" 2>"$VALIDATOR_ROOT/groovy-bootstrap.stderr" ||
    fail 'could not bootstrap the Groovy validator fixture'
  release_validator_run 'Groovy signing validation failed' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.release "$VALIDATOR" --project "$validator_groovy"
  grep -F 'PASS signing.gradle:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'Groovy user-owned release signing was not validated'

  cp "$validator_project/android/app/build.gradle.kts" "$VALIDATOR_ROOT/gradle.good"
  sed 's/getByName("release")/getByName("debug")/' "$VALIDATOR_ROOT/gradle.good" \
    > "$validator_project/android/app/build.gradle.kts"
  release_validator_run 'release-to-debug signing was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL signing.gradle:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'release-to-debug signing did not fail by name'
  cp "$VALIDATOR_ROOT/gradle.good" "$validator_project/android/app/build.gradle.kts"

  printf '\n// BEGIN flutter-play-store-release schema=1\n' \
    >> "$validator_project/android/app/build.gradle.kts"
  release_validator_run 'duplicate signing marker was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL ownership.markers:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'duplicate ownership marker did not fail by name'
  cp "$VALIDATOR_ROOT/gradle.good" "$validator_project/android/app/build.gradle.kts"

  cp "$validator_project/.gitignore" "$VALIDATOR_ROOT/gitignore.good"
  grep -Fv 'android/key.properties' "$VALIDATOR_ROOT/gitignore.good" \
    > "$validator_project/.gitignore"
  release_validator_run 'missing ignore rule was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL gitignore.required:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'missing ignore rule did not fail by name'
  cp "$VALIDATOR_ROOT/gitignore.good" "$validator_project/.gitignore"

  release_validator_run 'setup opt-in commands failed' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project" \
    --context setup --run-project-commands
  grep -F 'flutter pub get' "$validator_log" >/dev/null 2>&1 ||
    fail 'setup opt-in omitted flutter pub get'
  grep -F 'flutter analyze' "$validator_log" >/dev/null 2>&1 ||
    fail 'setup opt-in omitted flutter analyze'
  grep -F 'bundle exec fastlane android doctor' "$validator_log" >/dev/null 2>&1 ||
    fail 'setup opt-in omitted Fastlane doctor'

  release_validator_run 'build opt-in commands failed' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project" \
    --context build --run-project-commands
  grep -F 'flutter build appbundle --release' "$validator_log" >/dev/null 2>&1 ||
    fail 'build opt-in omitted AAB verification'

  release_validator_run 'doctor accepted project command opt-in' 2 \
    "$VALIDATOR" --project "$validator_project" --run-project-commands
  release_validator_run 'deploy accepted missing credentials' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    "$VALIDATOR" --project "$validator_project" --context deploy
  grep -F 'FAIL package_name:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'deploy did not fail the shared package-name check'
  grep -F 'FAIL credentials.play:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'deploy did not fail the shared credential check'

  release_validator_run 'package mismatch was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.wrong "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL package_name:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'package mismatch was not deterministic'

  cp "$validator_project/.github/workflows/release-android.yml" \
    "$VALIDATOR_ROOT/workflow.good"
  printf '\nactive_package: CHANGE_ME_APPLICATION_ID\n' \
    >> "$validator_project/.github/workflows/release-android.yml"
  release_validator_run 'active placeholder was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL placeholders.active:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'active placeholder did not fail by name'
  cp "$VALIDATOR_ROOT/workflow.good" \
    "$validator_project/.github/workflows/release-android.yml"
  printf '\nservice_account: "-----BEGIN PRIVATE KEY-----unsafe"\n' \
    >> "$validator_project/.github/workflows/release-android.yml"
  release_validator_run 'credential-shaped active content was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    APP_PACKAGE_NAME=com.example.kotlin "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL secrets.content:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'credential-shaped content did not fail by name'
  mv "$VALIDATOR_ROOT/workflow.good" \
    "$validator_project/.github/workflows/release-android.yml"

  release_validator_run 'tracked secret filename was accepted' 1 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    FPRS_TRACKED_SECRET=1 APP_PACKAGE_NAME=com.example.kotlin \
    "$VALIDATOR" --project "$validator_project"
  grep -F 'FAIL secrets.tracked_names:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'tracked secret filename did not fail by name'

  release_validator_run 'missing YAML parser was treated as success' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    FPRS_NO_YAML_PARSER=1 APP_PACKAGE_NAME=com.example.kotlin \
    "$VALIDATOR" --project "$validator_project" --format json
  [ "$(wc -l < "$VALIDATOR_STDOUT" | tr -d ' ')" -eq 1 ] ||
    fail 'JSON validator output was not exactly one line'
  grep -F '"level":"WARN","name":"yaml.parser"' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'missing YAML parser was not an explicit JSON warning'

  release_validator_run 'package-only validation failed' 0 env "$validator_env" \
    FPRS_COMMAND_LOG="$validator_log" FPRS_FORBIDDEN_MARKER="$validator_forbidden" \
    "$VALIDATOR" --format human
  grep -F 'WARN project.matrix:' "$VALIDATOR_STDOUT" >/dev/null 2>&1 ||
    fail 'missing real project matrix was not reported'
  [ ! -e "$validator_forbidden" ] || fail 'validator contacted an upload/network adapter'
  pass 'release_validator'
}

documentation() {
  documentation_files='SKILL.md
README.md
templates/PLAY_STORE_RELEASE.md
references/environment-variables.md
references/execution-defaults.md
references/first-release-checklist.md
references/troubleshooting.md'

  for relative_path in $documentation_files
  do
    assert_file "$relative_path"
    if LC_ALL=C grep '[^ -~	]' "$PACKAGE_ROOT/$relative_path" >/dev/null 2>&1; then
      fail "runtime documentation must use English ASCII prose: $relative_path"
    fi
    if grep -E '/Users/|file://|[A-Za-z]:\\\\Users\\\\' "$PACKAGE_ROOT/$relative_path" >/dev/null 2>&1; then
      fail "runtime documentation contains a machine-specific path: $relative_path"
    fi
  done

  skill_lines=$(wc -l < "$PACKAGE_ROOT/SKILL.md" | tr -d ' ')
  [ "$skill_lines" -lt 500 ] || fail 'SKILL.md must remain under 500 lines'
  [ "$(sed -n '1p' "$PACKAGE_ROOT/SKILL.md")" = '---' ] ||
    fail 'SKILL.md must start with YAML frontmatter'
  [ "$(sed -n '2p' "$PACKAGE_ROOT/SKILL.md")" = 'name: toris-flutter-play-store-release' ] ||
    fail 'SKILL.md must declare only the canonical name first'
  case "$(sed -n '3p' "$PACKAGE_ROOT/SKILL.md")" in
    'description: '[A-Za-z]*) ;;
    *) fail 'SKILL.md must declare an English description second' ;;
  esac
  [ "$(sed -n '4p' "$PACKAGE_ROOT/SKILL.md")" = '---' ] ||
    fail 'SKILL.md frontmatter may contain only name and description'
  [ "$(sed -n '5p' "$PACKAGE_ROOT/SKILL.md")" != '---' ] ||
    fail 'SKILL.md contains an extra frontmatter field'

  for heading in \
    '## Quick start' '## Triggers' '## Classification' '## Inspect' \
    '## Authorization gate' '## Execute' '## Validate' '## Completion report' \
    '## Definition of done'
  do
    assert_contains 'SKILL.md' "$heading"
  done
  for mode in setup doctor build deploy ci firebase-distribution slack repair
  do
    assert_contains 'SKILL.md' "\`$mode\`"
  done
  for use_case in \
    'Set up Android release automation.' \
    'Check whether this Flutter app is ready for Google Play.' \
    'Build an Android App Bundle without uploading it.' \
    'Deploy this build to the named Google Play track.' \
    'Configure the Android release workflow in GitHub Actions.' \
    'Distribute this Android build with Firebase App Distribution.' \
    'Add Slack release notifications.' \
    'Repair the existing Android release setup.'
  do
    assert_contains 'SKILL.md' "$use_case"
  done
  assert_contains 'SKILL.md' '/toris-flutter-play-store-release'
  assert_contains 'SKILL.md' '$toris-flutter-play-store-release'
  assert_contains 'SKILL.md' 'Android only'
  assert_contains 'SKILL.md' 'Inspect before editing.'
  assert_contains 'SKILL.md' 'Do not upload'
  assert_contains 'SKILL.md' 'references/execution-defaults.md'
  if grep -E 'references/[^)[:space:]]*/[^)[:space:]]+' "$PACKAGE_ROOT/SKILL.md" >/dev/null 2>&1; then
    fail 'SKILL.md reference links must remain one level deep'
  fi

  for section in \
    '## Purpose' '## Compatibility' '## Install, update, and uninstall' \
    '## Rename migration' '## Direct scripts' '## Example prompts' '## Modes' '## Safety' \
    '## Generated files' '## Validation' '## Limitations' '## Sources'
  do
    assert_contains 'README.md' "$section"
  done

  for topic in \
    '## 1. Purpose' '## 2. Generated files' '## 3. Play Console setup' \
    '## 4. Service account setup' '## 5. Upload key setup' \
    '## 6. GitHub secrets' '## 7. First manual upload' \
    '## 8. Local doctor' '## 9. Local build' '## 10. Internal deployment' \
    '## 11. GitHub Release runs' '## 12. Manual workflow runs' \
    '## 13. Slack notifications' '## 14. Firebase App Distribution' \
    '## 15. Troubleshooting' '## 16. Key loss and rotation' \
    '## 17. Rollback and promotion'
  do
    assert_contains 'templates/PLAY_STORE_RELEASE.md' "$topic"
  done

  documentation_corpus="$TMP_ROOT/documentation-corpus"
  : > "$documentation_corpus"
  for relative_path in $documentation_files
  do
    sed -n '1,$p' "$PACKAGE_ROOT/$relative_path" >> "$documentation_corpus"
  done
  for required_text in \
    'flutter_version -> project pin -> FLUTTER_VERSION -> fail' \
    'play-store-production' 'play-store-nonproduction' \
    'ANDROID_KEY_PROPERTIES_PATH' 'FIREBASE_ANDROID_ARTIFACT_TYPE' \
    'APP_PACKAGE_NAME' 'ANDROID_KEYSTORE_BASE64' 'ANDROID_KEYSTORE_PASSWORD' \
    'ANDROID_KEY_ALIAS' 'ANDROID_KEY_PASSWORD' \
    'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64' \
    'FIREBASE_SERVICE_ACCOUNT_JSON_BASE64' 'SLACK_WEBHOOK_URL' \
    'FIREBASE_APP_ID' 'FIREBASE_TESTER_GROUPS' 'FIREBASE_TESTERS' \
    'RETRY_UNKNOWN_UPLOAD' 'CONFIRM_UPLOAD_RECONCILED' \
    'RECONCILED_VERSION_NAME' 'RECONCILED_VERSION_CODE' \
    'RECONCILED_ARTIFACT_SHA256' 'RECONCILED_DESTINATIONS' \
    'RECONCILED_PROVIDER_STATE' \
    'gh secret set SECRET_NAME' 'RELEASE_RESULT_PATH' \
    'macOS' 'Linux' 'PowerShell' 'no-wrap Base64' \
    'Encoding is not encryption.' 'Play App Signing' 'upload key backup' \
    'least privilege' 'first manual AAB' 'new personal developer accounts' \
    'closed testing' 'version-sensitive' 'rollback' 'promotion' \
    'test-app signing certificate' 'Slack failure must not mask' \
    'path > Base64 > default' 'type | context | default | precedence | secrecy | validation | owner' \
    'authentication' 'permissions' 'draft or new app' 'reused version code' \
    'stale artifacts' 'Firebase Play link' 'CI runner and actions' \
    'exact lowercase string' 'unmarked fresh retry cannot' \
    "GitHub.com's 25 top-level" 'newly built artifact SHA-256'
  do
    grep -F -- "$required_text" "$documentation_corpus" >/dev/null 2>&1 ||
      fail "documentation corpus does not contain: $required_text"
  done

  for source_url in \
    'https://docs.flutter.dev/deployment/android' \
    'https://developer.android.com/studio/publish/app-signing' \
    'https://developers.google.com/android-publisher' \
    'https://docs.fastlane.tools/actions/upload_to_play_store/' \
    'https://docs.github.com/actions' \
    'https://firebase.google.com/docs/app-distribution/android/distribute-fastlane'
  do
    grep -F -- "$source_url" "$documentation_corpus" >/dev/null 2>&1 ||
      fail "documentation corpus is missing primary source: $source_url"
  done

  pass 'documentation'
}

repository_integration() {
  repository_root=$(CDPATH= cd -- "$PACKAGE_ROOT/.." && pwd)
  repository_readme=$repository_root/README.md
  repository_validator=$repository_root/scripts/validate_skills.py

  [ -f "$repository_readme" ] || fail 'repository README is missing'
  [ -f "$repository_validator" ] || fail 'repository validator is missing'

  for expected_text in \
    'packages seven reusable agent skills' \
    '[`toris-flutter-play-store-release`](toris-flutter-play-store-release/)' \
    'expo-interactive-design toris-flutter-play-store-release; do' \
    'Use $toris-flutter-play-store-release' \
    '├── toris-flutter-play-store-release/' \
    'bash toris-flutter-play-store-release/tests/run_tests.sh' \
    'LEGACY_SKILL="$HOME/.agents/skills/flutter-play-store-release"'
  do
    grep -F -- "$expected_text" "$repository_readme" >/dev/null 2>&1 ||
      fail "repository README does not contain: $expected_text"
  done

  if ! repository_validation=$(python3 "$repository_validator" 2>&1); then
    printf '%s\n' "$repository_validation" >&2
    fail 'repository validator rejected the seven-skill collection'
  fi
  [ "$repository_validation" = 'Validated 7 skills successfully.' ] ||
    fail 'repository validator did not report exactly seven skills'

  pass 'repository_integration'
}

installation() {
  INSTALLATION_ROOT="$TMP_ROOT/installation"
  INSTALLATION_HOME="$INSTALLATION_ROOT/home"
  INSTALLATION_SOURCE="$INSTALLATION_ROOT/source"
  mkdir -p "$INSTALLATION_HOME" "$INSTALLATION_SOURCE"
  cp -R "$PACKAGE_ROOT/." "$INSTALLATION_SOURCE/"

  if ! HOME="$INSTALLATION_HOME" "$PACKAGE_ROOT/install.sh" \
    --source "$INSTALLATION_SOURCE" > "$INSTALLATION_ROOT/install.stdout" \
    2> "$INSTALLATION_ROOT/install.stderr"
  then
    cat "$INSTALLATION_ROOT/install.stderr" >&2
    fail 'initial dual-destination installation failed'
  fi

  installation_claude="$INSTALLATION_HOME/.claude/skills/toris-flutter-play-store-release"
  installation_agents="$INSTALLATION_HOME/.agents/skills/toris-flutter-play-store-release"
  assert_file_path() {
    [ -f "$1" ] && [ ! -L "$1" ] || fail "$2"
  }
  assert_file_path "$installation_claude/.skill-install-receipt" \
    'Claude installation receipt is missing'
  assert_file_path "$installation_agents/.skill-install-receipt" \
    'Agents installation receipt is missing'
  assert_same_file "$installation_claude/.skill-install-receipt" \
    "$installation_agents/.skill-install-receipt" \
    'dual-destination receipts differ'
  assert_same_file "$installation_claude/README.md" \
    "$installation_agents/README.md" \
    'dual-destination package files differ'
  [ ! -e "$installation_claude/tests" ] || \
    fail 'canonical-only tests were installed'

  printf '\nLifecycle update fixture.\n' >> "$INSTALLATION_SOURCE/README.md"
  HOME="$INSTALLATION_HOME" "$PACKAGE_ROOT/update.sh" \
    --source "$INSTALLATION_SOURCE" > "$INSTALLATION_ROOT/update.stdout" \
    2> "$INSTALLATION_ROOT/update.stderr" || fail 'verified update failed'
  assert_same_file "$INSTALLATION_SOURCE/README.md" \
    "$installation_claude/README.md" 'Claude update content differs'
  assert_same_file "$installation_claude/README.md" \
    "$installation_agents/README.md" 'updated copies differ'

  printf 'user edit\n' >> "$installation_claude/README.md"
  if HOME="$INSTALLATION_HOME" "$PACKAGE_ROOT/update.sh" \
    --source "$INSTALLATION_SOURCE" > /dev/null 2>&1
  then
    fail 'update accepted an edited installed file'
  fi
  grep -F 'user edit' "$installation_claude/README.md" >/dev/null 2>&1 ||
    fail 'refused update mutated the edited destination'

  if HOME="$INSTALLATION_HOME" "$PACKAGE_ROOT/uninstall.sh" --yes \
    > /dev/null 2>&1
  then
    fail 'uninstall accepted an edited installed file'
  fi
  grep -F 'user edit' "$installation_claude/README.md" >/dev/null 2>&1 ||
    fail 'refused uninstall mutated the edited destination'

  INSTALLATION_RECOVERY_SOURCE="$INSTALLATION_ROOT/recovery-source"
  mkdir -p "$INSTALLATION_RECOVERY_SOURCE"
  cp -R "$PACKAGE_ROOT/." "$INSTALLATION_RECOVERY_SOURCE/"
  printf '\nCrash recovery fixture.\n' >> "$INSTALLATION_RECOVERY_SOURCE/README.md"
  for installation_phase in \
    staged claude_old_moved agents_old_moved claude_new_installed \
    agents_new_installed validated committed
  do
    phase_home="$INSTALLATION_ROOT/home-$installation_phase"
    mkdir -p "$phase_home"
    HOME="$phase_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" \
      > /dev/null 2>&1 || fail "phase fixture install failed: $installation_phase"
    if env HOME="$phase_home" FPRS_TEST_MODE=1 \
      FPRS_TEST_KILL_INSTALL_PHASE="$installation_phase" \
      "$PACKAGE_ROOT/update.sh" --source "$INSTALLATION_RECOVERY_SOURCE" \
      > /dev/null 2>&1
    then
      fail "phase kill did not stop update: $installation_phase"
    fi
    HOME="$phase_home" "$PACKAGE_ROOT/update.sh" --source "$INSTALLATION_ROOT/missing-source" \
      > /dev/null 2>&1 && fail "invalid source unexpectedly succeeded: $installation_phase"
    phase_claude="$phase_home/.claude/skills/toris-flutter-play-store-release/README.md"
    phase_agents="$phase_home/.agents/skills/toris-flutter-play-store-release/README.md"
    assert_same_file "$phase_claude" "$phase_agents" \
      "recovery split installed copies: $installation_phase"
    if [ "$installation_phase" = committed ]; then
      assert_same_file "$INSTALLATION_RECOVERY_SOURCE/README.md" "$phase_claude" \
        'committed recovery did not preserve the new copy'
    else
      assert_same_file "$PACKAGE_ROOT/README.md" "$phase_claude" \
        "pre-commit recovery did not restore the prior copy: $installation_phase"
    fi
    [ ! -e "$phase_home/.toris-flutter-play-store-release-install-state/transaction" ] ||
      fail "recovery journal remained after phase recovery: $installation_phase"
  done

  for installation_phase in \
    staged claude_old_moved agents_old_moved claude_new_installed \
    agents_new_installed validated committed
  do
    case "$installation_phase" in
      staged|claude_new_installed|committed) installation_signal_name=HUP ;;
      claude_old_moved|agents_new_installed) installation_signal_name=INT ;;
      *) installation_signal_name=TERM ;;
    esac
    signal_home="$INSTALLATION_ROOT/signal-home-$installation_phase"
    mkdir -p "$signal_home"
    HOME="$signal_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" \
      > /dev/null 2>&1 || fail "signal fixture install failed: $installation_phase"
    env HOME="$signal_home" FPRS_TEST_MODE=1 \
      FPRS_TEST_SIGNAL_INSTALL_PHASE="$installation_phase" \
      FPRS_TEST_SIGNAL_NAME="$installation_signal_name" \
      "$PACKAGE_ROOT/update.sh" --source "$INSTALLATION_RECOVERY_SOURCE" \
      > /dev/null 2>&1
    signal_status=$?
    [ "$signal_status" -eq 3 ] ||
      fail "catchable signal did not return status 3 at $installation_phase (got $signal_status)"
    signal_claude="$signal_home/.claude/skills/toris-flutter-play-store-release/README.md"
    signal_agents="$signal_home/.agents/skills/toris-flutter-play-store-release/README.md"
    assert_same_file "$signal_claude" "$signal_agents" \
      "catchable signal split installed copies: $installation_phase"
    if [ "$installation_phase" = committed ]; then
      assert_same_file "$INSTALLATION_RECOVERY_SOURCE/README.md" "$signal_claude" \
        'committed signal did not preserve the new copies'
    else
      assert_same_file "$PACKAGE_ROOT/README.md" "$signal_claude" \
        "pre-commit signal did not restore the old copies: $installation_phase"
    fi
  done

  installation_expect_status() {
    installation_expected_status=$1
    installation_description=$2
    shift 2
    "$@" > "$INSTALLATION_ROOT/case.stdout" 2> "$INSTALLATION_ROOT/case.stderr"
    installation_actual_status=$?
    [ "$installation_actual_status" -eq "$installation_expected_status" ] || {
      cat "$INSTALLATION_ROOT/case.stderr" >&2
      fail "$installation_description (expected $installation_expected_status, got $installation_actual_status)"
    }
  }

  # Source/destination boundaries and manifest grammar are refusal-only.
  ln -s "$PACKAGE_ROOT" "$INSTALLATION_ROOT/source-link"
  boundary_home="$INSTALLATION_ROOT/boundary-home"
  mkdir -p "$boundary_home"
  installation_expect_status 2 'source symlink was accepted' \
    env HOME="$boundary_home" "$PACKAGE_ROOT/install.sh" --source "$INSTALLATION_ROOT/source-link"
  overlap_source="$INSTALLATION_ROOT/overlap-source"
  mkdir -p "$overlap_source"
  cp -R "$PACKAGE_ROOT/." "$overlap_source/"
  installation_expect_status 2 'source/destination overlap was accepted' \
    env HOME="$overlap_source" "$PACKAGE_ROOT/install.sh" --source "$overlap_source"
  self_home="$INSTALLATION_ROOT/self-home"
  mkdir -p "$self_home"
  HOME="$self_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" > /dev/null 2>&1 ||
    fail 'self-update fixture install failed'
  installation_expect_status 2 'installed-copy self-update was accepted' \
    env HOME="$self_home" "$PACKAGE_ROOT/update.sh" \
    --source "$self_home/.claude/skills/toris-flutter-play-store-release"
  symlink_home="$INSTALLATION_ROOT/destination-symlink-home"
  mkdir -p "$symlink_home/.claude/skills" "$symlink_home/unrelated"
  ln -s "$symlink_home/unrelated" "$symlink_home/.claude/skills/toris-flutter-play-store-release"
  installation_expect_status 2 'destination symlink was accepted' \
    env HOME="$symlink_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT"
  unrelated_home="$INSTALLATION_ROOT/unrelated-destination-home"
  mkdir -p "$unrelated_home/.agents/skills/toris-flutter-play-store-release"
  printf 'foreign\n' > "$unrelated_home/.agents/skills/toris-flutter-play-store-release/foreign.txt"
  installation_expect_status 2 'unrelated destination directory was accepted' \
    env HOME="$unrelated_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT"

  for manifest_case in missing malformed traversal duplicate
  do
    manifest_source="$INSTALLATION_ROOT/manifest-$manifest_case"
    manifest_home="$INSTALLATION_ROOT/manifest-home-$manifest_case"
    mkdir -p "$manifest_source" "$manifest_home"
    cp -R "$PACKAGE_ROOT/." "$manifest_source/"
    case "$manifest_case" in
      missing)
        grep -v '^\.skill-package-id$' "$manifest_source/install-manifest.txt" \
          > "$manifest_source/install-manifest.new"
        ;;
      malformed)
        printf 'README.md' > "$manifest_source/install-manifest.new"
        ;;
      traversal)
        { printf '../escape\n'; cat "$manifest_source/install-manifest.txt"; } \
          > "$manifest_source/install-manifest.new"
        ;;
      duplicate)
        { cat "$manifest_source/install-manifest.txt"; printf 'README.md\n'; } |
          LC_ALL=C sort > "$manifest_source/install-manifest.new"
        ;;
    esac
    mv "$manifest_source/install-manifest.new" "$manifest_source/install-manifest.txt"
    installation_expect_status 2 "invalid manifest was accepted: $manifest_case" \
      env HOME="$manifest_home" "$PACKAGE_ROOT/install.sh" --source "$manifest_source"
  done

  for tree_case in receipt-mode unexpected-file unexpected-directory unexpected-symlink
  do
    tree_home="$INSTALLATION_ROOT/tree-home-$tree_case"
    mkdir -p "$tree_home"
    HOME="$tree_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" > /dev/null 2>&1 ||
      fail "tree fixture install failed: $tree_case"
    tree_destination="$tree_home/.claude/skills/toris-flutter-play-store-release"
    case "$tree_case" in
      receipt-mode) chmod 600 "$tree_destination/.skill-install-receipt" ;;
      unexpected-file) printf 'unexpected\n' > "$tree_destination/unexpected.txt" ;;
      unexpected-directory) mkdir "$tree_destination/unexpected" ;;
      unexpected-symlink) ln -s README.md "$tree_destination/unexpected-link" ;;
    esac
    installation_expect_status 2 "unsafe installed tree was accepted: $tree_case" \
      env HOME="$tree_home" "$PACKAGE_ROOT/update.sh" --source "$PACKAGE_ROOT"
  done

  # Dry-run is write-free, and an identical second install preserves the receipt inode.
  dry_home="$INSTALLATION_ROOT/dry-home"
  mkdir -p "$dry_home"
  installation_expect_status 0 'install dry-run failed' \
    env HOME="$dry_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" --dry-run
  [ ! -e "$dry_home/.claude" ] && [ ! -e "$dry_home/.agents" ] &&
    [ ! -e "$dry_home/.toris-flutter-play-store-release-install-state" ] ||
    fail 'install dry-run wrote lifecycle state'
  HOME="$dry_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" > /dev/null 2>&1 ||
    fail 'idempotency fixture install failed'
  dry_receipt="$dry_home/.claude/skills/toris-flutter-play-store-release/.skill-install-receipt"
  if dry_inode=$(stat -f '%i' "$dry_receipt" 2>/dev/null); then :;
  else dry_inode=$(stat -c '%i' "$dry_receipt") || fail 'could not read receipt inode'; fi
  HOME="$dry_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" > /dev/null 2>&1 ||
    fail 'idempotent install failed'
  if dry_inode_after=$(stat -f '%i' "$dry_receipt" 2>/dev/null); then :;
  else dry_inode_after=$(stat -c '%i' "$dry_receipt") || fail 'could not reread receipt inode'; fi
  [ "$dry_inode" = "$dry_inode_after" ] || fail 'idempotent install replaced an unchanged copy'
  installation_expect_status 0 'update dry-run failed' \
    env HOME="$dry_home" "$PACKAGE_ROOT/update.sh" \
    --source "$INSTALLATION_RECOVERY_SOURCE" --dry-run
  assert_same_file "$PACKAGE_ROOT/README.md" \
    "$dry_home/.claude/skills/toris-flutter-play-store-release/README.md" \
    'update dry-run changed an installed copy'
  installation_expect_status 0 'uninstall dry-run failed' \
    env HOME="$dry_home" "$PACKAGE_ROOT/uninstall.sh" --dry-run
  [ -d "$dry_home/.claude/skills/toris-flutter-play-store-release" ] ||
    fail 'uninstall dry-run removed an installed copy'

  # Same-host lock ownership: dead and PID-reused owners are reclaimable;
  # foreign-host and a live matching owner are refused.
  installation_host=$(hostname) || fail 'could not determine test hostname'
  for lock_case in dead reused foreign
  do
    lock_home="$INSTALLATION_ROOT/lock-home-$lock_case"
    lock_root="$lock_home/.toris-flutter-play-store-release-install-state"
    mkdir -p "$lock_root/lock"
    chmod 700 "$lock_root" "$lock_root/lock"
    lock_pid=999999
    lock_host=$installation_host
    [ "$lock_case" = reused ] && lock_pid=$$
    [ "$lock_case" = foreign ] && { lock_pid=$$; lock_host=foreign.invalid; }
    printf '%s\n' \
      'schema_version=1' \
      'token=0123456789abcdef0123456789abcdef' \
      "host=$lock_host" \
      "pid=$lock_pid" \
      'process_identity=darwin-libproc-start:1:1' \
      > "$lock_root/lock/owner"
    chmod 600 "$lock_root/lock/owner"
    if [ "$lock_case" = foreign ]; then
      installation_expect_status 2 'foreign-host lock was reclaimed' \
        env HOME="$lock_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT"
    else
      installation_expect_status 0 "same-host stale lock was not reclaimed: $lock_case" \
        env HOME="$lock_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT"
    fi
  done

  contention_home="$INSTALLATION_ROOT/contention-home"
  contention_control="$INSTALLATION_ROOT/contention-control"
  mkdir -p "$contention_home" "$contention_control"
  HOME="$contention_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" > /dev/null 2>&1 ||
    fail 'contention fixture install failed'
  env HOME="$contention_home" FPRS_TEST_MODE=1 \
    FPRS_TEST_CONTROL_DIR="$contention_control" FPRS_TEST_PAUSE_INSTALL_PHASE=staged \
    "$PACKAGE_ROOT/update.sh" --source "$INSTALLATION_RECOVERY_SOURCE" \
    > "$INSTALLATION_ROOT/contention-worker.stdout" \
    2> "$INSTALLATION_ROOT/contention-worker.stderr" &
  contention_pid=$!
  contention_wait=0
  while [ ! -f "$contention_control/staged.ready" ] && [ "$contention_wait" -lt 300 ]
  do
    sleep 0.01
    contention_wait=$((contention_wait + 1))
  done
  [ -f "$contention_control/staged.ready" ] || fail 'contention worker did not reach staged phase'
  installation_expect_status 2 'live lifecycle lock was not refused' \
    env HOME="$contention_home" "$PACKAGE_ROOT/update.sh" --source "$INSTALLATION_RECOVERY_SOURCE"
  kill -TERM "$contention_pid" || fail 'could not signal lifecycle entrypoint'
  wait "$contention_pid"
  contention_status=$?
  [ "$contention_status" -eq 3 ] ||
    fail "entrypoint signal forwarding returned $contention_status instead of 3"
  assert_same_file "$PACKAGE_ROOT/README.md" \
    "$contention_home/.claude/skills/toris-flutter-play-store-release/README.md" \
    'entrypoint signal did not restore the prior Claude copy'

  # Uninstall accepts absent, one-sided, identical, and independently valid
  # divergent copies, while rename failures and signals preserve atomic state.
  absent_home="$INSTALLATION_ROOT/uninstall-absent-home"
  mkdir -p "$absent_home"
  installation_expect_status 0 'absent uninstall was not idempotent' \
    env HOME="$absent_home" "$PACKAGE_ROOT/uninstall.sh" --yes
  for uninstall_case in identical one-sided divergent
  do
    uninstall_home="$INSTALLATION_ROOT/uninstall-home-$uninstall_case"
    mkdir -p "$uninstall_home"
    HOME="$uninstall_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" > /dev/null 2>&1 ||
      fail "uninstall fixture install failed: $uninstall_case"
    if [ "$uninstall_case" = one-sided ]; then
      rm -rf "$uninstall_home/.agents/skills/toris-flutter-play-store-release"
    elif [ "$uninstall_case" = divergent ]; then
      divergent_home="$INSTALLATION_ROOT/divergent-source-home"
      mkdir -p "$divergent_home"
      HOME="$divergent_home" "$PACKAGE_ROOT/install.sh" --source "$INSTALLATION_RECOVERY_SOURCE" \
        > /dev/null 2>&1 || fail 'divergent fixture install failed'
      rm -rf "$uninstall_home/.agents/skills/toris-flutter-play-store-release"
      mv "$divergent_home/.agents/skills/toris-flutter-play-store-release" \
        "$uninstall_home/.agents/skills/toris-flutter-play-store-release"
    fi
    installation_expect_status 0 "verified uninstall failed: $uninstall_case" \
      env HOME="$uninstall_home" "$PACKAGE_ROOT/uninstall.sh" --yes
    [ ! -e "$uninstall_home/.claude/skills/toris-flutter-play-store-release" ] &&
      [ ! -e "$uninstall_home/.agents/skills/toris-flutter-play-store-release" ] ||
      fail "uninstall left a canonical destination: $uninstall_case"
  done

  for uninstall_role in claude agents
  do
    rename_home="$INSTALLATION_ROOT/uninstall-rename-$uninstall_role"
    mkdir -p "$rename_home"
    HOME="$rename_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" > /dev/null 2>&1 ||
      fail "rename fixture install failed: $uninstall_role"
    installation_expect_status 3 "uninstall rename failure did not roll back: $uninstall_role" \
      env HOME="$rename_home" FPRS_TEST_MODE=1 \
      FPRS_TEST_FAIL_UNINSTALL_SWAP="$uninstall_role" "$PACKAGE_ROOT/uninstall.sh" --yes
    [ -d "$rename_home/.claude/skills/toris-flutter-play-store-release" ] &&
      [ -d "$rename_home/.agents/skills/toris-flutter-play-store-release" ] ||
      fail "uninstall rename failure split destinations: $uninstall_role"
  done

  for uninstall_phase in planned claude_quarantined agents_quarantined committed cleanup_complete
  do
    case "$uninstall_phase" in
      planned|committed) uninstall_signal_name=HUP ;;
      claude_quarantined|cleanup_complete) uninstall_signal_name=INT ;;
      *) uninstall_signal_name=TERM ;;
    esac
    uninstall_signal_home="$INSTALLATION_ROOT/uninstall-signal-$uninstall_phase"
    mkdir -p "$uninstall_signal_home"
    HOME="$uninstall_signal_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" \
      > /dev/null 2>&1 || fail "uninstall signal fixture failed: $uninstall_phase"
    installation_expect_status 3 "uninstall signal status changed: $uninstall_phase" \
      env HOME="$uninstall_signal_home" FPRS_TEST_MODE=1 \
      FPRS_TEST_SIGNAL_INSTALL_PHASE="$uninstall_phase" \
      FPRS_TEST_SIGNAL_NAME="$uninstall_signal_name" "$PACKAGE_ROOT/uninstall.sh" --yes
    if [ "$uninstall_phase" = committed ] || [ "$uninstall_phase" = cleanup_complete ]; then
      [ ! -e "$uninstall_signal_home/.claude/skills/toris-flutter-play-store-release" ] &&
        [ ! -e "$uninstall_signal_home/.agents/skills/toris-flutter-play-store-release" ] ||
        fail "committed uninstall signal restored a destination: $uninstall_phase"
    else
      [ -d "$uninstall_signal_home/.claude/skills/toris-flutter-play-store-release" ] &&
        [ -d "$uninstall_signal_home/.agents/skills/toris-flutter-play-store-release" ] ||
        fail "pre-commit uninstall signal split destinations: $uninstall_phase"
    fi
  done

  for cleanup_role in claude agents
  do
    cleanup_home="$INSTALLATION_ROOT/uninstall-cleanup-$cleanup_role"
    mkdir -p "$cleanup_home"
    HOME="$cleanup_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" > /dev/null 2>&1 ||
      fail "cleanup fixture install failed: $cleanup_role"
    env HOME="$cleanup_home" FPRS_TEST_MODE=1 \
      FPRS_TEST_FAIL_UNINSTALL_CLEANUP="$cleanup_role" \
      "$PACKAGE_ROOT/uninstall.sh" --yes > /dev/null 2>&1
    cleanup_status=$?
    [ "$cleanup_status" -ne 0 ] || fail "cleanup failure was ignored: $cleanup_role"
    [ ! -e "$cleanup_home/.claude/skills/toris-flutter-play-store-release" ] &&
      [ ! -e "$cleanup_home/.agents/skills/toris-flutter-play-store-release" ] ||
      fail "post-commit cleanup failure restored destinations: $cleanup_role"
    installation_expect_status 0 "cleanup recovery failed: $cleanup_role" \
      env HOME="$cleanup_home" "$PACKAGE_ROOT/uninstall.sh" --yes
  done

  for uninstall_kill_phase in \
    planned claude_quarantined agents_quarantined committed cleanup_complete
  do
    kill_home="$INSTALLATION_ROOT/uninstall-kill-$uninstall_kill_phase"
    mkdir -p "$kill_home"
    HOME="$kill_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" \
      > /dev/null 2>&1 || fail "uninstall kill fixture failed: $uninstall_kill_phase"
    env HOME="$kill_home" FPRS_TEST_MODE=1 \
      FPRS_TEST_KILL_INSTALL_PHASE="$uninstall_kill_phase" \
      "$PACKAGE_ROOT/uninstall.sh" --yes > /dev/null 2>&1
    kill_status=$?
    [ "$kill_status" -ne 0 ] || fail "uninstall kill phase completed: $uninstall_kill_phase"
    installation_expect_status 2 "uninstall kill recovery failed: $uninstall_kill_phase" \
      env HOME="$kill_home" "$PACKAGE_ROOT/update.sh" --source "$INSTALLATION_ROOT/missing-source"
    if [ "$uninstall_kill_phase" = committed ] ||
      [ "$uninstall_kill_phase" = cleanup_complete ]
    then
      [ ! -e "$kill_home/.claude/skills/toris-flutter-play-store-release" ] &&
        [ ! -e "$kill_home/.agents/skills/toris-flutter-play-store-release" ] ||
        fail "committed uninstall kill restored a destination: $uninstall_kill_phase"
    else
      [ -d "$kill_home/.claude/skills/toris-flutter-play-store-release" ] &&
        [ -d "$kill_home/.agents/skills/toris-flutter-play-store-release" ] ||
        fail "pre-commit uninstall kill did not restore both copies: $uninstall_kill_phase"
    fi
    [ ! -e "$kill_home/.toris-flutter-play-store-release-install-state/transaction" ] ||
      fail "uninstall recovery retained its journal: $uninstall_kill_phase"
  done

  for journal_case in unknown duplicate transaction-id path basename mode
  do
    journal_home="$INSTALLATION_ROOT/journal-home-$journal_case"
    mkdir -p "$journal_home"
    HOME="$journal_home" "$PACKAGE_ROOT/install.sh" --source "$PACKAGE_ROOT" \
      > /dev/null 2>&1 || fail "journal fixture install failed: $journal_case"
    env HOME="$journal_home" FPRS_TEST_MODE=1 FPRS_TEST_KILL_INSTALL_PHASE=staged \
      "$PACKAGE_ROOT/update.sh" --source "$INSTALLATION_RECOVERY_SOURCE" \
      > /dev/null 2>&1
    journal_status=$?
    [ "$journal_status" -ne 0 ] || fail "journal fixture was not interrupted: $journal_case"
    journal_path="$journal_home/.toris-flutter-play-store-release-install-state/transaction"
    [ -f "$journal_path" ] || fail "journal fixture is missing: $journal_case"
    case "$journal_case" in
      unknown) printf 'unknown_key=value\n' >> "$journal_path" ;;
      duplicate) printf 'schema_version=1\n' >> "$journal_path" ;;
      transaction-id)
        awk '/^transaction_id=/{print "transaction_id=bad"; next} {print}' \
          "$journal_path" > "$journal_path.new"
        mv "$journal_path.new" "$journal_path"
        chmod 600 "$journal_path"
        ;;
      path)
        awk '/^claude_stage=/{print "claude_stage=/tmp/not-owned"; next} {print}' \
          "$journal_path" > "$journal_path.new"
        mv "$journal_path.new" "$journal_path"
        chmod 600 "$journal_path"
        ;;
      basename)
        awk '/^agents_rollback=/{sub(/\.rollback$/, ".other")} {print}' \
          "$journal_path" > "$journal_path.new"
        mv "$journal_path.new" "$journal_path"
        chmod 600 "$journal_path"
        ;;
      mode) chmod 644 "$journal_path" ;;
    esac
    installation_expect_status 2 "tampered journal was accepted: $journal_case" \
      env HOME="$journal_home" "$PACKAGE_ROOT/update.sh" --source "$INSTALLATION_RECOVERY_SOURCE"
    assert_same_file "$PACKAGE_ROOT/README.md" \
      "$journal_home/.claude/skills/toris-flutter-play-store-release/README.md" \
      "tampered journal mutated the canonical destination: $journal_case"
    [ -e "$journal_path" ] || fail "tampered journal evidence was deleted: $journal_case"
  done

  pass 'installation'
}

run_test_group() {
  case "$1" in
    package_contract) package_contract ;;
    secret_codecs) secret_codecs ;;
    inspection) inspection ;;
    project_transaction) project_transaction ;;
    gradle_signing) gradle_signing ;;
    bootstrap_core) bootstrap_core ;;
    bootstrap_full) bootstrap_full ;;
    fastlane_templates) fastlane_templates ;;
    flutter_sdk_installer) flutter_sdk_installer ;;
    workflow_template) workflow_template ;;
    release_validator) release_validator ;;
    documentation) documentation ;;
    repository_integration) repository_integration ;;
    installation) installation ;;
    *) fail "unknown test group: $1" ;;
  esac
}

if [ "$#" -eq 0 ] || [ "${1-}" = all ]; then
  [ "$#" -le 1 ] || fail 'all cannot be combined with named test groups'
  package_contract
  secret_codecs
  inspection
  project_transaction
  gradle_signing
  bootstrap_core
  bootstrap_full
  fastlane_templates
  flutter_sdk_installer
  workflow_template
  release_validator
  documentation
  repository_integration
  installation
else
  for requested_group in "$@"
  do
    run_test_group "$requested_group"
  done
fi
