#!/usr/bin/env bash
# Bootstrap package-owned Android Fastlane and GitHub Actions configuration safely.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || exit 1
PACKAGE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd -P) || exit 1
COMMON="$SCRIPT_DIR/lib/common.sh"
TRANSACTION_LIBRARY="$SCRIPT_DIR/lib/project_transaction.sh"
GRADLE_LIBRARY="$SCRIPT_DIR/lib/gradle_signing.sh"
INSPECTOR="$SCRIPT_DIR/inspect_flutter_project.sh"
for bootstrap_library in "$COMMON" "$TRANSACTION_LIBRARY" "$GRADLE_LIBRARY"
do
  [ -r "$bootstrap_library" ] || {
    printf 'ERROR: bootstrap helper is unavailable: %s\n' "${bootstrap_library##*/}" >&2
    exit 1
  }
done
. "$COMMON"
. "$TRANSACTION_LIBRARY"
. "$GRADLE_LIBRARY"

fprs_bootstrap_usage() {
  printf 'Usage: %s --project PATH [--flavor NAME] [--dry-run] [--conflict fail|skip]\n' \
    "${0##*/}" >&2
}

fprs_bootstrap_bad_argument() {
  printf 'ERROR: %s\n' "$1" >&2
  fprs_bootstrap_usage
  exit 2
}

fprs_bootstrap_cleanup() {
  case "${bootstrap_stage-}" in
    */.fprs-bootstrap.*)
      [ ! -L "$bootstrap_stage" ] || return 0
      rm -rf -- "$bootstrap_stage" 2>/dev/null || true
      ;;
  esac
}

fprs_bootstrap_copy() {
  local bootstrap_copy_mode
  cp "$1" "$2" 2>/dev/null || return 1
  bootstrap_copy_mode=$(fprs_file_mode "$1") || return 1
  chmod "$bootstrap_copy_mode" "$2" 2>/dev/null
}

fprs_bootstrap_source_for() {
  case "$1" in
    android/Gemfile) printf '%s/templates/Gemfile\n' "$PACKAGE_ROOT" ;;
    android/Gemfile.lock) printf '%s/templates/Gemfile.lock\n' "$PACKAGE_ROOT" ;;
    android/fastlane/Appfile) printf '%s/templates/Appfile\n' "$PACKAGE_ROOT" ;;
    android/fastlane/Fastfile) printf '%s/templates/Fastfile\n' "$PACKAGE_ROOT" ;;
    android/fastlane/Pluginfile) printf '%s/templates/Pluginfile\n' "$PACKAGE_ROOT" ;;
    android/fastlane/lib/flutter_play_store_release.rb)
      printf '%s/templates/FlutterPlayStoreRelease.rb\n' "$PACKAGE_ROOT" ;;
    android/fastlane/.env.example) printf '%s/templates/env.example\n' "$PACKAGE_ROOT" ;;
    android/key.properties.example) printf '%s/templates/key.properties.example\n' "$PACKAGE_ROOT" ;;
    .github/workflows/release-android.yml)
      printf '%s/templates/release-android.yml\n' "$PACKAGE_ROOT" ;;
    docs/PLAY_STORE_RELEASE.md)
      printf '%s/templates/PLAY_STORE_RELEASE.md\n' "$PACKAGE_ROOT" ;;
    tool/flutter-play-store-release/decode_secret.sh)
      printf '%s/scripts/decode_secret.sh\n' "$PACKAGE_ROOT" ;;
    tool/flutter-play-store-release/install_flutter_sdk.sh)
      printf '%s/scripts/install_flutter_sdk.sh\n' "$PACKAGE_ROOT" ;;
    *) return 1 ;;
  esac
}

fprs_bootstrap_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | awk '{ print $1 }'
  else
    return 1
  fi
}

fprs_bootstrap_sidecar_record() {
  [ -f "$bootstrap_sidecar_records" ] || return 1
  awk -v path="$1" '$2 == path { print $1; found = 1 } END { exit(found ? 0 : 1) }' \
    "$bootstrap_sidecar_records"
}

fprs_bootstrap_validate_sidecar() {
  local bootstrap_sidecar bootstrap_previous_path bootstrap_hash bootstrap_path
  local bootstrap_extra bootstrap_actual
  bootstrap_sidecar=$1
  [ -f "$bootstrap_sidecar" ] && [ ! -L "$bootstrap_sidecar" ] || return 2
  [ "$(sed -n '1p' "$bootstrap_sidecar")" = 'package_id=flutter-play-store-release' ] || return 2
  [ "$(sed -n '2p' "$bootstrap_sidecar")" = 'schema_version=1' ] || return 2
  sed -n '3,$p' "$bootstrap_sidecar" > "$bootstrap_sidecar_records" || return 1
  bootstrap_previous_path=
  while IFS=' ' read -r bootstrap_hash bootstrap_path bootstrap_extra
  do
    [ -n "$bootstrap_hash" ] && [ -n "$bootstrap_path" ] &&
      [ -z "$bootstrap_extra" ] || return 2
    case "$bootstrap_hash" in
      *[!0-9a-f]*|'') return 2 ;;
    esac
    [ "${#bootstrap_hash}" -eq 64 ] || return 2
    case "$bootstrap_path" in
      android/Gemfile|android/Gemfile.lock|android/fastlane/Appfile|\
      android/fastlane/Fastfile|android/fastlane/Pluginfile|\
      android/fastlane/lib/flutter_play_store_release.rb|\
      android/fastlane/.env.example|android/key.properties.example|\
      .github/workflows/release-android.yml|docs/PLAY_STORE_RELEASE.md|\
      tool/flutter-play-store-release/decode_secret.sh|\
      tool/flutter-play-store-release/install_flutter_sdk.sh) ;;
      *) return 2 ;;
    esac
    if [ -n "$bootstrap_previous_path" ]; then
      [ "$bootstrap_previous_path" != "$bootstrap_path" ] || return 2
      [ "$(printf '%s\n%s\n' "$bootstrap_previous_path" "$bootstrap_path" |
        LC_ALL=C sort | sed -n '1p')" = "$bootstrap_previous_path" ] || return 2
    fi
    bootstrap_previous_path=$bootstrap_path
    [ -f "$project_root/$bootstrap_path" ] &&
      [ ! -L "$project_root/$bootstrap_path" ] || return 2
    bootstrap_actual=$(fprs_bootstrap_sha256 "$project_root/$bootstrap_path") || return 1
    [ "$bootstrap_actual" = "$bootstrap_hash" ] || return 2
  done < "$bootstrap_sidecar_records"
}

fprs_bootstrap_gitignore() {
  local bootstrap_ignore_mode
  if [ -f "$1" ] && [ ! -L "$1" ]; then
    bootstrap_ignore_mode=$(fprs_file_mode "$1") || return 1
  else
    bootstrap_ignore_mode=644
  fi
  python3 - "$1" "$2" <<'PY' || return 1
import os
import sys

source, destination = sys.argv[1:]
data = b""
if os.path.isfile(source) and not os.path.islink(source):
    with open(source, "rb") as handle:
        data = handle.read()
if b"\r\n" in data and b"\n" in data.replace(b"\r\n", b""):
    raise SystemExit(1)
newline = b"\r\n" if b"\r\n" in data else b"\n"
lines = data.replace(b"\r\n", b"\n").splitlines()
required = [
    b"android/fastlane/.env", b"android/key.properties", b"android/*.jks",
    b"android/*.keystore", b"google-play-service-account.json",
    b"**/google-play-service-account.json", b"fastlane/report.xml",
    b"fastlane/Preview.html", b"fastlane/screenshots/", b"fastlane/test_output/",
]
for line in required:
    if line not in lines:
        lines.append(line)
output = newline.join(lines)
if lines:
    output += newline
with open(destination, "wb") as handle:
    handle.write(output)
PY
  chmod "$bootstrap_ignore_mode" "$2" 2>/dev/null
}

fprs_bootstrap_safe_merge() {
  local bootstrap_kind bootstrap_target bootstrap_template bootstrap_output
  local bootstrap_merge_mode
  bootstrap_kind=$1
  bootstrap_target=$2
  bootstrap_template=$3
  bootstrap_output=$4
  command -v ruby >/dev/null 2>&1 || return 2
  ruby -c "$bootstrap_target" >/dev/null 2>&1 || return 2
  python3 - "$bootstrap_kind" "$bootstrap_target" "$bootstrap_template" \
    "$bootstrap_output" <<'PY'
import re
import sys

kind, target, template, output = sys.argv[1:]
try:
    raw = open(target, "rb").read()
    template_raw = open(template, "rb").read()
    if b"\r\n" in raw and b"\n" in raw.replace(b"\r\n", b""):
        raise ValueError("mixed line endings")
    newline = "\r\n" if b"\r\n" in raw else "\n"
    text = raw.decode("utf-8")
    template_text = template_raw.decode("utf-8")
except (OSError, UnicodeError, ValueError):
    raise SystemExit(2)

lines = text.replace("\r\n", "\n").splitlines()
begin = "# BEGIN flutter-play-store-release schema=1"
end = "# END flutter-play-store-release"
begin_indexes = [i for i, line in enumerate(lines) if line == begin]
end_indexes = [i for i, line in enumerate(lines) if line == end]
if any(("BEGIN flutter-play-store-release" in line and line != begin) or
       ("END flutter-play-store-release" in line and line != end) for line in lines):
    raise SystemExit(2)
if not begin_indexes and not end_indexes:
    marker = None
    base = list(lines)
    owned = []
elif (len(begin_indexes) == 1 and len(end_indexes) == 1 and
      begin_indexes[0] < end_indexes[0]):
    marker = (begin_indexes[0], end_indexes[0])
    owned = lines[marker[0] + 1:marker[1]]
    base = lines[:marker[0]] + lines[marker[1] + 1:]
else:
    raise SystemExit(2)

base_text = "\n".join(base)
desired = []
if kind == "Fastfile":
    required = ("doctor", "prepare", "build", "release",
                "release_play_store", "firebase_distribution")
    for lane in required:
        pattern = r"(?m)^\s*lane\s*(?:\(\s*)?:%s(?:\s*\))?(?:\s+do|\s*\{)" % re.escape(lane)
        if re.search(pattern, base_text):
            raise SystemExit(2)
    desired = template_text.replace("\r\n", "\n").splitlines()
elif kind == "Pluginfile":
    declarations = [line for line in base if re.search(
        r"^\s*gem\s*(?:\(\s*)?['\"]fastlane-plugin-firebase_app_distribution['\"]", line)]
    exact = re.compile(
        r"^\s*gem\s*(?:\(\s*)?['\"]fastlane-plugin-firebase_app_distribution['\"]\s*,\s*['\"]= 1\.0\.0['\"]\s*\)?\s*(?:#.*)?$")
    if len(declarations) > 1 or (declarations and not exact.match(declarations[0])):
        raise SystemExit(2)
    if not declarations:
        desired = template_text.replace("\r\n", "\n").splitlines()
elif kind == "Gemfile":
    sources = [line for line in base if re.match(r"^\s*source\b", line)]
    source_ok = re.compile(r"^\s*source\s*(?:\(\s*)?['\"]https://rubygems\.org['\"]\s*\)?\s*(?:#.*)?$")
    if len(sources) > 1 or (sources and not source_ok.match(sources[0])):
        raise SystemExit(2)
    gems = [line for line in base if re.search(
        r"^\s*gem\s*(?:\(\s*)?['\"]fastlane['\"]", line)]
    gem_ok = re.compile(
        r"^\s*gem\s*(?:\(\s*)?['\"]fastlane['\"]\s*,\s*['\"]= 2\.237\.0['\"]\s*\)?\s*(?:#.*)?$")
    if len(gems) > 1 or (gems and not gem_ok.match(gems[0])):
        raise SystemExit(2)
    eval_indexes = [index for index, line in enumerate(base)
                    if re.search(r"\beval_gemfile\b", line)]
    eval_lines = [base[index] for index in eval_indexes]
    compatible_eval = False
    if len(eval_lines) == 1:
        line = eval_lines[0]
        direct = re.fullmatch(
            r"\s*eval_gemfile\((.+)\)\s+if\s+File\.exist\?\((.+)\)\s*",
            line)
        if direct and direct.group(1) == direct.group(2):
            expression = direct.group(1)
            compatible_eval = bool(
                re.fullmatch(r"['\"]fastlane/Pluginfile['\"]", expression) or
                re.fullmatch(
                    r"File\.join\(__dir__,\s*['\"]fastlane['\"],\s*['\"]Pluginfile['\"]\)",
                    expression))
        variable = re.fullmatch(
            r"\s*eval_gemfile\(plugins_path\)\s+if\s+File\.exist\?\(plugins_path\)\s*",
            line)
        assignments = [index for index, candidate in enumerate(base)
                       if re.match(r"^\s*plugins_path\s*=", candidate)]
        exact_assignment = re.fullmatch(
            r"\s*plugins_path\s*=\s*File\.join\(__dir__,\s*['\"]fastlane['\"],\s*['\"]Pluginfile['\"]\)\s*",
            base[assignments[0]]) if len(assignments) == 1 else None
        plugin_path_uses = sum(
            len(re.findall(r"\bplugins_path\b", candidate)) for candidate in base)
        if (variable and exact_assignment and assignments[0] + 1 == eval_indexes[0]
                and plugin_path_uses == 3):
            compatible_eval = True
    if len(eval_lines) > 1 or (eval_lines and not compatible_eval):
        raise SystemExit(2)
    if not gems:
        desired.append('gem "fastlane", "= 2.237.0"')
    if not eval_lines:
        desired.append('eval_gemfile(File.join(__dir__, "fastlane", "Pluginfile")) if File.exist?(File.join(__dir__, "fastlane", "Pluginfile"))')
else:
    raise SystemExit(2)

if marker is not None and owned != desired:
    raise SystemExit(2)
if marker is None and not desired:
    result = lines
else:
    result = list(base)
    while result and result[-1] == "":
        result.pop()
    if result:
        result.append("")
    result.extend([begin] + desired + [end])
result_bytes = newline.join(result).encode("utf-8")
if result:
    result_bytes += newline.encode("ascii")
with open(output, "wb") as handle:
    handle.write(result_bytes)
PY
  case $? in 0) ;; 2) return 2 ;; *) return 1 ;; esac
  ruby -c "$bootstrap_output" >/dev/null 2>&1 || return 2
  bootstrap_merge_mode=$(fprs_file_mode "$bootstrap_target") || return 1
  chmod "$bootstrap_merge_mode" "$bootstrap_output" 2>/dev/null
}

fprs_bootstrap_dependency_scan() {
  python3 - "$1" "$2" <<'PY'
import re
import sys

kind, path = sys.argv[1:]
expected = {
    "Gemfile": "fastlane",
    "Pluginfile": "fastlane-plugin-firebase_app_distribution",
}.get(kind)
if expected is None:
    raise SystemExit(2)
extra = False
pattern = re.compile(
    r"^\s*gem\s*(?:\(\s*)?['\"]([A-Za-z0-9_.-]+)['\"]"
    r"(?:\s*,\s*['\"]([^'\"]+)['\"])?\s*\)?\s*(?:#.*)?$")
try:
    lines = open(path, "r", encoding="utf-8").read().splitlines()
except (OSError, UnicodeError):
    raise SystemExit(2)
for line in lines:
    if not re.match(r"^\s*gem\b", line):
        continue
    match = pattern.fullmatch(line)
    if match is None:
        raise SystemExit(2)
    if match.group(1) != expected:
        extra = True
raise SystemExit(0 if extra else 1)
PY
}

fprs_bootstrap_regenerate_lock() {
  local bootstrap_lock_output bootstrap_dependency_root bootstrap_bundle_home
  local bootstrap_gemfile_candidate bootstrap_pluginfile_candidate bootstrap_lock_mode
  bootstrap_lock_output=$1
  bootstrap_dependency_root="$bootstrap_stage/dependency-tree"
  bootstrap_bundle_home="$bootstrap_stage/bundle-home"
  bootstrap_gemfile_candidate=$(awk -F '|' \
    '$1 == "android/Gemfile" { print $3; found = 1 } END { exit(found ? 0 : 1) }' \
    "$bootstrap_stage/plan.unsorted") || return 2
  bootstrap_pluginfile_candidate=$(awk -F '|' \
    '$1 == "android/fastlane/Pluginfile" { print $3; found = 1 } END { exit(found ? 0 : 1) }' \
    "$bootstrap_stage/plan.unsorted") || return 2
  [ -f "$bootstrap_gemfile_candidate" ] && [ ! -L "$bootstrap_gemfile_candidate" ] &&
    [ -f "$bootstrap_pluginfile_candidate" ] && [ ! -L "$bootstrap_pluginfile_candidate" ] ||
    return 2
  mkdir -p "$bootstrap_dependency_root/android/fastlane" "$bootstrap_bundle_home" || return 1
  chmod 700 "$bootstrap_dependency_root" "$bootstrap_bundle_home" 2>/dev/null || return 1
  cp "$bootstrap_gemfile_candidate" "$bootstrap_dependency_root/android/Gemfile" || return 1
  cp "$bootstrap_pluginfile_candidate" \
    "$bootstrap_dependency_root/android/fastlane/Pluginfile" || return 1
  command -v bundle >/dev/null 2>&1 || return 2
  (
    CDPATH= cd -- "$bootstrap_dependency_root/android" 2>/dev/null || exit 1
    BUNDLE_GEMFILE="$bootstrap_dependency_root/android/Gemfile" \
      BUNDLE_USER_HOME="$bootstrap_bundle_home" \
      BUNDLE_APP_CONFIG="$bootstrap_bundle_home/config" \
      BUNDLE_DISABLE_VERSION_CHECK=true \
      bundle _4.0.16_ lock --local
  ) > "$bootstrap_stage/bundle-lock.stdout" 2> "$bootstrap_stage/bundle-lock.stderr" || return 2
  [ -f "$bootstrap_dependency_root/android/Gemfile.lock" ] &&
    [ ! -L "$bootstrap_dependency_root/android/Gemfile.lock" ] || return 2
  python3 - "$bootstrap_dependency_root/android/Gemfile" \
    "$bootstrap_dependency_root/android/fastlane/Pluginfile" \
    "$bootstrap_dependency_root/android/Gemfile.lock" <<'PY' || return 2
import re
import sys

gemfile, pluginfile, lockfile = sys.argv[1:]
gem_pattern = re.compile(
    r"^\s*gem\s*(?:\(\s*)?['\"]([A-Za-z0-9_.-]+)['\"]"
    r"(?:\s*,\s*['\"]([^'\"]+)['\"])?\s*\)?\s*(?:#.*)?$")
expected = {}
try:
    for path in (gemfile, pluginfile):
        for line in open(path, "r", encoding="utf-8"):
            if not re.match(r"^\s*gem\b", line):
                continue
            match = gem_pattern.fullmatch(line.rstrip("\r\n"))
            if match is None or match.group(1) in expected:
                raise ValueError
            expected[match.group(1)] = match.group(2)
    lines = open(lockfile, "r", encoding="utf-8").read().splitlines()
except (OSError, UnicodeError, ValueError):
    raise SystemExit(1)

try:
    start = lines.index("DEPENDENCIES") + 1
except ValueError:
    raise SystemExit(1)
locked = {}
dependency_pattern = re.compile(r"^  ([A-Za-z0-9_.-]+)(?: \(([^)]+)\))?$")
for line in lines[start:]:
    if line and not line.startswith("  "):
        break
    if not line:
        continue
    match = dependency_pattern.fullmatch(line)
    if match is None or match.group(1) in locked:
        raise SystemExit(1)
    locked[match.group(1)] = match.group(2)
if locked != expected:
    raise SystemExit(1)
try:
    bundled = lines.index("BUNDLED WITH")
except ValueError:
    raise SystemExit(1)
if bundled + 1 >= len(lines) or lines[bundled + 1].strip() != "4.0.16":
    raise SystemExit(1)
if expected.get("fastlane") != "= 2.237.0":
    raise SystemExit(1)
if expected.get("fastlane-plugin-firebase_app_distribution") != "= 1.0.0":
    raise SystemExit(1)
PY
  cp "$bootstrap_dependency_root/android/Gemfile.lock" "$bootstrap_lock_output" || return 1
  if [ -f "$project_root/android/Gemfile.lock" ] &&
    [ ! -L "$project_root/android/Gemfile.lock" ]; then
    bootstrap_lock_mode=$(fprs_file_mode "$project_root/android/Gemfile.lock") || return 1
  else
    bootstrap_lock_mode=$(fprs_file_mode "$PACKAGE_ROOT/templates/Gemfile.lock") || return 1
  fi
  chmod "$bootstrap_lock_mode" "$bootstrap_lock_output" 2>/dev/null
}

fprs_bootstrap_mergeable() {
  local bootstrap_merge_target bootstrap_merge_template bootstrap_merge_output
  local bootstrap_merge_report bootstrap_merge_status bootstrap_merge_begin
  local bootstrap_merge_end bootstrap_merge_mode bootstrap_merge_crlf
  bootstrap_merge_target=$1
  bootstrap_merge_template=$2
  bootstrap_merge_output=$3
  bootstrap_merge_report="$bootstrap_stage/merge-markers.$bootstrap_index"
  awk -v report="$bootstrap_merge_report" '
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /BEGIN flutter-play-store-release/) any_begin++
      if (line ~ /END flutter-play-store-release/) any_end++
      if (line == "# BEGIN flutter-play-store-release schema=1") {
        exact_begin++
        begin_line = NR
      }
      if (line == "# END flutter-play-store-release") {
        exact_end++
        end_line = NR
      }
    }
    END {
      print begin_line > report
      print end_line >> report
      if (any_begin == 0 && any_end == 0) exit 0
      if (any_begin == 1 && any_end == 1 && exact_begin == 1 && exact_end == 1 && begin_line < end_line) exit 10
      exit 2
    }
  ' "$bootstrap_merge_target"
  bootstrap_merge_status=$?
  case "$bootstrap_merge_status" in
    0) ;;
    10)
      bootstrap_merge_begin=$(sed -n '1p' "$bootstrap_merge_report")
      bootstrap_merge_end=$(sed -n '2p' "$bootstrap_merge_report")
      ;;
    *) return 2 ;;
  esac
  if awk '
    NR == 1 { seen = 1 }
    substr($0, length($0), 1) != "\r" { non_crlf = 1 }
    END { exit(seen && !non_crlf ? 0 : 1) }
  ' "$bootstrap_merge_target"
  then
    bootstrap_merge_crlf=1
  else
    bootstrap_merge_crlf=0
  fi
  if [ "$bootstrap_merge_status" -eq 0 ]; then
    cp "$bootstrap_merge_target" "$bootstrap_merge_output" 2>/dev/null || return 1
    if [ "$bootstrap_merge_crlf" -eq 1 ]; then
      printf '\r\n' >> "$bootstrap_merge_output" || return 1
      printf '# BEGIN flutter-play-store-release schema=1\r\n' >> "$bootstrap_merge_output"
      awk '{ sub(/\r$/, ""); printf "%s\r\n", $0 }' "$bootstrap_merge_template" \
        >> "$bootstrap_merge_output" || return 1
      printf '# END flutter-play-store-release\r\n' >> "$bootstrap_merge_output"
    else
      printf '\n' >> "$bootstrap_merge_output" || return 1
      printf '# BEGIN flutter-play-store-release schema=1\n' >> "$bootstrap_merge_output"
      cat "$bootstrap_merge_template" >> "$bootstrap_merge_output" || return 1
      printf '# END flutter-play-store-release\n' >> "$bootstrap_merge_output"
    fi
  else
    awk -v begin="$bootstrap_merge_begin" -v end="$bootstrap_merge_end" \
      -v template="$bootstrap_merge_template" -v crlf="$bootstrap_merge_crlf" '
      NR == begin {
        if (crlf) printf "# BEGIN flutter-play-store-release schema=1\r\n"
        else print "# BEGIN flutter-play-store-release schema=1"
        while ((getline replacement < template) > 0) {
          sub(/\r$/, "", replacement)
          if (crlf) printf "%s\r\n", replacement
          else print replacement
        }
        close(template)
        if (crlf) printf "# END flutter-play-store-release\r\n"
        else print "# END flutter-play-store-release"
        next
      }
      NR > begin && NR <= end { next }
      { print }
    ' "$bootstrap_merge_target" > "$bootstrap_merge_output" || return 1
  fi
  bootstrap_merge_mode=$(fprs_file_mode "$bootstrap_merge_target") || return 1
  chmod "$bootstrap_merge_mode" "$bootstrap_merge_output" 2>/dev/null
}

fprs_bootstrap_candidate() {
  local bootstrap_relative bootstrap_target bootstrap_output bootstrap_source
  local bootstrap_candidate_mode bootstrap_merge_status bootstrap_plan_relative bootstrap_plan_classification
  local bootstrap_plan_candidate bootstrap_plan_managed bootstrap_plan_hash
  bootstrap_relative=$1
  bootstrap_target=$2
  bootstrap_output=$3
  case "$bootstrap_relative" in
    .gitignore)
      fprs_bootstrap_gitignore "$bootstrap_target" "$bootstrap_output"
      return
      ;;
    tool/flutter-play-store-release/managed-files.sha256)
      printf '%s\n' 'package_id=flutter-play-store-release' 'schema_version=1' \
        > "$bootstrap_output" || return 1
      LC_ALL=C sort -t '|' -k1,1 "$bootstrap_stage/plan.unsorted" |
        while IFS='|' read -r bootstrap_plan_relative \
          bootstrap_plan_classification bootstrap_plan_candidate bootstrap_plan_managed
        do
          [ "$bootstrap_plan_managed" = whole ] || continue
          case "$bootstrap_plan_classification" in
            create|preserve|update-owned|merge)
              bootstrap_plan_hash=$(fprs_bootstrap_sha256 "$bootstrap_plan_candidate") || exit 1
              printf '%s %s\n' "$bootstrap_plan_hash" "$bootstrap_plan_relative"
              ;;
          esac
        done >> "$bootstrap_output" || return 1
      chmod 644 "$bootstrap_output" 2>/dev/null
      return
      ;;
    android/Gemfile.lock)
      if [ -f "$bootstrap_stage/custom-dependencies" ]; then
        fprs_bootstrap_regenerate_lock "$bootstrap_output"
        return
      fi
      ;;
  esac
  bootstrap_source=$(fprs_bootstrap_source_for "$bootstrap_relative") || return 2
  [ -f "$bootstrap_source" ] && [ ! -L "$bootstrap_source" ] || return 1
  if [ "${bootstrap_candidate_owned-0}" -ne 1 ] &&
    [ -f "$bootstrap_target" ] && [ ! -L "$bootstrap_target" ] &&
    case "$bootstrap_relative" in
      android/Gemfile|android/fastlane/Fastfile|android/fastlane/Pluginfile) true ;;
      *) false ;;
    esac && ! cmp -s "$bootstrap_source" "$bootstrap_target"
  then
    case "$bootstrap_relative" in
      android/Gemfile) bootstrap_candidate_mode=Gemfile ;;
      android/fastlane/Fastfile) bootstrap_candidate_mode=Fastfile ;;
      android/fastlane/Pluginfile) bootstrap_candidate_mode=Pluginfile ;;
    esac
    fprs_bootstrap_safe_merge "$bootstrap_candidate_mode" "$bootstrap_target" \
      "$bootstrap_source" "$bootstrap_output"
    bootstrap_merge_status=$?
    [ "$bootstrap_merge_status" -eq 0 ] || return "$bootstrap_merge_status"
    case "$bootstrap_candidate_mode" in
      Gemfile|Pluginfile)
        fprs_bootstrap_dependency_scan "$bootstrap_candidate_mode" "$bootstrap_output"
        bootstrap_merge_status=$?
        case "$bootstrap_merge_status" in
          0) : > "$bootstrap_stage/custom-dependencies" || return 1 ;;
          1) ;;
          *) return 2 ;;
        esac
        ;;
    esac
    return 0
  else
    fprs_bootstrap_copy "$bootstrap_source" "$bootstrap_output" || return 1
    case "$bootstrap_relative" in
      android/fastlane/.env.example)
        python3 - "$bootstrap_output" "$application_id" "$flavor_argument" <<'PY' || return 1
import sys

path, application_id, flavor = sys.argv[1:]
data = open(path, "rb").read()
package = application_id or "CHANGE_ME_APPLICATION_ID"
data = data.replace(b"APP_PACKAGE_NAME=com.example.app",
                    ("APP_PACKAGE_NAME=" + package).encode("ascii"))
if flavor:
    data = data.replace(b"# FLUTTER_FLAVOR=production",
                        ("FLUTTER_FLAVOR=" + flavor).encode("ascii"))
with open(path, "wb") as handle:
    handle.write(data)
PY
        ;;
    esac
    if [ -f "$bootstrap_target" ] && [ ! -L "$bootstrap_target" ]; then
      bootstrap_candidate_mode=$(fprs_file_mode "$bootstrap_target") || return 1
      chmod "$bootstrap_candidate_mode" "$bootstrap_output" 2>/dev/null || return 1
    fi
  fi
}

fprs_bootstrap_validate_candidate() {
  [ "$#" -eq 2 ] && [ -n "$1" ] && [ -f "$2" ] && [ ! -L "$2" ] && [ -s "$2" ] ||
    return 1
  case "$1" in
    *.sh) bash -n "$2" >/dev/null 2>&1 || return 1 ;;
    android/Gemfile|android/fastlane/Fastfile|android/fastlane/Pluginfile)
      command -v ruby >/dev/null 2>&1 && ruby -c "$2" >/dev/null 2>&1 || return 1
      ;;
    .github/workflows/release-android.yml)
      if command -v ruby >/dev/null 2>&1; then
        ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0))' "$2" \
          >/dev/null 2>&1 || return 1
      fi
      ;;
  esac
  case "$1" in
    android/fastlane/.env.example|docs/PLAY_STORE_RELEASE.md|\
    android/app/build.gradle|android/app/build.gradle.kts) ;;
    *)
      grep -F 'CHANGE_ME_APPLICATION_ID' "$2" >/dev/null 2>&1 && return 1
      ;;
  esac
  return 0
}

project_argument=
flavor_argument=
conflict_mode=fail
dry_run=0
seen_project=0
seen_flavor=0
seen_conflict=0
seen_dry_run=0
if [ "$#" -eq 1 ] && [ "$1" = --help ]; then
  fprs_bootstrap_usage
  exit 0
fi
while [ "$#" -gt 0 ]
do
  case "$1" in
    --project)
      [ "$seen_project" -eq 0 ] || fprs_bootstrap_bad_argument 'duplicate --project'
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_bootstrap_bad_argument 'missing value for --project'
      project_argument=$2; seen_project=1; shift 2
      ;;
    --flavor)
      [ "$seen_flavor" -eq 0 ] || fprs_bootstrap_bad_argument 'duplicate --flavor'
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_bootstrap_bad_argument 'missing value for --flavor'
      flavor_argument=$2; seen_flavor=1; shift 2
      ;;
    --conflict)
      [ "$seen_conflict" -eq 0 ] || fprs_bootstrap_bad_argument 'duplicate --conflict'
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_bootstrap_bad_argument 'missing value for --conflict'
      conflict_mode=$2; seen_conflict=1; shift 2
      ;;
    --dry-run)
      [ "$seen_dry_run" -eq 0 ] || fprs_bootstrap_bad_argument 'duplicate --dry-run'
      dry_run=1; seen_dry_run=1; shift
      ;;
    *) fprs_bootstrap_bad_argument "unknown argument: $1" ;;
  esac
done
[ "$seen_project" -eq 1 ] || fprs_bootstrap_bad_argument '--project is required'
case "$conflict_mode" in fail|skip) ;; *)
  fprs_bootstrap_bad_argument '--conflict must be fail or skip' ;;
esac

bootstrap_stage=$(mktemp -d "${TMPDIR:-/tmp}/.fprs-bootstrap.XXXXXX" 2>/dev/null) || exit 1
chmod 700 "$bootstrap_stage" 2>/dev/null || exit 1
trap fprs_bootstrap_cleanup EXIT
inspection_json="$bootstrap_stage/inspection.json"
if [ -n "$flavor_argument" ]; then
  "$INSPECTOR" --project "$project_argument" --format json --flavor "$flavor_argument" \
    > "$inspection_json"
  inspection_status=$?
else
  "$INSPECTOR" --project "$project_argument" --format json > "$inspection_json"
  inspection_status=$?
fi
case "$inspection_status" in 0) ;; 2) exit 2 ;; *) exit 1 ;; esac

project_root=$(CDPATH= cd -- "$project_argument" 2>/dev/null && pwd -P) || exit 2
application_id=$(python3 - "$inspection_json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    value = json.load(handle).get("application_id")
if value is not None:
    if not isinstance(value, str):
        raise SystemExit(1)
    print(value)
PY
) || exit 1
case "$application_id" in
  '' ) bootstrap_incomplete=1 ;;
  *[!A-Za-z0-9_.]* )
    printf 'ERROR: inspector returned an unsafe application ID\n' >&2
    exit 2
    ;;
  * ) bootstrap_incomplete=0 ;;
esac
case "$flavor_argument" in
  ''|*[!A-Za-z0-9_.-]*)
    [ -z "$flavor_argument" ] || {
      printf 'ERROR: inspector returned an unsafe flavor\n' >&2
      exit 2
    }
    ;;
esac
android_dsl=$(sed -n 's/^.*"android_dsl":"\([^"]*\)".*$/\1/p' "$inspection_json")
gradle_relative=$(sed -n 's/^.*"gradle_file":"\([^"]*\)".*$/\1/p' "$inspection_json")
case "$android_dsl:$gradle_relative" in
  groovy:android/app/build.gradle|kotlin:android/app/build.gradle.kts) ;;
  *) printf 'ERROR: inspector did not select one supported Gradle file\n' >&2; exit 2 ;;
esac
sed -n 's/^.*"files_bootstrap_may_change":\[\([^]]*\)\],"warnings":.*$/\1/p' \
  "$inspection_json" | tr ',' '\n' | sed 's/^"//; s/"$//' | LC_ALL=C sort \
  > "$bootstrap_stage/targets"
target_count=$(wc -l < "$bootstrap_stage/targets" | tr -d '[:space:]')
[ "$target_count" -eq 15 ] || {
  printf 'ERROR: inspector returned an incomplete bootstrap target set\n' >&2
  exit 1
}
awk '
  $0 != "android/Gemfile.lock" &&
  $0 != "tool/flutter-play-store-release/managed-files.sha256" { print }
' "$bootstrap_stage/targets" > "$bootstrap_stage/targets.order" || exit 1
printf '%s\n' \
  'android/Gemfile.lock' \
  'tool/flutter-play-store-release/managed-files.sha256' \
  >> "$bootstrap_stage/targets.order" || exit 1

bootstrap_sidecar="$project_root/tool/flutter-play-store-release/managed-files.sha256"
bootstrap_sidecar_records="$bootstrap_stage/managed-files.records"
: > "$bootstrap_sidecar_records"
if [ -e "$bootstrap_sidecar" ] || [ -L "$bootstrap_sidecar" ]; then
  fprs_bootstrap_validate_sidecar "$bootstrap_sidecar"
  sidecar_status=$?
  case "$sidecar_status" in
    0) bootstrap_sidecar_valid=1 ;;
    2)
      printf 'ERROR: managed-file ownership is malformed or an owned file was edited\n' >&2
      [ "$conflict_mode" = skip ] && exit 1 || exit 2
      ;;
    *)
      printf 'ERROR: managed-file ownership validation failed operationally\n' >&2
      exit 1
      ;;
  esac
else
  bootstrap_sidecar_valid=0
fi

: > "$bootstrap_stage/plan.unsorted"
bootstrap_index=0
bootstrap_conflicts=0
while IFS= read -r bootstrap_relative
do
  bootstrap_index=$((bootstrap_index + 1))
  bootstrap_candidate="$bootstrap_stage/candidate.$(printf '%08d' "$bootstrap_index")"
  bootstrap_target="$project_root/$bootstrap_relative"
  bootstrap_candidate_owned=0
  bootstrap_managed=none
  case "$bootstrap_relative" in
    .gitignore|"$gradle_relative"|tool/flutter-play-store-release/managed-files.sha256)
      ;;
    android/Gemfile|android/fastlane/Fastfile|android/fastlane/Pluginfile)
      if fprs_bootstrap_sidecar_record "$bootstrap_relative" >/dev/null 2>&1; then
        bootstrap_candidate_owned=1
        bootstrap_managed=whole
      elif [ ! -e "$bootstrap_target" ] && [ ! -L "$bootstrap_target" ]; then
        bootstrap_managed=whole
      else
        bootstrap_managed=merge
      fi
      ;;
    *)
      bootstrap_managed=whole
      if fprs_bootstrap_sidecar_record "$bootstrap_relative" >/dev/null 2>&1; then
        bootstrap_candidate_owned=1
      fi
      ;;
  esac
  if [ "$bootstrap_relative" = "$gradle_relative" ]; then
    if [ -n "$flavor_argument" ]; then
      fprs_gradle_signing_candidate "$android_dsl" "$bootstrap_target" \
        "$bootstrap_candidate" "$flavor_argument"
      candidate_status=$?
    else
      fprs_gradle_signing_candidate "$android_dsl" "$bootstrap_target" "$bootstrap_candidate"
      candidate_status=$?
    fi
    case "$candidate_status" in
      0)
        bootstrap_classification=$FPRS_GRADLE_SIGNING_CLASSIFICATION
        cmp -s "$bootstrap_candidate" "$bootstrap_target" && bootstrap_classification=preserve
        ;;
      2)
        bootstrap_candidate=
        bootstrap_conflicts=$((bootstrap_conflicts + 1))
        [ "$conflict_mode" = skip ] && bootstrap_classification=skip-conflict ||
          bootstrap_classification=fail-conflict
        ;;
      *)
        printf 'ERROR: Gradle candidate generation failed operationally\n' >&2
        exit 1
        ;;
    esac
  elif [ -e "$bootstrap_target" ] || [ -L "$bootstrap_target" ]; then
    if [ ! -f "$bootstrap_target" ] || [ -L "$bootstrap_target" ]; then
      bootstrap_candidate=
      bootstrap_conflicts=$((bootstrap_conflicts + 1))
      [ "$conflict_mode" = skip ] && bootstrap_classification=skip-conflict ||
        bootstrap_classification=fail-conflict
    elif [ "$bootstrap_relative" = tool/flutter-play-store-release/managed-files.sha256 ] ||
      [ "$bootstrap_candidate_owned" -eq 1 ] ||
      [ "$bootstrap_managed" = merge ] ||
      { [ "$bootstrap_relative" = android/Gemfile.lock ] &&
        [ -f "$bootstrap_stage/custom-dependencies" ]; } ||
      [ "$bootstrap_relative" = .gitignore ]; then
      fprs_bootstrap_candidate "$bootstrap_relative" "$bootstrap_target" \
        "$bootstrap_candidate"
      candidate_status=$?
      case "$candidate_status" in
        0)
          if cmp -s "$bootstrap_candidate" "$bootstrap_target"; then
            bootstrap_classification=preserve
          elif [ "$bootstrap_candidate_owned" -eq 1 ] ||
            [ "$bootstrap_relative" = tool/flutter-play-store-release/managed-files.sha256 ]; then
            bootstrap_classification=update-owned
          else
            bootstrap_classification=merge
          fi
          ;;
        2)
          bootstrap_candidate=
          bootstrap_conflicts=$((bootstrap_conflicts + 1))
          [ "$conflict_mode" = skip ] && bootstrap_classification=skip-conflict ||
            bootstrap_classification=fail-conflict
          ;;
        *)
          printf 'ERROR: bootstrap candidate generation failed operationally\n' >&2
          exit 1
          ;;
      esac
    else
      bootstrap_candidate=
      bootstrap_conflicts=$((bootstrap_conflicts + 1))
      [ "$conflict_mode" = skip ] && bootstrap_classification=skip-conflict ||
        bootstrap_classification=fail-conflict
    fi
  else
    fprs_bootstrap_candidate "$bootstrap_relative" "$bootstrap_target" \
      "$bootstrap_candidate"
    candidate_status=$?
    case "$candidate_status" in
      0) bootstrap_classification=create ;;
      2)
        bootstrap_candidate=
        bootstrap_conflicts=$((bootstrap_conflicts + 1))
        [ "$conflict_mode" = skip ] && bootstrap_classification=skip-conflict ||
          bootstrap_classification=fail-conflict
        ;;
      *)
        printf 'ERROR: bootstrap candidate generation failed operationally\n' >&2
        exit 1
        ;;
    esac
  fi
  printf '%s|%s|%s|%s\n' "$bootstrap_relative" "$bootstrap_classification" \
    "$bootstrap_candidate" "$bootstrap_managed" >> "$bootstrap_stage/plan.unsorted" || exit 1
done < "$bootstrap_stage/targets.order"
LC_ALL=C sort -t '|' -k1,1 "$bootstrap_stage/plan.unsorted" > "$bootstrap_stage/plan"
while IFS='|' read -r bootstrap_relative bootstrap_classification bootstrap_candidate bootstrap_managed
do
  printf 'PLAN %s %s\n' "$bootstrap_classification" "$bootstrap_relative"
done < "$bootstrap_stage/plan"

if [ "$bootstrap_conflicts" -gt 0 ]; then
  if [ "$conflict_mode" = fail ]; then
    printf 'ERROR: bootstrap refused conflicting paths\n' >&2
    exit 2
  fi
  printf 'ERROR: bootstrap incomplete; conflicts were skipped with zero project writes\n' >&2
  exit 1
fi
if [ "$dry_run" -eq 1 ]; then
  if [ "$bootstrap_incomplete" -eq 1 ]; then
    printf 'ERROR: release application ID is unresolved; choose a package or flavor before upload\n' >&2
    exit 1
  fi
  exit 0
fi

fprs_project_transaction_begin "$project_root" || exit $?
while IFS='|' read -r bootstrap_relative bootstrap_classification bootstrap_candidate bootstrap_managed
do
  case "$bootstrap_classification" in
    preserve) ;;
    create|update-owned|merge)
      fprs_project_transaction_register "$bootstrap_relative" "$bootstrap_candidate" || {
        bootstrap_status=$?
        fprs_project_transaction_abort >/dev/null 2>&1 || true
        exit "$bootstrap_status"
      }
      ;;
  esac
done < "$bootstrap_stage/plan"
fprs_project_transaction_validate fprs_bootstrap_validate_candidate || {
  bootstrap_status=$?
  fprs_project_transaction_abort >/dev/null 2>&1 || true
  exit "$bootstrap_status"
}
fprs_project_transaction_commit
bootstrap_status=$?
[ "$bootstrap_status" -eq 0 ] || exit "$bootstrap_status"
while IFS='|' read -r bootstrap_relative bootstrap_classification bootstrap_candidate bootstrap_managed
do
  case "$bootstrap_classification" in
    create|update-owned|merge)
      printf 'APPLY %s %s\n' "$bootstrap_classification" "$bootstrap_relative"
      ;;
  esac
done < "$bootstrap_stage/plan"
if [ "$bootstrap_incomplete" -eq 1 ]; then
  printf 'ERROR: release application ID is unresolved; choose a package or flavor before upload\n' >&2
  exit 1
fi
exit 0
