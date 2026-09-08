#!/usr/bin/env bash
# Validate Flutter Android release configuration without uploading anything.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || {
  printf 'ERROR: could not resolve the validator directory\n' >&2
  exit 1
}
PACKAGE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd -P) || exit 1
COMMON="$SCRIPT_DIR/lib/common.sh"
INSPECTOR="$SCRIPT_DIR/inspect_flutter_project.sh"
[ -r "$COMMON" ] || {
  printf 'ERROR: common helpers are unavailable\n' >&2
  exit 1
}
. "$COMMON"

fprs_validator_usage() {
  printf 'Usage: %s [--project PATH] [--context doctor|setup|build|deploy] [--format human|json] [--run-project-commands]\n' \
    "${0##*/}" >&2
}

fprs_validator_bad_argument() {
  printf 'ERROR: %s\n' "$1" >&2
  fprs_validator_usage
  exit 2
}

project=
context=doctor
output_format=human
run_project_commands=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_validator_bad_argument '--project requires a path'
      project=$2
      shift 2
      ;;
    --context)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_validator_bad_argument '--context requires a value'
      context=$2
      shift 2
      ;;
    --format)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_validator_bad_argument '--format requires a value'
      output_format=$2
      shift 2
      ;;
    --run-project-commands)
      run_project_commands=true
      shift
      ;;
    -h|--help)
      fprs_validator_usage
      exit 0
      ;;
    *) fprs_validator_bad_argument "unknown argument: $1" ;;
  esac
done

case "$context" in doctor|setup|build|deploy) ;; *) fprs_validator_bad_argument "invalid context: $context" ;; esac
case "$output_format" in human|json) ;; *) fprs_validator_bad_argument "invalid format: $output_format" ;; esac
if [ "$run_project_commands" = true ]; then
  case "$context" in
    setup|build) ;;
    *) fprs_validator_bad_argument '--run-project-commands is valid only with setup or build context' ;;
  esac
  [ -n "$project" ] || fprs_validator_bad_argument '--run-project-commands requires --project'
fi

validator_tmp=$(mktemp -d "${TMPDIR:-/tmp}/toris-flutter-play-store-release-validator.XXXXXX") || {
  printf 'ERROR: could not create validator temporary storage\n' >&2
  exit 1
}
validator_cleanup() {
  case "$validator_tmp" in
    "${TMPDIR:-/tmp}"/toris-flutter-play-store-release-validator.*) rm -rf -- "$validator_tmp" ;;
  esac
}
trap validator_cleanup EXIT HUP INT TERM
checks="$validator_tmp/checks.tsv"
: > "$checks"

fprs_validator_add() {
  validator_level=$1
  validator_name=$2
  validator_message=$3
  validator_command=${4:--}
  case "$validator_level" in PASS|WARN|FAIL) ;; *) return 1 ;; esac
  case "$validator_name$validator_message$validator_command" in
    *'\t'*|*'\n'*) return 1 ;;
  esac
  printf '%s\t%s\t%s\t%s\n' "$validator_level" "$validator_name" \
    "$validator_message" "$validator_command" >> "$checks"
}

fprs_validator_context_level() {
  if [ "$context" = deploy ]; then
    printf 'FAIL\n'
  else
    printf 'WARN\n'
  fi
}

fprs_validator_json_scalar() {
  validator_key=$1
  validator_file=$2
  awk -v key="$validator_key" '
    {
      marker = "\"" key "\":"
      position = index($0, marker)
      if (!position) next
      value = substr($0, position + length(marker))
      if (substr(value, 1, 1) == "\"") {
        value = substr(value, 2)
        sub(/\".*/, "", value)
      } else {
        sub(/[,}].*/, "", value)
      }
      print value
      exit
    }
  ' "$validator_file"
}

fprs_validator_file_safe() {
  [ -f "$1" ] && [ ! -L "$1" ]
}

fprs_validator_active_text() {
  case "$1" in
    *.gradle|*.gradle.kts) ;;
    *)
      awk '$0 !~ /^[[:space:]]*(#|\/\/)/ { print }' "$1"
      return
      ;;
  esac
  awk '
    {
      line = $0
      while (1) {
        if (block) {
          if (match(line, /\*\//)) {
            line = substr(line, RSTART + RLENGTH)
            block = 0
            continue
          }
          line = ""
          break
        }
        if (match(line, /\/\*/)) {
          before = substr(line, 1, RSTART - 1)
          rest = substr(line, RSTART + RLENGTH)
          if (match(rest, /\*\//)) {
            line = before substr(rest, RSTART + RLENGTH)
            continue
          }
          line = before
          block = 1
        }
        break
      }
      if (line ~ /^[[:space:]]*(#|\/\/)/) next
      print line
    }
  ' "$1"
}

fprs_validator_parse_properties() {
  properties_source=$1
  properties_output=$2
  properties_parse_kind=$3
  if [ "$properties_parse_kind" = local ]; then
    awk '
      function trim(value) {
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        return value
      }
      /^[[:space:]]*$/ { next }
      /^[[:space:]]*#/ { next }
      {
        split_at = index($0, "=")
        if (split_at) {
          key = trim(substr($0, 1, split_at - 1))
          value = substr($0, split_at + 1)
        } else {
          key = trim($0)
          value = ""
        }
        print key "\t" value
      }
    ' "$properties_source" > "$properties_output"
    return
  fi
  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function separator(value, index_value, character, escaped) {
      escaped = 0
      for (index_value = 1; index_value <= length(value); index_value++) {
        character = substr(value, index_value, 1)
        if (escaped) { escaped = 0; continue }
        if (character == "\\") { escaped = 1; continue }
        if (character == "=" || character == ":") return index_value
      }
      return 0
    }
    /^[[:space:]]*($|#|!)/ { next }
    {
      split_at = separator($0)
      if (!split_at) exit 2
      key = trim(substr($0, 1, split_at - 1))
      value = substr($0, split_at + 1)
      sub(/^[[:space:]]+/, "", value)
      if (key == "" || seen[key]++) exit 2
      print key "\t" value
    }
  ' "$properties_source" > "$properties_output"
}

fprs_validator_check_properties() {
  properties_path=$1
  properties_kind=$2
  case "$properties_path" in /*) ;; *) properties_path="$PWD/$properties_path" ;; esac
  properties_error=
  properties_records="$validator_tmp/properties.$$.tsv"
  if ! fprs_validator_file_safe "$properties_path"; then
    properties_error='properties file is not a safe regular file'
    return 1
  fi
  if [ "$properties_kind" = override ]; then
    properties_mode=$(fprs_file_mode "$properties_path" 2>/dev/null || true)
    properties_parent=${properties_path%/*}
    [ -n "$properties_parent" ] || properties_parent=.
    properties_parent_mode=$(fprs_file_mode "$properties_parent" 2>/dev/null || true)
    if [ "$properties_mode" != 600 ]; then
      properties_error='ANDROID_KEY_PROPERTIES_PATH must have mode 0600'
      return 1
    fi
    if [ ! -d "$properties_parent" ] || [ -L "$properties_parent" ] || \
      [ "$properties_parent_mode" != 700 ]; then
      properties_error='ANDROID_KEY_PROPERTIES_PATH parent must be a non-symlink mode-0700 directory'
      return 1
    fi
  fi
  if ! fprs_validator_parse_properties "$properties_path" "$properties_records" \
    "$properties_kind"; then
    properties_error='properties file is malformed or contains duplicate keys'
    return 1
  fi
  for properties_key in storeFile storePassword keyAlias keyPassword
  do
    properties_value=$(awk -F '\t' -v key="$properties_key" '
      $1 == key { value=substr($0, index($0, "\t") + 1); found=1 }
      END { if (found) print value; exit(found ? 0 : 1) }
    ' "$properties_records" 2>/dev/null) || {
      properties_error="properties file is missing $properties_key"
      return 1
    }
    [ -n "$properties_value" ] || {
      properties_error="properties file has an empty $properties_key"
      return 1
    }
    [ "$properties_key" = storeFile ] && properties_store_file=$properties_value
  done
  properties_store_file=$(printf '%s\n' "$properties_store_file" | \
    sed 's/\\ / /g; s/\\:/:/g; s/\\=/=/g; s/\\\\/\\/g')
  case "$properties_store_file" in
    /*) properties_resolved_store=$properties_store_file ;;
    *)
      if [ "$properties_kind" = override ]; then
        properties_error='ANDROID_KEY_PROPERTIES_PATH storeFile must be absolute'
        return 1
      fi
      properties_resolved_store="$project_root/android/app/$properties_store_file"
      ;;
  esac
  if ! fprs_validator_file_safe "$properties_resolved_store" || [ ! -s "$properties_resolved_store" ]; then
    properties_error='storeFile must resolve to a nonempty regular keystore'
    return 1
  fi
  return 0
}

fprs_validator_shell_syntax() {
  validator_shell_failed=
  for validator_shell in \
    "$PACKAGE_ROOT/install.sh" \
    "$PACKAGE_ROOT/update.sh" \
    "$PACKAGE_ROOT/uninstall.sh" \
    "$SCRIPT_DIR/bootstrap_android_fastlane.sh" \
    "$SCRIPT_DIR/decode_secret.sh" \
    "$SCRIPT_DIR/encode_secret.sh" \
    "$SCRIPT_DIR/inspect_flutter_project.sh" \
    "$SCRIPT_DIR/install_flutter_sdk.sh" \
    "$SCRIPT_DIR/validate_release_setup.sh" \
    "$SCRIPT_DIR/lib/common.sh" \
    "$SCRIPT_DIR/lib/gradle_signing.sh" \
    "$SCRIPT_DIR/lib/package_sync.sh" \
    "$SCRIPT_DIR/lib/project_transaction.sh"
  do
    if ! bash -n "$validator_shell" >/dev/null 2>&1; then
      validator_shell_failed=${validator_shell##*/}
      break
    fi
  done
  if [ -n "$validator_shell_failed" ]; then
    fprs_validator_add FAIL shell.syntax "Shell syntax is invalid in $validator_shell_failed"
  else
    fprs_validator_add PASS shell.syntax 'Bundled shell entrypoints pass bash syntax validation'
  fi
}

fprs_validator_shell_syntax

if command -v python3 >/dev/null 2>&1 && \
  python_version_output=$(python3 --version 2>&1) && \
  printf '%s\n' "$python_version_output" | grep -E '^Python 3\.[0-9]+([.][0-9]+)?([[:space:]].*)?$' >/dev/null 2>&1
then
  fprs_validator_add PASS toolchain.python3 'Python 3 passed its read-only version check'
else
  fprs_validator_add "$(fprs_validator_context_level)" toolchain.python3 'Python 3 is unavailable or its version check failed; bootstrap and safe file publication cannot run' 'python3 --version'
fi

if command -v java >/dev/null 2>&1; then
  if java -version >"$validator_tmp/java.stdout" 2>"$validator_tmp/java.stderr"; then
    fprs_validator_add PASS toolchain.java 'Java is available'
  else
    fprs_validator_add WARN toolchain.java 'Java is present but its version check failed' 'java -version'
  fi
else
  fprs_validator_add WARN toolchain.java 'Java is unavailable' 'java -version'
fi

ruby_available=false
if command -v ruby >/dev/null 2>&1; then
  ruby_available=true
  if ruby -e 'require "rubygems"; v = Gem::Version.new(RUBY_VERSION); exit(v >= Gem::Version.new("3.2") && v < Gem::Version.new("4.0") ? 0 : 1)' \
    >"$validator_tmp/ruby.stdout" 2>"$validator_tmp/ruby.stderr"
  then
    fprs_validator_add PASS toolchain.ruby 'Ruby satisfies the supported >= 3.2 and < 4.0 range'
  else
    fprs_validator_add "$(fprs_validator_context_level)" toolchain.ruby 'Ruby >= 3.2 and < 4.0 is required' 'ruby --version'
  fi
else
  fprs_validator_add "$(fprs_validator_context_level)" toolchain.ruby 'Ruby is unavailable' 'ruby --version'
fi

if command -v bundle >/dev/null 2>&1 && \
  bundler_version_output=$(bundle --version 2>&1) && \
  [ "$bundler_version_output" = 'Bundler version 4.0.16' ]
then
  fprs_validator_add PASS toolchain.bundler 'Bundler 4.0.16 matches the approved lockfile baseline'
else
  fprs_validator_add "$(fprs_validator_context_level)" toolchain.bundler 'Bundler 4.0.16 is unavailable, broken, or mismatched' 'gem install bundler -v 4.0.16'
fi

if command -v flutter >/dev/null 2>&1; then
  if flutter --version >"$validator_tmp/flutter.stdout" 2>"$validator_tmp/flutter.stderr"; then
    fprs_validator_add PASS toolchain.flutter 'Flutter is available'
  else
    fprs_validator_add "$(fprs_validator_context_level)" toolchain.flutter 'Flutter is present but its read-only version check failed' 'flutter --version'
  fi
else
  fprs_validator_add "$(fprs_validator_context_level)" toolchain.flutter 'Flutter is unavailable' 'flutter --version'
fi

project_root=
inspection_ok=false
application_id=
release_signing=false
release_debug=false

if [ -z "$project" ]; then
  fprs_validator_add "$(fprs_validator_context_level)" project.matrix 'No real Flutter project was supplied; project validation was not run' './scripts/validate_release_setup.sh --project PATH --context doctor'
else
  if [ -d "$project" ] && project_root=$(CDPATH= cd -- "$project" 2>/dev/null && pwd -P); then
    :
  else
    project_root=$project
    fprs_validator_add FAIL project.shape 'The selected project directory is unavailable'
  fi

  if [ -d "$project_root" ]; then
    if [ -f "$project_root/pubspec.yaml" ] && [ -d "$project_root/android" ] && \
      [ -d "$project_root/android/app" ]; then
      fprs_validator_add PASS project.shape 'Flutter Android project shape is present'
    else
      fprs_validator_add FAIL project.shape 'Project must contain pubspec.yaml, android/, and android/app/'
    fi

    if "$INSPECTOR" --project "$project_root" --format json \
      >"$validator_tmp/inspection.json" 2>"$validator_tmp/inspection.stderr"
    then
      inspection_ok=true
      fprs_validator_add PASS project.inspection 'Static project inspection completed'
      application_id=$(fprs_validator_json_scalar application_id "$validator_tmp/inspection.json")
      release_signing=$(fprs_validator_json_scalar release_signing "$validator_tmp/inspection.json")
      release_debug=$(fprs_validator_json_scalar release_uses_debug_signing "$validator_tmp/inspection.json")
    else
      fprs_validator_add FAIL project.inspection 'Static project inspection failed; run the inspector for redacted details' './scripts/inspect_flutter_project.sh --project PATH --format human'
    fi

    required_missing=
    for validator_required in \
      .github/workflows/release-android.yml \
      .gitignore \
      android/Gemfile \
      android/Gemfile.lock \
      android/fastlane/Appfile \
      android/fastlane/Fastfile \
      android/fastlane/Pluginfile \
      android/fastlane/.env.example \
      android/fastlane/lib/flutter_play_store_release.rb \
      android/key.properties.example \
      docs/PLAY_STORE_RELEASE.md \
      tool/flutter-play-store-release/decode_secret.sh \
      tool/flutter-play-store-release/install_flutter_sdk.sh \
      tool/flutter-play-store-release/managed-files.sha256
    do
      if ! fprs_validator_file_safe "$project_root/$validator_required"; then
        required_missing=$validator_required
        break
      fi
    done
    if [ -n "$required_missing" ]; then
      fprs_validator_add FAIL fastlane.files "Required generated file is missing or unsafe: $required_missing"
    else
      fprs_validator_add PASS fastlane.files 'Pinned Fastlane and release support files are present'
    fi
    project_shell_failure=
    for project_shell in \
      "$project_root/tool/flutter-play-store-release/decode_secret.sh" \
      "$project_root/tool/flutter-play-store-release/install_flutter_sdk.sh"
    do
      if fprs_validator_file_safe "$project_shell" && ! bash -n "$project_shell" >/dev/null 2>&1; then
        project_shell_failure=${project_shell#$project_root/}
        break
      fi
    done
    if [ -n "$project_shell_failure" ]; then
      fprs_validator_add FAIL shell.project "Generated shell syntax is invalid: $project_shell_failure"
    elif [ -n "$required_missing" ]; then
      fprs_validator_add FAIL shell.project 'Generated shell syntax could not be fully checked because a required file is absent'
    else
      fprs_validator_add PASS shell.project 'Generated project shell helpers pass syntax validation'
    fi

    sidecar="$project_root/tool/flutter-play-store-release/managed-files.sha256"
    sidecar_failure=
    if ! fprs_validator_file_safe "$sidecar"; then
      sidecar_failure='managed-file sidecar is missing or unsafe'
    elif [ "$(sed -n '1p' "$sidecar")" != 'package_id=flutter-play-store-release' ] || \
      [ "$(sed -n '2p' "$sidecar")" != 'schema_version=1' ]; then
      sidecar_failure='managed-file sidecar has the wrong package identity or schema'
    else
      sidecar_previous=
      : > "$validator_tmp/sidecar.paths"
      while IFS=' ' read -r sidecar_hash sidecar_path sidecar_extra
      do
        [ -n "$sidecar_hash" ] || continue
        case "$sidecar_hash" in *[!0-9a-f]*|'') sidecar_failure='managed-file sidecar has an invalid hash'; break ;; esac
        [ "${#sidecar_hash}" -eq 64 ] || { sidecar_failure='managed-file sidecar has an invalid hash'; break; }
        [ -n "$sidecar_path" ] && [ -z "${sidecar_extra-}" ] || { sidecar_failure='managed-file sidecar has a malformed record'; break; }
        case "$sidecar_path" in /*|../*|*/../*|*/..) sidecar_failure='managed-file sidecar contains an unsafe path'; break ;; esac
        if [ -n "$sidecar_previous" ] && [ "$(printf '%s\n%s\n' "$sidecar_previous" "$sidecar_path" | LC_ALL=C sort | sed -n '1p')" != "$sidecar_previous" ]; then
          sidecar_failure='managed-file sidecar paths are not sorted'
          break
        fi
        [ "$sidecar_previous" != "$sidecar_path" ] || { sidecar_failure='managed-file sidecar contains a duplicate path'; break; }
        sidecar_previous=$sidecar_path
        printf '%s\n' "$sidecar_path" >> "$validator_tmp/sidecar.paths"
        if ! fprs_validator_file_safe "$project_root/$sidecar_path"; then
          sidecar_failure="managed file is missing or unsafe: $sidecar_path"
          break
        fi
        sidecar_actual=$(fprs_sha256 "$project_root/$sidecar_path") || { sidecar_failure='could not compute a managed-file hash'; break; }
        [ "$sidecar_actual" = "$sidecar_hash" ] || { sidecar_failure="managed file hash differs: $sidecar_path"; break; }
      done < <(sed -n '3,$p' "$sidecar")
      cat > "$validator_tmp/sidecar.expected" <<'SIDECAR_PATHS'
.github/workflows/release-android.yml
android/Gemfile
android/Gemfile.lock
android/fastlane/.env.example
android/fastlane/Appfile
android/fastlane/Fastfile
android/fastlane/Pluginfile
android/fastlane/lib/flutter_play_store_release.rb
android/key.properties.example
docs/PLAY_STORE_RELEASE.md
tool/flutter-play-store-release/decode_secret.sh
tool/flutter-play-store-release/install_flutter_sdk.sh
SIDECAR_PATHS
      if [ -z "$sidecar_failure" ] && ! cmp -s "$validator_tmp/sidecar.expected" "$validator_tmp/sidecar.paths"; then
        sidecar_failure='managed-file sidecar inventory is incomplete or unexpected'
      fi
    fi
    if [ -n "$sidecar_failure" ]; then
      fprs_validator_add FAIL ownership.hashes "$sidecar_failure"
    else
      fprs_validator_add PASS ownership.hashes 'Managed-file identity and SHA-256 records match'
    fi

    gradle_file=
    if fprs_validator_file_safe "$project_root/android/app/build.gradle.kts"; then
      gradle_file="$project_root/android/app/build.gradle.kts"
    elif fprs_validator_file_safe "$project_root/android/app/build.gradle"; then
      gradle_file="$project_root/android/app/build.gradle"
    fi
    marker_failure=
    if [ -z "$gradle_file" ]; then
      marker_failure='Android app Gradle file is missing or ambiguous'
    else
      marker_begin=$(grep -c '^[[:space:]]*// BEGIN flutter-play-store-release schema=1[[:space:]]*$' "$gradle_file" || true)
      marker_end=$(grep -c '^[[:space:]]*// END flutter-play-store-release[[:space:]]*$' "$gradle_file" || true)
      marker_any_begin=$(grep -c 'BEGIN flutter-play-store-release' "$gradle_file" || true)
      marker_any_end=$(grep -c 'END flutter-play-store-release' "$gradle_file" || true)
      if [ "$marker_any_begin" -eq 0 ] && [ "$marker_any_end" -eq 0 ]; then
        : # A statically validated user-owned signing structure needs no package marker.
      elif [ "$marker_begin" -ne 1 ] || [ "$marker_end" -ne 1 ] || \
        [ "$marker_any_begin" -ne 1 ] || [ "$marker_any_end" -ne 1 ]; then
        marker_failure='Gradle signing ownership markers are missing or malformed'
      elif ! awk '/^[[:space:]]*\/\/ BEGIN flutter-play-store-release schema=1[[:space:]]*$/ { begin=NR } /^[[:space:]]*\/\/ END flutter-play-store-release[[:space:]]*$/ { end=NR } END { exit(begin > 0 && end > begin ? 0 : 1) }' "$gradle_file"; then
        marker_failure='Gradle signing ownership markers are reversed'
      fi
    fi
    for marker_file in android/Gemfile android/fastlane/Fastfile android/fastlane/Pluginfile
    do
      [ -f "$project_root/$marker_file" ] || continue
      marker_any_begin=$(grep -c 'BEGIN flutter-play-store-release' "$project_root/$marker_file" || true)
      marker_any_end=$(grep -c 'END flutter-play-store-release' "$project_root/$marker_file" || true)
      if [ "$marker_any_begin" -ne 0 ] || [ "$marker_any_end" -ne 0 ]; then
        marker_exact_begin=$(grep -c '^# BEGIN flutter-play-store-release schema=1$' "$project_root/$marker_file" || true)
        marker_exact_end=$(grep -c '^# END flutter-play-store-release$' "$project_root/$marker_file" || true)
        if [ "$marker_any_begin" -ne 1 ] || [ "$marker_any_end" -ne 1 ] || \
          [ "$marker_exact_begin" -ne 1 ] || [ "$marker_exact_end" -ne 1 ] || \
          ! awk '/^# BEGIN flutter-play-store-release schema=1$/ { begin=NR } /^# END flutter-play-store-release$/ { end=NR } END { exit(begin > 0 && end > begin ? 0 : 1) }' "$project_root/$marker_file"
        then
          marker_failure="Ownership markers are malformed: $marker_file"
          break
        fi
      fi
    done
    if [ -n "$marker_failure" ]; then
      fprs_validator_add FAIL ownership.markers "$marker_failure"
    else
      fprs_validator_add PASS ownership.markers 'Generated and mergeable ownership markers are intact'
    fi

    if [ "$release_debug" = true ]; then
      fprs_validator_add FAIL signing.gradle 'Release build still uses debug signing'
    elif [ "$release_signing" = true ]; then
      fprs_validator_add PASS signing.gradle 'Android release signing structure is configured'
    else
      fprs_validator_add FAIL signing.gradle 'Android release signing structure is missing or unresolved'
    fi

    ignore_file="$project_root/.gitignore"
    ignore_missing=
    if fprs_validator_file_safe "$ignore_file"; then
      while IFS= read -r ignore_required
      do
        grep -Fx -- "$ignore_required" "$ignore_file" >/dev/null 2>&1 || { ignore_missing=$ignore_required; break; }
      done <<'IGNORES'
android/fastlane/.env
android/key.properties
android/*.jks
android/*.keystore
google-play-service-account.json
**/google-play-service-account.json
fastlane/report.xml
fastlane/Preview.html
fastlane/screenshots/
fastlane/test_output/
IGNORES
    else
      ignore_missing='.gitignore'
    fi
    if [ -n "$ignore_missing" ]; then
      fprs_validator_add FAIL gitignore.required "Required ignore rule is missing: $ignore_missing"
    elif grep -E '(^|/)(\.env\.example|key\.properties\.example)$|\*\.example' "$ignore_file" >/dev/null 2>&1; then
      fprs_validator_add FAIL gitignore.required 'Example configuration files must remain committable'
    else
      fprs_validator_add PASS gitignore.required 'Secret paths are ignored and examples remain committable'
    fi

    active_files="$validator_tmp/active-files"
    : > "$active_files"
    for active_relative in \
      .github/workflows/release-android.yml \
      android/Gemfile \
      android/fastlane/Appfile \
      android/fastlane/Fastfile \
      android/fastlane/Pluginfile \
      android/fastlane/lib/flutter_play_store_release.rb
    do
      [ -f "$project_root/$active_relative" ] && printf '%s\n' "$project_root/$active_relative" >> "$active_files"
    done
    [ -n "$gradle_file" ] && printf '%s\n' "$gradle_file" >> "$active_files"
    placeholder_file=
    secret_file=
    while IFS= read -r active_file
    do
      if [ -z "$placeholder_file" ] && fprs_validator_active_text "$active_file" | grep -E 'CHANGE_ME_APPLICATION_ID|CHANGE_ME|REPLACE_ME|YOUR_[A-Z0-9_]+' >/dev/null 2>&1; then
        placeholder_file=${active_file#$project_root/}
      fi
      if [ -z "$secret_file" ] && fprs_validator_active_text "$active_file" | grep -E -- '-----BEGIN ([A-Z0-9]+ )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]+|hooks\.slack\.com/services/[0-9A-Za-z/]+' >/dev/null 2>&1; then
        secret_file=${active_file#$project_root/}
      fi
    done < "$active_files"
    if [ -n "$placeholder_file" ]; then
      fprs_validator_add FAIL placeholders.active "Unsafe placeholder remains in active configuration: $placeholder_file"
    else
      fprs_validator_add PASS placeholders.active 'No unsafe placeholder remains in active configuration'
    fi
    if [ -n "$secret_file" ]; then
      fprs_validator_add FAIL secrets.content "Credential-shaped content appears in active configuration: $secret_file"
    else
      fprs_validator_add PASS secrets.content 'No credential-shaped literal appears in active configuration'
    fi

    if command -v git >/dev/null 2>&1; then
      if GIT_OPTIONAL_LOCKS=0 git -C "$project_root" ls-files >"$validator_tmp/tracked" 2>/dev/null; then
        tracked_secret=$(grep -E '(^|/)(\.env|key\.properties|[^/]*(\.jks|\.keystore|\.p12|\.pem|\.key)|google-play-service-account\.json|firebase-service-account\.json)$' "$validator_tmp/tracked" | grep -Ev '\.example$' | sed -n '1p')
        if [ -n "$tracked_secret" ]; then
          fprs_validator_add FAIL secrets.tracked_names "Tracked secret-shaped filename detected: $tracked_secret"
        else
          fprs_validator_add PASS secrets.tracked_names 'No tracked secret-shaped filename was detected'
        fi
      else
        fprs_validator_add WARN secrets.tracked_names 'Git tracked-file inspection was unavailable' 'git ls-files'
      fi
    else
      fprs_validator_add WARN secrets.tracked_names 'Git is unavailable; tracked secret filenames were not checked' 'git ls-files'
    fi

    workflow="$project_root/.github/workflows/release-android.yml"
    if fprs_validator_file_safe "$workflow" && grep -E '^name:[[:space:]]+' "$workflow" >/dev/null 2>&1 && \
      grep -E '^on:' "$workflow" >/dev/null 2>&1 && grep -E '^jobs:' "$workflow" >/dev/null 2>&1; then
      fprs_validator_add PASS yaml.structure 'Workflow passes the safe structural fallback check'
    else
      fprs_validator_add FAIL yaml.structure 'Workflow is missing required top-level YAML structure'
    fi
    if [ "$ruby_available" = true ] && ruby -e 'require "yaml"' >/dev/null 2>&1; then
      if ruby -e 'require "yaml"; YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)' "$workflow" >/dev/null 2>&1; then
        fprs_validator_add PASS yaml.parser 'Workflow parses with the available YAML parser'
      else
        fprs_validator_add FAIL yaml.parser 'Workflow YAML parser rejected the generated workflow'
      fi
    else
      fprs_validator_add WARN yaml.parser 'A YAML parser is unavailable; only the safe structural fallback ran' 'ruby -ryaml -e '\''YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)'\'' .github/workflows/release-android.yml'
    fi

    if [ "$ruby_available" = true ]; then
      ruby_failure=
      for ruby_file in \
        "$project_root/android/Gemfile" \
        "$project_root/android/fastlane/Appfile" \
        "$project_root/android/fastlane/Fastfile" \
        "$project_root/android/fastlane/Pluginfile" \
        "$project_root/android/fastlane/lib/flutter_play_store_release.rb"
      do
        if ! ruby -c "$ruby_file" >/dev/null 2>&1; then
          ruby_failure=${ruby_file#$project_root/}
          break
        fi
      done
      if [ -n "$ruby_failure" ]; then
        fprs_validator_add FAIL ruby.syntax "Ruby syntax is invalid: $ruby_failure"
      else
        fprs_validator_add PASS ruby.syntax 'Generated Ruby and Fastlane files pass syntax validation'
      fi
    else
      fprs_validator_add WARN ruby.syntax 'Ruby is unavailable; generated Ruby syntax was not checked' 'ruby -c android/fastlane/Fastfile'
    fi

    if grep -F 'gem "fastlane", "= 2.237.0"' "$project_root/android/Gemfile" >/dev/null 2>&1 && \
      grep -F 'gem "fastlane-plugin-firebase_app_distribution", "= 1.0.0"' "$project_root/android/fastlane/Pluginfile" >/dev/null 2>&1 && \
      grep -F 'fastlane (2.237.0)' "$project_root/android/Gemfile.lock" >/dev/null 2>&1 && \
      grep -F 'fastlane-plugin-firebase_app_distribution (1.0.0)' "$project_root/android/Gemfile.lock" >/dev/null 2>&1; then
      fprs_validator_add PASS plugin 'Pinned Fastlane and Firebase plugin dependencies match'
    else
      fprs_validator_add FAIL plugin 'Pinned Fastlane or Firebase plugin dependency is missing or mismatched'
    fi

    if grep -E '^[[:space:]]+build_runner[[:space:]]*:' "$project_root/pubspec.yaml" >/dev/null 2>&1; then
      fprs_validator_add PASS build_runner 'build_runner is configured'
    else
      fprs_validator_add PASS build_runner 'build_runner is not configured and will be skipped'
    fi

    configured_package=${APP_PACKAGE_NAME-}
    if [ -z "$configured_package" ]; then
      if [ "$inspection_ok" = true ] && [ -n "$application_id" ] && [ "$application_id" != null ]; then
        package_command="export APP_PACKAGE_NAME=$application_id"
      else
        package_command='export APP_PACKAGE_NAME=REPLACE_WITH_RESOLVED_APPLICATION_ID'
      fi
      fprs_validator_add "$(fprs_validator_context_level)" package_name \
        'APP_PACKAGE_NAME is not configured' "$package_command"
    elif [ "$inspection_ok" != true ] || [ -z "$application_id" ] || [ "$application_id" = null ]; then
      fprs_validator_add "$(fprs_validator_context_level)" package_name 'Release application ID could not be resolved for comparison' './scripts/inspect_flutter_project.sh --project PATH --format human'
    elif [ "$configured_package" != "$application_id" ]; then
      fprs_validator_add FAIL package_name 'APP_PACKAGE_NAME does not match the resolved release application ID'
    else
      fprs_validator_add PASS package_name 'APP_PACKAGE_NAME matches the resolved release application ID'
    fi

    track=${PLAY_STORE_TRACK:-internal}
    case "$track" in
      ''|*[!A-Za-z0-9._-]*) fprs_validator_add "$(fprs_validator_context_level)" track 'Play track contains unsupported characters' 'export PLAY_STORE_TRACK=internal' ;;
      *) fprs_validator_add PASS track 'Play track is configured' ;;
    esac

    workspace_properties="$project_root/android/key.properties"
    workspace_properties_example="$project_root/android/key.properties.example"
    signing_placeholder_pattern='replace-locally|/absolute/path/to/upload\.jks'
    printf -v signing_create_command \
      'test ! -e %q && test ! -L %q && install -m 600 %q %q && "${EDITOR:-vi}" %q && ! grep -Eq %q %q' \
      "$workspace_properties" "$workspace_properties" \
      "$workspace_properties_example" "$workspace_properties" \
      "$workspace_properties" "$signing_placeholder_pattern" "$workspace_properties"
    printf -v signing_edit_command \
      'test -f %q && test ! -L %q && chmod 600 %q && "${EDITOR:-vi}" %q && ! grep -Eq %q %q' \
      "$workspace_properties" "$workspace_properties" "$workspace_properties" \
      "$workspace_properties" "$signing_placeholder_pattern" "$workspace_properties"
    signing_ci=false
    if fprs_is_truthy "${CI-}" || fprs_is_truthy "${GITHUB_ACTIONS-}"; then
      signing_ci=true
    fi
    signing_level=
    signing_message=
    signing_command=-
    if [ "$signing_ci" = true ] && { [ -e "$workspace_properties" ] || [ -L "$workspace_properties" ]; }; then
      signing_level=FAIL
      signing_message='CI refuses workspace android/key.properties; use a private temporary override or complete raw inputs'
      signing_command='rm android/key.properties'
    elif [ -n "${ANDROID_KEY_PROPERTIES_PATH-}" ]; then
      if fprs_validator_check_properties "$ANDROID_KEY_PROPERTIES_PATH" override; then
        signing_level=PASS
        signing_message='Private Android key-properties override is complete and valid'
      else
        signing_level=FAIL
        signing_message="Explicit Android key-properties override is invalid: $properties_error"
        signing_command='chmod 600 "$ANDROID_KEY_PROPERTIES_PATH"'
      fi
    else
      signing_any_raw=false
      if [ -n "${ANDROID_KEYSTORE_PATH-}" ] || [ -n "${ANDROID_KEYSTORE_BASE64-}" ] || \
        [ -n "${ANDROID_KEYSTORE_PASSWORD-}" ] || [ -n "${ANDROID_KEY_ALIAS-}" ] || \
        [ -n "${ANDROID_KEY_PASSWORD-}" ]; then
        signing_any_raw=true
      fi
      if [ "$signing_any_raw" = true ]; then
        if { [ -n "${ANDROID_KEYSTORE_PATH-}" ] || [ -n "${ANDROID_KEYSTORE_BASE64-}" ]; } && \
          [ -n "${ANDROID_KEYSTORE_PASSWORD-}" ] && [ -n "${ANDROID_KEY_ALIAS-}" ] && \
          [ -n "${ANDROID_KEY_PASSWORD-}" ] && \
          { [ -z "${ANDROID_KEYSTORE_PATH-}" ] || \
            { fprs_validator_file_safe "$ANDROID_KEYSTORE_PATH" && [ -s "$ANDROID_KEYSTORE_PATH" ]; }; }
        then
          signing_level=PASS
          signing_message='Complete raw Android signing inputs are available'
        else
          signing_level=FAIL
          signing_message='Explicit raw Android signing inputs are incomplete or the keystore path is invalid'
          signing_command='export ANDROID_KEYSTORE_PATH=/absolute/path/upload.jks'
        fi
      elif [ "$signing_ci" = false ] && { [ -e "$workspace_properties" ] || [ -L "$workspace_properties" ]; }; then
        if fprs_validator_check_properties "$workspace_properties" local; then
          signing_level=PASS
          signing_message='Local android/key.properties is complete and its keystore exists'
        else
          signing_level=$(fprs_validator_context_level)
          signing_message="Local android/key.properties is incomplete or invalid: $properties_error; preserve it, enforce mode 0600, and edit its values before retrying"
          signing_command=$signing_edit_command
        fi
      else
        signing_level=$(fprs_validator_context_level)
        signing_message='Android release signing input is incomplete; create mode-0600 android/key.properties and replace every placeholder before retrying'
        signing_command=$signing_create_command
      fi
    fi
    fprs_validator_add "$signing_level" signing "$signing_message" "$signing_command"

    target=${DISTRIBUTION_TARGET:-play-store}
    case "$target" in
      play-store|firebase|both) fprs_validator_add PASS distribution.target 'Distribution target is supported' ;;
      *) fprs_validator_add FAIL distribution.target 'DISTRIBUTION_TARGET must be play-store, firebase, or both' ;;
    esac
    case "$target" in
      play-store|both)
        if [ -n "${GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH-}" ] || \
          [ -n "${GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64-}" ] || \
          fprs_validator_file_safe "$project_root/android/fastlane/google-play-service-account.json"; then
          fprs_validator_add PASS credentials.play 'Google Play credentials are configured by presence'
        else
          fprs_validator_add "$(fprs_validator_context_level)" credentials.play 'Google Play credentials are not configured' 'export GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH=/absolute/path/service-account.json'
        fi
        ;;
      *) fprs_validator_add PASS credentials.play 'Google Play credentials are not required for this target' ;;
    esac
    case "$target" in
      firebase|both)
        if [ -n "${FIREBASE_APP_ID-}" ] && { [ -n "${FIREBASE_SERVICE_ACCOUNT_JSON_PATH-}" ] || \
          [ -n "${FIREBASE_SERVICE_ACCOUNT_JSON_BASE64-}" ] || \
          fprs_validator_file_safe "$project_root/android/fastlane/firebase-service-account.json"; }; then
          fprs_validator_add PASS credentials.firebase 'Firebase credentials are configured by presence'
        else
          fprs_validator_add "$(fprs_validator_context_level)" credentials.firebase 'Firebase credentials or FIREBASE_APP_ID are not configured' 'export FIREBASE_APP_ID=1:PROJECT:android:APP'
        fi
        ;;
      *) fprs_validator_add PASS credentials.firebase 'Firebase credentials are not required for this target' ;;
    esac

    if [ "$run_project_commands" = true ]; then
      command_failure=
      if ! (CDPATH= cd -- "$project_root" && flutter pub get) >"$validator_tmp/project-command.stdout" 2>"$validator_tmp/project-command.stderr"; then
        command_failure='flutter pub get'
      elif ! (CDPATH= cd -- "$project_root" && flutter analyze) >"$validator_tmp/project-command.stdout" 2>"$validator_tmp/project-command.stderr"; then
        command_failure='flutter analyze'
      elif ! (CDPATH= cd -- "$project_root/android" && bundle check) >"$validator_tmp/project-command.stdout" 2>"$validator_tmp/project-command.stderr"; then
        command_failure='cd android && bundle check'
      elif ! (CDPATH= cd -- "$project_root/android" && bundle exec fastlane lanes) >"$validator_tmp/project-command.stdout" 2>"$validator_tmp/project-command.stderr"; then
        command_failure='cd android && bundle exec fastlane lanes'
      elif ! (CDPATH= cd -- "$project_root/android" && bundle exec fastlane android doctor) >"$validator_tmp/project-command.stdout" 2>"$validator_tmp/project-command.stderr"; then
        command_failure='cd android && bundle exec fastlane android doctor'
      elif [ "$context" = build ] && ! (CDPATH= cd -- "$project_root" && flutter build appbundle --release) >"$validator_tmp/project-command.stdout" 2>"$validator_tmp/project-command.stderr"; then
        command_failure='flutter build appbundle --release'
      fi
      if [ -n "$command_failure" ]; then
        fprs_validator_add FAIL project.commands "Authorized project command failed: $command_failure" "$command_failure"
      else
        fprs_validator_add PASS project.commands 'Authorized setup/build project command matrix completed without upload'
      fi
    else
      printf -v project_commands_command \
        '%q --project %q --context setup --run-project-commands' \
        "$SCRIPT_DIR/validate_release_setup.sh" "$project_root"
      fprs_validator_add WARN project.commands \
        'Project-mutating validation commands were not run; explicitly opt in from setup/build context' \
        "$project_commands_command"
    fi
  fi
fi

sorted_checks="$validator_tmp/checks.sorted.tsv"
LC_ALL=C sort -t "$(printf '\t')" -k2,2 "$checks" > "$sorted_checks"
pass_count=$(awk -F '\t' '$1 == "PASS" { count++ } END { print count + 0 }' "$sorted_checks")
warn_count=$(awk -F '\t' '$1 == "WARN" { count++ } END { print count + 0 }' "$sorted_checks")
fail_count=$(awk -F '\t' '$1 == "FAIL" { count++ } END { print count + 0 }' "$sorted_checks")

if [ "$output_format" = human ]; then
  while IFS="$(printf '\t')" read -r check_level check_name check_message check_command
  do
    if [ "$check_command" = - ] || [ -z "$check_command" ]; then
      printf '%s %s: %s\n' "$check_level" "$check_name" "$check_message"
    else
      printf '%s %s: %s | command: %s\n' "$check_level" "$check_name" \
        "$check_message" "$check_command"
    fi
  done < "$sorted_checks"
else
  printf '{"schema_version":1,"context":"%s","project_root":' \
    "$(fprs_json_escape "$context")"
  if [ -n "$project_root" ]; then
    printf '"%s"' "$(fprs_json_escape "$project_root")"
  else
    printf 'null'
  fi
  printf ',"summary":{"pass":%s,"warn":%s,"fail":%s},"checks":[' \
    "$pass_count" "$warn_count" "$fail_count"
  json_separator=
  while IFS="$(printf '\t')" read -r check_level check_name check_message check_command
  do
    printf '%s{"level":"%s","name":"%s","message":"%s"' \
      "$json_separator" "$(fprs_json_escape "$check_level")" \
      "$(fprs_json_escape "$check_name")" "$(fprs_json_escape "$check_message")"
    if [ "$check_command" != - ] && [ -n "$check_command" ]; then
      printf ',"command":"%s"' "$(fprs_json_escape "$check_command")"
    fi
    printf '}'
    json_separator=,
  done < "$sorted_checks"
  printf ']}\n'
fi

[ "$fail_count" -eq 0 ] || exit 1
exit 0
