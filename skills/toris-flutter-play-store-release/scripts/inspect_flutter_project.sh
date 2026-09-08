#!/usr/bin/env bash
# Inspect a Flutter project using static, known configuration files only.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || {
  printf 'ERROR: could not resolve the inspector directory\n' >&2
  exit 1
}
COMMON="$SCRIPT_DIR/lib/common.sh"
[ -r "$COMMON" ] || {
  printf 'ERROR: common helpers are unavailable\n' >&2
  exit 1
}
. "$COMMON"

fprs_inspection_usage() {
  printf 'Usage: %s --project PATH [--format human|json] [--flavor NAME]\n' \
    "${0##*/}" >&2
}

fprs_inspection_argument_error() {
  printf 'ERROR: %s\n' "$1" >&2
  fprs_inspection_usage
  exit 2
}

fprs_inspection_root_error() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 2
}

fprs_append_warning() {
  local fprs_message
  fprs_message=$1
  if [ -z "$warnings" ]; then
    warnings=$fprs_message
  else
    warnings="$warnings
$fprs_message"
  fi
}

fprs_append_failure() {
  local fprs_message
  fprs_message=$1
  if [ -z "$failures" ]; then
    failures=$fprs_message
  else
    failures="$failures
$fprs_message"
  fi
}

fprs_line_count() {
  if [ -z "$1" ]; then
    printf '0\n'
  else
    printf '%s\n' "$1" | awk 'NF { count++ } END { print count + 0 }'
  fi
}

fprs_pubspec_environment_value() {
  local fprs_file fprs_target
  fprs_file=$1
  fprs_target=$2
  awk -v target="$fprs_target" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    /^[^[:space:]#][^:]*:/ {
      section = $0
      sub(/:.*/, "", section)
      section = trim(section)
      in_environment = (section == "environment")
    }
    in_environment && $0 ~ "^[[:space:]]+" target "[[:space:]]*:" {
      value = $0
      sub("^[[:space:]]+" target "[[:space:]]*:[[:space:]]*", "", value)
      sub(/[[:space:]]+#.*/, "", value)
      value = trim(value)
      first = substr(value, 1, 1)
      last = substr(value, length(value), 1)
      if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$fprs_file"
}

fprs_pubspec_top_value() {
  local fprs_file fprs_target
  fprs_file=$1
  fprs_target=$2
  awk -v target="$fprs_target" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    $0 ~ "^" target "[[:space:]]*:" {
      value = $0
      sub("^" target "[[:space:]]*:[[:space:]]*", "", value)
      sub(/[[:space:]]+#.*/, "", value)
      value = trim(value)
      first = substr(value, 1, 1)
      last = substr(value, length(value), 1)
      if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$fprs_file"
}

fprs_pubspec_has_dependency() {
  local fprs_file fprs_target
  fprs_file=$1
  fprs_target=$2
  awk -v target="$fprs_target" '
    /^[^[:space:]#][^:]*:/ {
      section = $0
      sub(/:.*/, "", section)
      in_dependencies = (section == "dependencies" || section == "dev_dependencies")
      next
    }
    in_dependencies && $0 ~ "^[[:space:]]+" target "[[:space:]]*:" { found = 1; exit }
    END { exit(found ? 0 : 1) }
  ' "$fprs_file"
}

fprs_extract_json_string_field() {
  local fprs_file fprs_field
  fprs_file=$1
  fprs_field=$2
  awk -v field="$fprs_field" '
    {
      line = $0
      pattern = "\"" field "\"[[:space:]]*:[[:space:]]*\""
      if (line !~ pattern) next
      sub("^.*\"" field "\"[[:space:]]*:[[:space:]]*\"", "", line)
      sub(/\".*/, "", line)
      print line
      exit
    }
  ' "$fprs_file"
}

fprs_gradle_without_comments() {
  local fprs_file
  fprs_file=$1
  awk '
    {
      line = $0
      while (1) {
        if (in_block_comment) {
          if (match(line, /\*\//)) {
            line = substr(line, RSTART + RLENGTH)
            in_block_comment = 0
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
          in_block_comment = 1
        }
        break
      }
      sub(/[[:space:]]*\/\/.*/, "", line)
      print line
    }
  ' "$fprs_file"
}

fprs_extract_default_config_text() {
  fprs_gradle_without_comments "$gradle_path" | awk '
    function brace_delta(value, opens, closes, copy) {
      copy = value
      opens = gsub(/\{/, "{", copy)
      copy = value
      closes = gsub(/\}/, "}", copy)
      return opens - closes
    }
    !inside && /defaultConfig[[:space:]]*\{/ {
      inside = 1
      depth = brace_delta($0)
      print
      if (depth <= 0) exit
      next
    }
    inside {
      print
      depth += brace_delta($0)
      if (depth <= 0) exit
    }
  '
}

fprs_text_key_present() {
  local fprs_text fprs_key
  fprs_text=$1
  fprs_key=$2
  printf '%s\n' "$fprs_text" | awk -v key="$fprs_key" '
    $0 ~ "(^|[;{[:space:]])" key "([[:space:]]|=)" { found = 1; exit }
    END { exit(found ? 0 : 1) }
  '
}

fprs_extract_text_literal() {
  local fprs_text fprs_key
  fprs_text=$1
  fprs_key=$2
  printf '%s\n' "$fprs_text" | awk -v key="$fprs_key" '
    $0 ~ "(^|[;{[:space:]])" key "([[:space:]]|=)" {
      line = $0
      sub("^.*" key "[[:space:]]*", "", line)
      sub(/^=[[:space:]]*/, "", line)
      quote = substr(line, 1, 1)
      if (quote != "\"" && quote != "\047") next
      line = substr(line, 2)
      end = index(line, quote)
      if (end < 1) next
      remainder = substr(line, end + 1)
      gsub(/[[:space:];}]/, "", remainder)
      if (remainder == "") {
        print substr(line, 1, end - 1)
        exit
      }
    }
  '
}

fprs_extract_text_integer() {
  local fprs_text fprs_key
  fprs_text=$1
  fprs_key=$2
  printf '%s\n' "$fprs_text" | awk -v key="$fprs_key" '
    $0 ~ "(^|[;{[:space:]])" key "([[:space:]]|=)" {
      line = $0
      sub("^.*" key "[[:space:]]*", "", line)
      sub(/^=[[:space:]]*/, "", line)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      gsub(/[;}][[:space:]]*$/, "", line)
      if (line ~ /^[0-9][0-9_]*$/) {
        gsub(/_/, "", line)
        print line
        exit
      }
    }
  '
}

fprs_gradle_key_present() {
  local fprs_file fprs_key
  fprs_file=$1
  fprs_key=$2
  fprs_gradle_without_comments "$fprs_file" |
    grep -E "^[[:space:]]*$fprs_key([[:space:]]|=)" >/dev/null 2>&1
}

fprs_extract_gradle_literal() {
  local fprs_file fprs_key
  fprs_file=$1
  fprs_key=$2
  fprs_gradle_without_comments "$fprs_file" | awk -v key="$fprs_key" '
    $0 ~ "^[[:space:]]*" key "([[:space:]]|=)" {
      line = $0
      sub("^[[:space:]]*" key "[[:space:]]*", "", line)
      sub(/^=[[:space:]]*/, "", line)
      quote = substr(line, 1, 1)
      if (quote != "\"" && quote != "\047") next
      line = substr(line, 2)
      end = index(line, quote)
      if (end > 0) {
        remainder = substr(line, end + 1)
        gsub(/[[:space:]]/, "", remainder)
        if (remainder == "" || remainder == ";") {
          print substr(line, 1, end - 1)
          exit
        }
      }
    }
  '
}

fprs_extract_gradle_integer() {
  local fprs_file fprs_key
  fprs_file=$1
  fprs_key=$2
  fprs_gradle_without_comments "$fprs_file" | awk -v key="$fprs_key" '
    $0 ~ "^[[:space:]]*" key "([[:space:]]|=)" {
      line = $0
      sub("^[[:space:]]*" key "[[:space:]]*", "", line)
      sub(/^=[[:space:]]*/, "", line)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      sub(/;[[:space:]]*$/, "", line)
      if (line ~ /^[0-9][0-9_]*$/) {
        gsub(/_/, "", line)
        print line
        exit
      }
    }
  '
}

fprs_read_property() {
  local fprs_file fprs_key
  fprs_file=$1
  fprs_key=$2
  if [ ! -f "$fprs_file" ]; then
    printf 'absent|\n'
    return 0
  fi
  awk -v target="$fprs_key" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function continues(value, index_value, count) {
      sub(/\r$/, "", value)
      count = 0
      for (index_value = length(value);
           index_value > 0 && substr(value, index_value, 1) == "\\";
           index_value--) count++
      return count % 2
    }
    function target_on_physical_line(value, line, separator, key, candidate) {
      line = trim(value)
      if (line == "") return 0
      separator = index(value, "=")
      if (separator > 0) {
        key = trim(substr(value, 1, separator - 1))
        return key == target
      }
      candidate = line
      sub(/[[:space:]:].*$/, "", candidate)
      return candidate == target
    }
    {
      physical_line = $0
      if (continuing) {
        if (target_on_physical_line(physical_line)) malformed = 1
        continuing = continues(physical_line)
        next
      }

      line = trim(physical_line)
      if (line == "") next
      if (line ~ /^[#!]/) next
      line_continues = continues(physical_line)
      separator = index(physical_line, "=")
      if (separator == 0) {
        candidate = line
        sub(/[[:space:]:].*$/, "", candidate)
        if (candidate == target) malformed = 1
      } else {
        key = trim(substr(physical_line, 1, separator - 1))
        if (key == target) {
          found = 1
          value = trim(substr(physical_line, separator + 1))
          if (line_continues) malformed = 1
        }
      }
      if (line_continues) continuing = 1
    }
    END {
      if (malformed) print "unresolved|"
      else if (found) print "resolved|" value
      else print "absent|"
    }
  ' "$fprs_file"
}

fprs_extract_android_records() {
  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function compact(value) {
      gsub(/[[:space:]]/, "", value)
      return value
    }
    function mask_strings(value, result, index_value, character, quote, escaped) {
      result = ""
      quote = ""
      escaped = 0
      for (index_value = 1; index_value <= length(value); index_value++) {
        character = substr(value, index_value, 1)
        if (quote != "") {
          result = result " "
          if (escaped) escaped = 0
          else if (character == "\\") escaped = 1
          else if (character == quote) quote = ""
        } else if (character == "\"" || character == "\047") {
          quote = character
          result = result " "
        } else result = result character
      }
      return result
    }
    function has_token(value, key, masked) {
      masked = mask_strings(value)
      return masked ~ ("(^|[^A-Za-z0-9_])" key "([^A-Za-z0-9_]|$)")
    }
    function assignment_rhs(value, key, pattern) {
      assignment_ok = 0
      value = trim(value)
      pattern = "^" key "([[:space:]]+|[[:space:]]*=[[:space:]]*)"
      if (!match(value, pattern)) return ""
      value = trim(substr(value, RSTART + RLENGTH))
      assignment_ok = 1
      return value
    }
    function literal_value(value, quote, index_value, character, escaped, result, remainder) {
      literal_ok = 0
      value = trim(value)
      quote = substr(value, 1, 1)
      if (quote != "\"" && quote != "\047") return ""
      escaped = 0
      result = ""
      for (index_value = 2; index_value <= length(value); index_value++) {
        character = substr(value, index_value, 1)
        if (escaped) return ""
        if (character == "\\") {
          escaped = 1
          continue
        }
        if (character == quote) {
          remainder = trim(substr(value, index_value + 1))
          if (remainder != "") return ""
          literal_ok = 1
          return result
        }
        result = result character
      }
      return ""
    }
    function current_scope_is(kind_value) {
      return scope_kind[depth] == kind_value
    }
    function ancestor_index(kind_value, index_value) {
      for (index_value = depth; index_value > 0; index_value--) {
        if (scope_kind[index_value] == kind_value) return index_value
      }
      return 0
    }
    function callback_ancestor(prefix, index_value) {
      for (index_value = depth; index_value > 0; index_value--) {
        if (scope_kind[index_value] == prefix "_callback") return index_value
      }
      return 0
    }
    function collection_callback_header(value, code, callee) {
      code = mask_strings(value)
      if (code ~ /->/) return 1
      code = compact(code)
      sub(/\(.*/, "", code)
      callee = code
      sub(/^.*\./, "", callee)
      return callee == "all" || callee == "configureEach" ||
        callee == "each" || callee == "eachWithIndex" ||
        callee == "forEach" || callee == "forEachIndexed" ||
        callee == "whenObjectAdded" || callee == "whenObjectRemoved" ||
        callee == "matching" || callee == "named" ||
        callee == "withType" || callee == "configure" ||
        callee == "register" ||
        callee == "findAll" || callee == "collect" ||
        callee == "collectEntries" || callee == "collectMany" ||
        callee == "any" || callee == "every" || callee == "inject" ||
        callee == "map" || callee == "flatMap" || callee == "filter"
    }
    function container_factory_header(value, code, callee) {
      code = compact(mask_strings(value))
      sub(/\(.*/, "", code)
      callee = code
      sub(/^.*\./, "", callee)
      return callee == "create" || callee == "maybeCreate" ||
        callee == "register"
    }
    function static_flavor_name(value, candidate) {
      candidate = compact(value)
      if (candidate ~ /^(create|maybeCreate)\(["\047][A-Za-z][A-Za-z0-9_-]*["\047]\)$/) {
        sub(/^(create|maybeCreate)\(["\047]/, "", candidate)
        sub(/["\047]\)$/, "", candidate)
        return candidate
      }
      if (collection_callback_header(value)) return ""
      if (candidate ~ /^[A-Za-z][A-Za-z0-9_-]*$/) return candidate
      return ""
    }
    function static_build_type_name(value, candidate) {
      candidate = compact(value)
      if (candidate ~ /^(getByName|named|create|maybeCreate)\(["\047][A-Za-z][A-Za-z0-9_-]*["\047]\)$/) {
        sub(/^(getByName|named|create|maybeCreate)\(["\047]/, "", candidate)
        sub(/["\047]\)$/, "", candidate)
        return candidate
      }
      if (collection_callback_header(value)) return ""
      if (candidate ~ /^[A-Za-z][A-Za-z0-9_-]*$/) return candidate
      return ""
    }
    function mark_default(key, statement, direct, rhs, value, normalized) {
      default_count[key]++
      if (default_count[key] > 1 || !direct) {
        default_status[key] = "unresolved"
        default_value[key] = ""
        return
      }
      rhs = assignment_rhs(statement, key)
      if (!assignment_ok) {
        default_status[key] = "unresolved"
        return
      }
      if (key == "applicationId") {
        value = literal_value(rhs)
        if (literal_ok && value ~ /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/) {
          default_status[key] = "resolved"
          default_value[key] = value
        } else default_status[key] = "unresolved"
        return
      }
      if (key == "versionName") {
        value = literal_value(rhs)
        if (literal_ok && value ~ /^[0-9A-Za-z][0-9A-Za-z._+-]*$/) {
          default_status[key] = "resolved"
          default_value[key] = value
          return
        }
        normalized = compact(rhs)
        if (normalized ~ /^\(project\.findProperty\(["\047]VERSION_NAME["\047]\)\?:["\047][0-9A-Za-z._+-]+["\047]\)\.toString\(\)$/) {
          default_status[key] = "gradle"
        } else if (normalized == "flutter.versionName" || normalized == "flutterVersionName") {
          default_status[key] = "flutter"
        } else default_status[key] = "unresolved"
        return
      }
      normalized = compact(rhs)
      if (normalized ~ /^[0-9][0-9_]*$/) {
        gsub(/_/, "", normalized)
        default_status[key] = "resolved"
        default_value[key] = normalized
      } else if (normalized ~ /^\(project\.findProperty\(["\047]VERSION_CODE["\047]\)\?:["\047][0-9]+["\047]\)\.toString\(\)\.toInt\(\)$/) {
        default_status[key] = "gradle"
      } else if (normalized == "flutter.versionCode" || normalized == "flutterVersionCode" ||
                 normalized == "flutterVersionCode.toInteger()") {
        default_status[key] = "flutter"
      } else default_status[key] = "unresolved"
    }
    function mark_flavor(name, key, statement, direct, record_key, rhs, value) {
      record_key = name SUBSEP key
      flavor_field_count[record_key]++
      if (flavor_field_count[record_key] > 1 || !direct) {
        flavor_field_status[record_key] = "unresolved"
        flavor_field_value[record_key] = ""
        flavor_identity_unresolved = 1
        return
      }
      rhs = assignment_rhs(statement, key)
      value = literal_value(rhs)
      if (!assignment_ok || !literal_ok) {
        flavor_field_status[record_key] = "unresolved"
        flavor_identity_unresolved = 1
        return
      }
      if (key == "applicationId") {
        if (value !~ /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/) {
          flavor_field_status[record_key] = "unresolved"
          flavor_identity_unresolved = 1
          return
        }
      } else if (value !~ /^\.?[A-Za-z0-9_.-]*$/) {
        flavor_field_status[record_key] = "unresolved"
        flavor_identity_unresolved = 1
        return
      }
      flavor_field_status[record_key] = "resolved"
      flavor_field_value[record_key] = value
    }
    function mark_release_suffix(statement, direct, rhs, value) {
      release_suffix_count++
      if (release_suffix_count > 1 || !direct) {
        release_suffix_status = "unresolved"
        release_suffix_value = ""
        return
      }
      rhs = assignment_rhs(statement, "applicationIdSuffix")
      value = literal_value(rhs)
      if (assignment_ok && literal_ok && value ~ /^\.?[A-Za-z0-9_.-]*$/) {
        release_suffix_status = "resolved"
        release_suffix_value = value
      } else release_suffix_status = "unresolved"
    }
    function mark_release_signing(statement, direct, rhs, normalized) {
      release_signing_count++
      if (release_signing_count > 1 || !direct) {
        release_signing_status = "unknown"
        return
      }
      rhs = assignment_rhs(statement, "signingConfig")
      normalized = compact(rhs)
      if (!assignment_ok) {
        release_signing_status = "unknown"
      } else if (normalized == "signingConfigs.debug" ||
          normalized ~ /^signingConfigs\.getByName\(["\047]debug["\047]\)$/ ||
          normalized ~ /^signingConfigs\[["\047]debug["\047]\]$/ ||
          normalized ~ /^signingConfigs\.named\(["\047]debug["\047]\)\.get\(\)$/) {
        release_signing_status = "debug"
      } else if (normalized ~ /^signingConfigs\.[A-Za-z][A-Za-z0-9_]*$/ ||
          normalized ~ /^signingConfigs\.getByName\(["\047][A-Za-z][A-Za-z0-9_]*["\047]\)$/ ||
          normalized ~ /^signingConfigs\[["\047][A-Za-z][A-Za-z0-9_]*["\047]\]$/ ||
          normalized ~ /^signingConfigs\.named\(["\047][A-Za-z][A-Za-z0-9_]*["\047]\)\.get\(\)$/) {
        release_signing_status = "release"
      } else release_signing_status = "unknown"
    }
    function mark_java(side, statement, direct, rhs, normalized, token) {
      java_count[side]++
      if (java_count[side] > 1 || !direct) {
        java_status[side] = "unresolved"
        java_value[side] = ""
        return
      }
      rhs = assignment_rhs(statement, side)
      normalized = compact(rhs)
      if (!assignment_ok || normalized !~ /^JavaVersion\.VERSION_([0-9]+|1_[0-9]+)$/) {
        java_status[side] = "unresolved"
        return
      }
      token = normalized
      sub(/^JavaVersion\.VERSION_/, "", token)
      if (token ~ /^1_[0-9]+$/) sub(/^1_/, "", token)
      if (token !~ /^[0-9]+$/) {
        java_status[side] = "unresolved"
        return
      }
      java_status[side] = "resolved"
      java_value[side] = token
    }
    function qualified_field_write(value, key, masked, token_pattern, offset, segment, start, after, masked_rest, operator_rest, raw_rest, immediate, first, inner) {
      masked = mask_strings(value)
      token_pattern = "\\." key "([^A-Za-z0-9_]|$)"
      offset = 1
      while (offset <= length(masked)) {
        segment = substr(masked, offset)
        if (!match(segment, token_pattern)) return 0
        start = offset + RSTART - 1
        after = start + length(key) + 1
        masked_rest = substr(masked, after)
        operator_rest = masked_rest
        sub(/^[[:space:]]+/, "", operator_rest)
        if (operator_rest ~ /^[+*\/%&|^-]?=([^=]|$)/ ||
            operator_rest ~ /^\.set[[:space:]]*\(/) return 1

        raw_rest = substr(value, after)
        immediate = substr(masked_rest, 1, 1)
        sub(/^[[:space:]]+/, "", raw_rest)
        first = substr(raw_rest, 1, 1)
        if (first == "(") {
          inner = substr(raw_rest, 2)
          sub(/^[[:space:]]+/, "", inner)
          if (inner != "" && substr(inner, 1, 1) != ")") return 1
        } else if (immediate ~ /[[:space:]]/ &&
                   first ~ /["\047A-Za-z0-9_]/ &&
                   raw_rest !~ /^(as|in|is|instanceof)([^A-Za-z0-9_]|$)/) {
          return 1
        }
        offset = start + 1
      }
      return 0
    }
    function callback_field_write(value, key, masked, token_pattern, offset, segment, start, before, after, masked_rest, operator_rest, raw_rest, immediate, first, inner) {
      if (qualified_field_write(value, key)) return 1
      masked = mask_strings(value)
      token_pattern = key "([^A-Za-z0-9_]|$)"
      offset = 1
      while (offset <= length(masked)) {
        segment = substr(masked, offset)
        if (!match(segment, token_pattern)) return 0
        start = offset + RSTART - 1
        before = substr(masked, start - 1, 1)
        if (start == 1 || before !~ /[A-Za-z0-9_.]/) {
          after = start + length(key)
          masked_rest = substr(masked, after)
          operator_rest = masked_rest
          sub(/^[[:space:]]+/, "", operator_rest)
          if (operator_rest ~ /^[+*\/%&|^-]?=([^=]|$)/ ||
              operator_rest ~ /^\.set[[:space:]]*\(/) return 1

          raw_rest = substr(value, after)
          immediate = substr(masked_rest, 1, 1)
          sub(/^[[:space:]]+/, "", raw_rest)
          first = substr(raw_rest, 1, 1)
          if (first == "(") {
            inner = substr(raw_rest, 2)
            sub(/^[[:space:]]+/, "", inner)
            if (inner != "" && substr(inner, 1, 1) != ")") return 1
          } else if (immediate ~ /[[:space:]]/ &&
                     first ~ /["\047A-Za-z0-9_]/ &&
                     raw_rest !~ /^(as|in|is|instanceof)([^A-Za-z0-9_]|$)/) {
            return 1
          }
        }
        offset = start + 1
      }
      return 0
    }
    function qualified_product_container(value, code) {
      code = compact(mask_strings(value))
      return code ~ /(^|[^A-Za-z0-9_])productFlavors(\.|\[)/
    }
    function qualified_product_factory(value, code) {
      code = compact(mask_strings(value))
      return code ~ /(^|[^A-Za-z0-9_])productFlavors\.(create|maybeCreate|register)\(/
    }
    function qualified_build_container(value, code) {
      code = compact(mask_strings(value))
      return code ~ /(^|[^A-Za-z0-9_])buildTypes(\.|\[)/
    }
    function qualified_release_build(value, raw, code) {
      raw = compact(value)
      code = compact(mask_strings(value))
      if (code ~ /(^|[^A-Za-z0-9_])buildTypes\.release\./) return 1
      if (raw ~ /(^|[^A-Za-z0-9_])buildTypes\[["\047]release["\047]\]\./) return 1
      if (raw ~ /(^|[^A-Za-z0-9_])buildTypes\.(getByName|named|create|maybeCreate|register)\(["\047]release["\047]\)\./) return 1
      return 0
    }
    function record_qualified_write_poison(statement, code, default_path, flavor_path, release_path) {
      code = compact(mask_strings(statement))
      default_path = code ~ /(^|[^A-Za-z0-9_])defaultConfig\./
      flavor_path = code ~ /(^|[^A-Za-z0-9_])productFlavors(\.|\[)/
      release_path = qualified_release_build(statement)

      if (qualified_product_factory(statement)) {
        product_flavors_present = 1
        qualified_flavor_poison = 1
      }

      if (default_path) {
        if (qualified_field_write(statement, "applicationId")) qualified_default_poison["applicationId"] = 1
        if (qualified_field_write(statement, "versionCode")) qualified_default_poison["versionCode"] = 1
        if (qualified_field_write(statement, "versionName") || qualified_field_write(statement, "versionNameSuffix")) qualified_default_poison["versionName"] = 1
        if (qualified_field_write(statement, "signingConfig")) qualified_release_signing_poison = 1
      }
      if (flavor_path) {
        product_flavors_present = 1
        if (qualified_field_write(statement, "applicationId") ||
            qualified_field_write(statement, "applicationIdSuffix")) qualified_flavor_poison = 1
        if (qualified_field_write(statement, "versionCode")) qualified_default_poison["versionCode"] = 1
        if (qualified_field_write(statement, "versionName") || qualified_field_write(statement, "versionNameSuffix")) qualified_default_poison["versionName"] = 1
        if (qualified_field_write(statement, "signingConfig")) qualified_release_signing_poison = 1
      }
      if (release_path) {
        if (qualified_field_write(statement, "applicationIdSuffix")) qualified_release_suffix_poison = 1
        if (qualified_field_write(statement, "versionCode")) qualified_default_poison["versionCode"] = 1
        if (qualified_field_write(statement, "versionName") || qualified_field_write(statement, "versionNameSuffix")) qualified_default_poison["versionName"] = 1
        if (qualified_field_write(statement, "signingConfig")) qualified_release_signing_poison = 1
      }
    }
    function record_qualified_header_poison(header) {
      if (qualified_product_factory(header)) {
        product_flavors_present = 1
        qualified_flavor_poison = 1
      }
    }
    function closure_parameter_statement(value, code) {
      code = mask_strings(value)
      return code ~ /^[[:space:]]*(\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*([[:space:]]*,[[:space:]]*[A-Za-z_][A-Za-z0-9_]*)*)[[:space:]]*->/
    }
    function reclassify_current_callback(name) {
      if (scope_kind[depth] == "flavor") {
        flavor_declaration_unresolved = 1
        name = scope_name[depth]
        if (scope_flavor_added[depth]) {
          delete flavor_seen[name]
          if (flavor_names[flavor_name_count] == name) {
            delete flavor_names[flavor_name_count]
            flavor_name_count--
          }
        }
        scope_kind[depth] = "flavor_callback"
        scope_name[depth] = ""
      } else if (scope_kind[depth] == "release" ||
                 scope_kind[depth] == "other_build_type") {
        scope_kind[depth] = "build_callback"
        scope_name[depth] = ""
      }
    }
    function process_statement(statement, masked, callback_index, flavor_index, release_index, default_index, compile_index, name) {
      statement = trim(statement)
      if (statement == "") return
      masked = mask_strings(statement)
      if (scope_first_statement[depth]) {
        scope_first_statement[depth] = 0
        if (closure_parameter_statement(statement)) reclassify_current_callback()
      }
      record_qualified_write_poison(statement)

      callback_index = callback_ancestor("flavor")
      if (callback_index) {
        if (callback_field_write(statement, "applicationId") ||
            callback_field_write(statement, "applicationIdSuffix")) {
          flavor_declaration_unresolved = 1
        }
        return
      }
      flavor_index = ancestor_index("flavor")
      if (flavor_index) {
        name = scope_name[flavor_index]
        if (has_token(statement, "applicationIdSuffix")) {
          mark_flavor(name, "applicationIdSuffix", statement, current_scope_is("flavor"))
        }
        if (has_token(statement, "applicationId")) {
          mark_flavor(name, "applicationId", statement, current_scope_is("flavor"))
        }
        return
      }

      callback_index = callback_ancestor("build")
      if (callback_index) {
        if (has_token(statement, "applicationIdSuffix")) {
          release_suffix_count++
          release_suffix_status = "unresolved"
          release_suffix_value = ""
        }
        if (has_token(statement, "signingConfig")) {
          release_signing_count++
          release_signing_status = "unknown"
        }
        return
      }
      release_index = ancestor_index("release")
      if (release_index) {
        if (has_token(statement, "applicationIdSuffix")) {
          mark_release_suffix(statement, current_scope_is("release"))
        }
        if (has_token(statement, "signingConfig")) {
          mark_release_signing(statement, current_scope_is("release"))
        }
        return
      }

      default_index = ancestor_index("default")
      if (default_index) {
        if (has_token(statement, "applicationId")) {
          mark_default("applicationId", statement, current_scope_is("default"))
        }
        if (has_token(statement, "versionCode")) {
          mark_default("versionCode", statement, current_scope_is("default"))
        }
        if (has_token(statement, "versionName")) {
          mark_default("versionName", statement, current_scope_is("default"))
        }
        return
      }

      compile_index = ancestor_index("compile")
      if (compile_index) {
        if (has_token(statement, "sourceCompatibility")) {
          mark_java("sourceCompatibility", statement, current_scope_is("compile"))
        }
        if (has_token(statement, "targetCompatibility")) {
          mark_java("targetCompatibility", statement, current_scope_is("compile"))
        }
      }
    }
    function open_block(header, parent, name, compact_header) {
      header = trim(header)
      record_qualified_header_poison(header)
      parent = scope_kind[depth]
      if (depth > 0) scope_first_statement[depth] = 0
      depth++
      scope_kind[depth] = "generic"
      scope_name[depth] = ""
      scope_first_statement[depth] = 1
      scope_flavor_added[depth] = 0

      if (parent == "root" && compact(header) == "android") {
        scope_kind[depth] = "android"
        return
      }
      if (parent == "android") {
        compact_header = compact(header)
        if (compact_header == "defaultConfig") scope_kind[depth] = "default"
        else if (compact_header == "compileOptions") scope_kind[depth] = "compile"
        else if (compact_header == "productFlavors") {
          scope_kind[depth] = "product_flavors"
          product_flavors_present = 1
        } else if (compact_header == "buildTypes") scope_kind[depth] = "build_types"
        else if (qualified_product_container(header)) scope_kind[depth] = "flavor_callback"
        else if (qualified_build_container(header)) scope_kind[depth] = "build_callback"
        return
      }
      if (parent == "product_flavors") {
        name = static_flavor_name(header)
        if (name != "") {
          scope_kind[depth] = "flavor"
          scope_name[depth] = name
          if (flavor_seen[name]) flavor_declaration_unresolved = 1
          else {
            flavor_seen[name] = 1
            flavor_names[++flavor_name_count] = name
            scope_flavor_added[depth] = 1
          }
        } else {
          scope_kind[depth] = "flavor_callback"
          if (container_factory_header(header) ||
              !collection_callback_header(header)) flavor_declaration_unresolved = 1
        }
        return
      }
      if (parent == "build_types") {
        name = static_build_type_name(header)
        if (name == "release") scope_kind[depth] = "release"
        else if (name != "") scope_kind[depth] = "other_build_type"
        else scope_kind[depth] = "build_callback"
      }
    }
    function close_block() {
      if (depth > 0) {
        delete scope_kind[depth]
        delete scope_name[depth]
        delete scope_first_statement[depth]
        delete scope_flavor_added[depth]
        depth--
      }
    }
    function flush_statement() {
      process_statement(buffer)
      buffer = ""
    }
    BEGIN {
      depth = 0
      scope_kind[0] = "root"
      release_suffix_status = "absent"
      release_signing_status = "absent"
    }
    {
      line = $0
      for (position = 1; position <= length(line); position++) {
        character = substr(line, position, 1)
        next_character = substr(line, position + 1, 1)
        if (in_block_comment) {
          if (character == "*" && next_character == "/") {
            in_block_comment = 0
            position++
          }
          continue
        }
        if (quote != "") {
          buffer = buffer character
          if (escaped) escaped = 0
          else if (character == "\\") escaped = 1
          else if (character == quote) quote = ""
          continue
        }
        if (character == "/" && next_character == "*") {
          in_block_comment = 1
          position++
          continue
        }
        if (character == "/" && next_character == "/") break
        if (character == "\"" || character == "\047") {
          quote = character
          buffer = buffer character
          continue
        }
        if (character == "(") {
          paren_depth++
          buffer = buffer character
          continue
        }
        if (character == ")") {
          if (paren_depth > 0) paren_depth--
          buffer = buffer character
          continue
        }
        if (character == "[") {
          bracket_depth++
          buffer = buffer character
          continue
        }
        if (character == "]") {
          if (bracket_depth > 0) bracket_depth--
          buffer = buffer character
          continue
        }
        if (character == "{") {
          open_block(buffer)
          buffer = ""
          paren_depth = 0
          bracket_depth = 0
          continue
        }
        if (character == "}") {
          flush_statement()
          close_block()
          paren_depth = 0
          bracket_depth = 0
          continue
        }
        if (character == ";" && paren_depth == 0 && bracket_depth == 0) {
          flush_statement()
          continue
        }
        buffer = buffer character
      }
      if (quote != "") buffer = buffer "\n"
      else if (paren_depth == 0 && bracket_depth == 0) flush_statement()
      else buffer = buffer " "
    }
    END {
      flush_statement()
      if (qualified_flavor_poison) {
        product_flavors_present = 1
        flavor_declaration_unresolved = 1
        flavor_identity_unresolved = 1
      }
      if (qualified_release_suffix_poison) {
        release_suffix_status = "unresolved"
        release_suffix_value = ""
      }
      if (qualified_release_signing_poison) release_signing_status = "unknown"
      for (default_index_value = 1; default_index_value <= 3; default_index_value++) {
        if (default_index_value == 1) default_key = "applicationId"
        else if (default_index_value == 2) default_key = "versionCode"
        else default_key = "versionName"
        if (qualified_default_poison[default_key]) {
          default_status[default_key] = "unresolved"
          default_value[default_key] = ""
        } else if (default_count[default_key] == 0) default_status[default_key] = "absent"
        print "default|" default_key "|" default_status[default_key] "|" default_value[default_key]
      }

      source_status = java_status["sourceCompatibility"]
      target_status = java_status["targetCompatibility"]
      if (java_count["sourceCompatibility"] == 0 && java_count["targetCompatibility"] == 0) {
        print "java|absent|"
      } else if ((java_count["sourceCompatibility"] == 0 || source_status == "resolved") &&
                 (java_count["targetCompatibility"] == 0 || target_status == "resolved") &&
                 (java_count["sourceCompatibility"] == 0 || java_count["targetCompatibility"] == 0 ||
                  java_value["sourceCompatibility"] == java_value["targetCompatibility"])) {
        if (java_count["sourceCompatibility"] != 0) java_result = java_value["sourceCompatibility"]
        else java_result = java_value["targetCompatibility"]
        print "java|resolved|" java_result
      } else print "java|unresolved|"

      print "flavor_state|" (product_flavors_present ? "present" : "absent") "|" (flavor_name_count + 0) "|" (flavor_declaration_unresolved ? 1 : 0) "|" (flavor_identity_unresolved ? 1 : 0)
      for (flavor_index_value = 1; flavor_index_value <= flavor_name_count; flavor_index_value++) {
        flavor_name_value = flavor_names[flavor_index_value]
        suffix_key = flavor_name_value SUBSEP "applicationIdSuffix"
        override_key = flavor_name_value SUBSEP "applicationId"
        suffix_status = flavor_field_count[suffix_key] ? flavor_field_status[suffix_key] : "absent"
        override_status = flavor_field_count[override_key] ? flavor_field_status[override_key] : "absent"
        print "flavor|" flavor_name_value "|" suffix_status "|" flavor_field_value[suffix_key] "|" override_status "|" flavor_field_value[override_key]
      }
      print "release_suffix|" release_suffix_status "|" release_suffix_value
      print "release_signing|" release_signing_status
    }
  ' "$gradle_path"
}

fprs_extract_agp_version() {
  local fprs_file fprs_value
  for fprs_file in \
    "$project_root/android/settings.gradle" \
    "$project_root/android/settings.gradle.kts" \
    "$project_root/android/build.gradle" \
    "$project_root/android/build.gradle.kts"
  do
    [ -f "$fprs_file" ] || continue
    fprs_value=$(fprs_gradle_without_comments "$fprs_file" | awk '
      /com\.android\.application/ && /version[[:space:]]*[=]?[[:space:]]*["\047]/ {
        line = $0
        sub(/^.*version[[:space:]]*[=]?[[:space:]]*/, "", line)
        quote = substr(line, 1, 1)
        if (quote == "\"" || quote == "\047") {
          line = substr(line, 2)
          end = index(line, quote)
          if (end > 0) {
            print substr(line, 1, end - 1)
            exit
          }
        }
      }
      /com\.android\.tools\.build:gradle:/ {
        line = $0
        sub(/^.*com\.android\.tools\.build:gradle:/, "", line)
        sub(/[^0-9A-Za-z_.+-].*/, "", line)
        if (line != "") {
          print line
          exit
        }
      }
    ')
    if printf '%s\n' "$fprs_value" | grep -E '^[0-9][0-9A-Za-z_.+-]*$' >/dev/null 2>&1; then
      printf '%s\n' "$fprs_value"
      return 0
    fi
  done
}

fprs_extract_gradle_wrapper_version() {
  local fprs_file
  fprs_file="$project_root/android/gradle/wrapper/gradle-wrapper.properties"
  [ -f "$fprs_file" ] || return 0
  awk '
    /^distributionUrl[[:space:]]*=/ && /gradle-[0-9][0-9.]*-(all|bin)\.zip/ {
      line = $0
      sub(/^.*gradle-/, "", line)
      sub(/-(all|bin)\.zip.*$/, "", line)
      if (line ~ /^[0-9][0-9.]*$/) print line
      exit
    }
  ' "$fprs_file"
}

fprs_extract_java_compatibility() {
  fprs_gradle_without_comments "$gradle_path" | awk '
    /JavaVersion\.VERSION_([0-9]+|1_[0-9]+)([^A-Za-z0-9_]|$)/ {
      line = $0
      sub(/^.*JavaVersion\.VERSION_/, "", line)
      sub(/[^0-9_].*/, "", line)
      if (line ~ /^1_[0-9]+$/) sub(/^1_/, "", line)
      if (line ~ /^[0-9]+$/) {
        print line
        exit
      }
    }
  '
}

fprs_extract_release_signing_reference() {
  fprs_gradle_without_comments "$gradle_path" | awk '
    function brace_delta(value, opens, closes, copy) {
      copy = value
      opens = gsub(/\{/, "{", copy)
      copy = value
      closes = gsub(/\}/, "}", copy)
      return opens - closes
    }
    function trim_assignment(value) {
      if (!match(value, /signingConfig([[:space:]]+|[[:space:]]*=[[:space:]]*)/)) return ""
      value = substr(value, RSTART + RLENGTH)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      while (value ~ /[;}][[:space:]]*$/) {
        sub(/[;}][[:space:]]*$/, "", value)
        sub(/[[:space:]]+$/, "", value)
      }
      return value
    }
    function classify_reference(value, compact) {
      compact = value
      gsub(/[[:space:]]/, "", compact)
      if (compact == "signingConfigs.debug" ||
          compact ~ /^signingConfigs\.getByName\(["\047]debug["\047]\)$/ ||
          compact ~ /^signingConfigs\[["\047]debug["\047]\]$/ ||
          compact ~ /^signingConfigs\.named\(["\047]debug["\047]\)\.get\(\)$/) {
        return "debug"
      }
      if (compact ~ /^signingConfigs\.[A-Za-z][A-Za-z0-9_]*$/ ||
          compact ~ /^signingConfigs\.getByName\(["\047][A-Za-z][A-Za-z0-9_]*["\047]\)$/ ||
          compact ~ /^signingConfigs\[["\047][A-Za-z][A-Za-z0-9_]*["\047]\]$/ ||
          compact ~ /^signingConfigs\.named\(["\047][A-Za-z][A-Za-z0-9_]*["\047]\)\.get\(\)$/) {
        return "release"
      }
      return "unknown"
    }
    !inside && /buildTypes[[:space:]]*\{/ {
      inside = 1
      depth = brace_delta($0)
      if (depth <= 0) inside = 0
      next
    }
    inside {
      line = $0
      release_declaration_line = 0
      if (depth == 1 &&
          (line ~ /^[[:space:]]*release[[:space:]]*\{/ ||
           line ~ /^[[:space:]]*(getByName|named)[[:space:]]*\([[:space:]]*"release"[[:space:]]*\)[[:space:]]*\{/ ||
           line ~ /^[[:space:]]*(getByName|named)[[:space:]]*\([[:space:]]*\047release\047[[:space:]]*\)[[:space:]]*\{/)) {
        in_release = 1
        release_declaration_line = 1
      }
      if (in_release && line ~ /signingConfig([[:space:]]|=)/) {
        signing_assignment_count++
        assignment_direct = (depth == 2 || release_declaration_line)
        match(line, /signingConfig([[:space:]]+|[[:space:]]*=[[:space:]]*)/)
        assignment_prefix = substr(line, 1, RSTART - 1)
        if (release_declaration_line) {
          release_open = index(assignment_prefix, "{")
          if (release_open) assignment_prefix = substr(assignment_prefix, release_open + 1)
          else assignment_direct = 0
        }
        gsub(/[[:space:]]/, "", assignment_prefix)
        if (signing_assignment_count > 1 || !assignment_direct || assignment_prefix != "") {
          reference = "unknown"
        } else reference = classify_reference(trim_assignment(line))
      }
      depth += brace_delta(line)
      if (in_release && depth <= 1) {
        in_release = 0
      }
      if (depth <= 0) {
        inside = 0
        in_release = 0
        depth = 0
      }
    }
    END { if (reference != "") print reference }
  '
}

fprs_extract_release_application_id_suffix() {
  fprs_gradle_without_comments "$gradle_path" | awk '
    function brace_delta(value, opens, closes, copy) {
      copy = value
      opens = gsub(/\{/, "{", copy)
      copy = value
      closes = gsub(/\}/, "}", copy)
      return opens - closes
    }
    function assignment_value(value) {
      if (!match(value, /applicationIdSuffix([[:space:]]+|[[:space:]]*=[[:space:]]*)/)) return ""
      value = substr(value, RSTART + RLENGTH)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      while (value ~ /[;}][[:space:]]*$/) {
        sub(/[;}][[:space:]]*$/, "", value)
        sub(/[[:space:]]+$/, "", value)
      }
      return value
    }
    function literal_suffix(value, quote, rest, end) {
      literal_ok = 0
      quote = substr(value, 1, 1)
      if (quote != "\"" && quote != "\047") return ""
      rest = substr(value, 2)
      end = index(rest, quote)
      if (end < 1 || substr(rest, end + 1) != "") return ""
      value = substr(rest, 1, end - 1)
      if (value !~ /^\.?[A-Za-z0-9_.-]*$/) return ""
      literal_ok = 1
      return value
    }
    BEGIN { suffix_status = "absent" }
    !inside && /buildTypes[[:space:]]*\{/ {
      inside = 1
      depth = brace_delta($0)
      if ($0 ~ /applicationIdSuffix([[:space:]]|=)/) suffix_status = "unresolved"
      if (depth <= 0) inside = 0
      next
    }
    inside {
      line = $0
      release_declaration_line = 0
      if (depth == 1 &&
          (line ~ /^[[:space:]]*release[[:space:]]*\{/ ||
           line ~ /^[[:space:]]*(getByName|named|create|maybeCreate)[[:space:]]*\([[:space:]]*"release"[[:space:]]*\)[[:space:]]*\{/ ||
           line ~ /^[[:space:]]*(getByName|named|create|maybeCreate)[[:space:]]*\([[:space:]]*\047release\047[[:space:]]*\)[[:space:]]*\{/)) {
        in_release = 1
        release_declaration_line = 1
      }
      if (in_release && line ~ /applicationIdSuffix([[:space:]]|=)/) {
        assignment_direct = (depth == 2 || release_declaration_line)
        match(line, /applicationIdSuffix([[:space:]]+|[[:space:]]*=[[:space:]]*)/)
        assignment_prefix = substr(line, 1, RSTART - 1)
        if (release_declaration_line) {
          release_open = index(assignment_prefix, "{")
          if (release_open) assignment_prefix = substr(assignment_prefix, release_open + 1)
          else assignment_direct = 0
        }
        gsub(/[[:space:]]/, "", assignment_prefix)
        if (suffix_status != "absent" || !assignment_direct || assignment_prefix != "") {
          suffix_status = "unresolved"
          suffix = ""
        } else {
          suffix = literal_suffix(assignment_value(line))
          if (literal_ok) suffix_status = "resolved"
          else suffix_status = "unresolved"
        }
      }
      depth += brace_delta(line)
      if (in_release && depth <= 1) {
        in_release = 0
      }
      if (depth <= 0) {
        inside = 0
        in_release = 0
        depth = 0
      }
    }
    END { print suffix_status "|" suffix }
  '
}

fprs_extract_product_flavor_state() {
  fprs_gradle_without_comments "$gradle_path" | awk '
    function brace_delta(value, opens, closes, copy) {
      copy = value
      opens = gsub(/\{/, "{", copy)
      copy = value
      closes = gsub(/\}/, "}", copy)
      return opens - closes
    }
    function static_declaration(value) {
      return value ~ /^[[:space:]]*(create|maybeCreate)[[:space:]]*\([[:space:]]*["\047][A-Za-z][A-Za-z0-9_-]*["\047][[:space:]]*\)[[:space:]]*\{/ ||
        value ~ /^[[:space:]]*[A-Za-z][A-Za-z0-9_-]*[[:space:]]*\{/
    }
    !inside && /productFlavors[[:space:]]*\{/ {
      inside = 1
      present = 1
      depth = brace_delta($0)
      opening_remainder = $0
      sub(/^.*productFlavors[[:space:]]*\{/, "", opening_remainder)
      gsub(/[[:space:]}]/, "", opening_remainder)
      if (opening_remainder != "") unresolved++
      if (depth <= 0) inside = 0
      next
    }
    inside {
      if (depth == 1 &&
          (/\{/ || /^[[:space:]]*(create|maybeCreate|register)[[:space:]]*\(/)) {
        if (static_declaration($0)) resolved++
        else unresolved++
      }
      depth += brace_delta($0)
      if (depth <= 0) {
        inside = 0
        depth = 0
      }
    }
    END {
      if (present) print "present|" resolved + 0 "|" unresolved + 0
      else print "absent|0|0"
    }
  '
}

fprs_extract_version_property_source() {
  local fprs_text fprs_kind
  fprs_text=$1
  fprs_kind=$2
  printf '%s\n' "$fprs_text" | awk -v kind="$fprs_kind" '
    function assignment_value(value, key) {
      if (value !~ "^[[:space:]]*" key "([[:space:]]+|[[:space:]]*=[[:space:]]*)") return ""
      sub("^[[:space:]]*" key "([[:space:]]+|[[:space:]]*=[[:space:]]*)", "", value)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      while (value ~ /[;}][[:space:]]*$/) {
        sub(/[;}][[:space:]]*$/, "", value)
        sub(/[[:space:]]+$/, "", value)
      }
      gsub(/[[:space:]]/, "", value)
      return value
    }
    kind == "name" && $0 ~ /^[[:space:]]*versionName([^A-Za-z0-9_]|$)/ {
      occurrences++
      value = assignment_value($0, "versionName")
      if (value ~ /^\(project\.findProperty\(["\047]VERSION_NAME["\047]\)\?:["\047][0-9A-Za-z._+-]+["\047]\)\.toString\(\)$/) {
        source = "gradle"
      } else if (value == "flutter.versionName" || value == "flutterVersionName") {
        source = "flutter"
      } else invalid = 1
      next
    }
    kind == "code" && $0 ~ /^[[:space:]]*versionCode([^A-Za-z0-9_]|$)/ {
      occurrences++
      value = assignment_value($0, "versionCode")
      if (value ~ /^\(project\.findProperty\(["\047]VERSION_CODE["\047]\)\?:["\047][0-9]+["\047]\)\.toString\(\)\.toInt\(\)$/) {
        source = "gradle"
      } else if (value == "flutter.versionCode" || value == "flutterVersionCode" ||
                 value == "flutterVersionCode.toInteger()") {
        source = "flutter"
      } else invalid = 1
      next
    }
    END { if (occurrences == 1 && !invalid && source != "") print source }
  '
}

fprs_extract_flavor_records() {
  fprs_gradle_without_comments "$gradle_path" | awk '
    function brace_delta(value, opens, closes, copy) {
      copy = value
      opens = gsub(/\{/, "{", copy)
      copy = value
      closes = gsub(/\}/, "}", copy)
      return opens - closes
    }
    function literal_value(value, key, quote, end) {
      literal_ok = 0
      sub("^.*" key "[[:space:]]*", "", value)
      sub(/^=[[:space:]]*/, "", value)
      quote = substr(value, 1, 1)
      if (quote != "\"" && quote != "\047") return ""
      value = substr(value, 2)
      end = index(value, quote)
      if (end < 1) return ""
      remainder = substr(value, end + 1)
      gsub(/[[:space:];}]/, "", remainder)
      if (remainder != "") return ""
      literal_ok = 1
      return substr(value, 1, end - 1)
    }
    !inside && /productFlavors[[:space:]]*\{/ {
      inside = 1
      depth = brace_delta($0)
      if (depth <= 0) inside = 0
      next
    }
    inside {
      line = $0
      if (depth == 1) {
        name = ""
        if (line ~ /^[[:space:]]*(create|maybeCreate)[[:space:]]*\([[:space:]]*"[A-Za-z][A-Za-z0-9_-]*"/) {
          name = line
          sub(/^[[:space:]]*(create|maybeCreate)[[:space:]]*\([[:space:]]*"/, "", name)
          sub(/".*/, "", name)
        } else if (line ~ /^[[:space:]]*(create|maybeCreate)[[:space:]]*\([[:space:]]*\047[A-Za-z][A-Za-z0-9_-]*\047/) {
          name = line
          sub(/^[[:space:]]*(create|maybeCreate)[[:space:]]*\([[:space:]]*\047/, "", name)
          sub(/\047.*/, "", name)
        } else if (line ~ /^[[:space:]]*[A-Za-z][A-Za-z0-9_-]*[[:space:]]*\{/) {
          name = line
          sub(/^[[:space:]]*/, "", name)
          sub(/[[:space:]]*\{.*/, "", name)
        }
        if (name != "") {
          current = name
          suffix = ""
          suffix_status = "absent"
          override = ""
          override_status = "absent"
        }
      }
      if (current != "" && line ~ /applicationIdSuffix([[:space:]]|=)/) {
        suffix = literal_value(line, "applicationIdSuffix")
        if (literal_ok && suffix ~ /^\.?[A-Za-z0-9_.-]*$/) suffix_status = "resolved"
        else {
          suffix = ""
          suffix_status = "unresolved"
        }
      }
      if (current != "" && line ~ /applicationId([[:space:]]|=)/ &&
          line !~ /applicationIdSuffix/) {
        override = literal_value(line, "applicationId")
        if (literal_ok && override ~ /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/) override_status = "resolved"
        else {
          override = ""
          override_status = "unresolved"
        }
      }
      depth += brace_delta(line)
      if (current != "" && depth <= 1) {
        if (current ~ /^[A-Za-z][A-Za-z0-9_-]*$/) {
          print current "|" suffix_status "|" suffix "|" override_status "|" override
        }
        current = ""
        suffix = ""
        suffix_status = ""
        override = ""
        override_status = ""
      }
      if (depth <= 0) {
        inside = 0
        depth = 0
      }
    }
  ' | LC_ALL=C sort -t '|' -k1,1 -u
}

fprs_extract_flavor_dimensions() {
  fprs_gradle_without_comments "$gradle_path" | awk '
    function emit_quoted(value, index_value, quote, rest, end, item, outside, emitted) {
      index_value = 1
      while (index_value <= length(value)) {
        quote = substr(value, index_value, 1)
        if (quote != "\"" && quote != "\047") {
          outside = outside quote
          index_value++
          continue
        }
        rest = substr(value, index_value + 1)
        end = index(rest, quote)
        if (end < 1) {
          outside = outside quote rest
          break
        }
        item = substr(rest, 1, end - 1)
        if (item ~ /^[A-Za-z][A-Za-z0-9_-]*$/) {
          print item
          emitted++
        } else outside = outside item
        index_value += end + 1
      }
      gsub(/listOf/, "", outside)
      gsub(/[[:space:],+=[\]()]/, "", outside)
      if (!emitted || outside != "") print "?"
    }
    /flavorDimensions/ {
      line = $0
      sub(/^.*flavorDimensions[[:space:]]*/, "", line)
      emit_quoted(line)
      next
    }
    /^[[:space:]]*dimension([[:space:]]|=)/ {
      line = $0
      sub(/^[[:space:]]*dimension[[:space:]]*/, "", line)
      emit_quoted(line)
    }
  ' | LC_ALL=C sort -u
}

fprs_flavor_record() {
  local fprs_name
  fprs_name=$1
  printf '%s\n' "$flavor_records" | awk -F '|' -v target="$fprs_name" '
    $1 == target { print; found = 1; exit }
    END { if (!found) exit 1 }
  '
}

fprs_extract_firebase_records() {
  local fprs_file
  fprs_file=$1
  [ -f "$fprs_file" ] || return 0
  awk '
    function string_end(source, start, index_value, character, escaped) {
      escaped = 0
      for (index_value = start + 1; index_value <= length(source); index_value++) {
        character = substr(source, index_value, 1)
        if (escaped) {
          escaped = 0
        } else if (character == "\\") {
          escaped = 1
        } else if (character == "\"") {
          return index_value
        }
      }
      return 0
    }
    function skip_space(source, start, character) {
      while (start <= length(source)) {
        character = substr(source, start, 1)
        if (character !~ /[[:space:]]/) break
        start++
      }
      return start
    }
    function matching_end(source, start, opener, closer, index_value, depth, character, end) {
      closer = (opener == "{") ? "}" : "]"
      depth = 0
      for (index_value = start; index_value <= length(source); index_value++) {
        character = substr(source, index_value, 1)
        if (character == "\"") {
          end = string_end(source, index_value)
          if (!end) return 0
          index_value = end
        } else if (character == opener) {
          depth++
        } else if (character == closer) {
          depth--
          if (depth == 0) return index_value
        }
      }
      return 0
    }
    function direct_container(source, target, opener, index_value, depth, character, end, token, next_value, start, finish) {
      depth = 0
      for (index_value = 1; index_value <= length(source); index_value++) {
        character = substr(source, index_value, 1)
        if (character == "\"") {
          end = string_end(source, index_value)
          if (!end) return ""
          if (depth == 1) {
            token = substr(source, index_value + 1, end - index_value - 1)
            next_value = skip_space(source, end + 1)
            if (token == target && substr(source, next_value, 1) == ":") {
              start = skip_space(source, next_value + 1)
              if (substr(source, start, 1) != opener) return ""
              finish = matching_end(source, start, opener)
              if (!finish) return ""
              return substr(source, start, finish - start + 1)
            }
          }
          index_value = end
        } else if (character == "{") {
          depth++
        } else if (character == "}") {
          depth--
        }
      }
      return ""
    }
    function direct_string(source, target, index_value, depth, character, end, token, next_value, start, finish, value) {
      depth = 0
      for (index_value = 1; index_value <= length(source); index_value++) {
        character = substr(source, index_value, 1)
        if (character == "\"") {
          end = string_end(source, index_value)
          if (!end) return ""
          if (depth == 1) {
            token = substr(source, index_value + 1, end - index_value - 1)
            next_value = skip_space(source, end + 1)
            if (token == target && substr(source, next_value, 1) == ":") {
              start = skip_space(source, next_value + 1)
              if (substr(source, start, 1) != "\"") return ""
              finish = string_end(source, start)
              if (!finish) return ""
              value = substr(source, start + 1, finish - start - 1)
              if (value ~ /\\/) return ""
              return value
            }
          }
          index_value = end
        } else if (character == "{") {
          depth++
        } else if (character == "}") {
          depth--
        }
      }
      return ""
    }
    function emit_client(client, client_info, android_info, app_id, package_name) {
      client_info = direct_container(client, "client_info", "{")
      if (client_info == "") return
      android_info = direct_container(client_info, "android_client_info", "{")
      if (android_info == "") return
      app_id = direct_string(client_info, "mobilesdk_app_id")
      package_name = direct_string(android_info, "package_name")
      if (app_id ~ /^[A-Za-z0-9:._-]+$/ &&
          package_name ~ /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/) {
        print package_name "|" app_id
      }
    }
    { document = document $0 "\n" }
    END {
      clients = direct_container(document, "client", "[")
      if (clients == "") exit
      for (index_value = 2; index_value < length(clients); index_value++) {
        character = substr(clients, index_value, 1)
        if (character == "\"") {
          finish = string_end(clients, index_value)
          if (!finish) exit
          index_value = finish
        } else if (character == "{") {
          finish = matching_end(clients, index_value, "{")
          if (!finish) exit
          emit_client(substr(clients, index_value, finish - index_value + 1))
          index_value = finish
        }
      }
    }
  ' "$fprs_file"
}

fprs_json_string() {
  local fprs_escaped
  fprs_escaped=$(fprs_json_escape "$1") || return 1
  printf '"%s"' "$fprs_escaped"
}

fprs_json_nullable_string() {
  if [ -z "$1" ]; then
    printf 'null'
  else
    fprs_json_string "$1"
  fi
}

fprs_json_string_array() {
  local fprs_lines fprs_first fprs_line
  fprs_lines=$1
  fprs_first=true
  printf '['
  if [ -n "$fprs_lines" ]; then
    while IFS= read -r fprs_line
    do
      [ -n "$fprs_line" ] || continue
      if [ "$fprs_first" = true ]; then
        fprs_first=false
      else
        printf ','
      fi
      fprs_json_string "$fprs_line" || return 1
    done <<EOF
$fprs_lines
EOF
  fi
  printf ']'
}

fprs_json_firebase_apps() {
  local fprs_first fprs_record fprs_package fprs_app_id fprs_matches
  fprs_first=true
  printf '['
  if [ -n "$firebase_records" ]; then
    while IFS= read -r fprs_record
    do
      [ -n "$fprs_record" ] || continue
      fprs_package=${fprs_record%%|*}
      fprs_app_id=${fprs_record#*|}
      if [ "$fprs_first" = true ]; then
        fprs_first=false
      else
        printf ','
      fi
      if [ -z "$application_id" ]; then
        fprs_matches=null
      elif [ "$fprs_package" = "$application_id" ]; then
        fprs_matches=true
      else
        fprs_matches=false
      fi
      printf '{"package_name":'
      fprs_json_string "$fprs_package" || return 1
      printf ',"app_id":'
      fprs_json_string "$fprs_app_id" || return 1
      printf ',"matches_application_id":%s}' "$fprs_matches"
    done <<EOF
$firebase_records
EOF
  fi
  printf ']'
}

fprs_boolean_human() {
  if [ "$1" = true ]; then
    printf 'yes'
  else
    printf 'no'
  fi
}

fprs_human_unknown() {
  if [ -n "$1" ]; then
    printf '%s' "$1"
  else
    printf 'unknown'
  fi
}

fprs_human_lines() {
  local fprs_lines fprs_empty fprs_result fprs_line
  fprs_lines=$1
  fprs_empty=$2
  fprs_result=
  if [ -n "$fprs_lines" ]; then
    while IFS= read -r fprs_line
    do
      [ -n "$fprs_line" ] || continue
      if [ -z "$fprs_result" ]; then
        fprs_result=$fprs_line
      else
        fprs_result="$fprs_result, $fprs_line"
      fi
    done <<EOF
$fprs_lines
EOF
  fi
  if [ -n "$fprs_result" ]; then
    printf '%s' "$fprs_result"
  else
    printf '%s' "$fprs_empty"
  fi
}

fprs_human_firebase_apps() {
  local fprs_result fprs_record fprs_package fprs_app_id fprs_match
  fprs_result=
  if [ -n "$firebase_records" ]; then
    while IFS= read -r fprs_record
    do
      [ -n "$fprs_record" ] || continue
      fprs_package=${fprs_record%%|*}
      fprs_app_id=${fprs_record#*|}
      if [ -z "$application_id" ]; then
        fprs_match=unknown
      elif [ "$fprs_package" = "$application_id" ]; then
        fprs_match=yes
      else
        fprs_match=no
      fi
      if [ -z "$fprs_result" ]; then
        fprs_result="$fprs_package -> $fprs_app_id (match: $fprs_match)"
      else
        fprs_result="$fprs_result, $fprs_package -> $fprs_app_id (match: $fprs_match)"
      fi
    done <<EOF
$firebase_records
EOF
  fi
  if [ -n "$fprs_result" ]; then
    printf '%s' "$fprs_result"
  else
    printf 'none'
  fi
}

fprs_emit_json() {
  printf '{"schema_version":1,"project_root":'
  fprs_json_string "$project_root" || return 1
  printf ',"flutter_constraint":'
  fprs_json_nullable_string "$flutter_constraint" || return 1
  printf ',"dart_constraint":'
  fprs_json_nullable_string "$dart_constraint" || return 1
  printf ',"flutter_version":'
  fprs_json_nullable_string "$flutter_version" || return 1
  printf ',"android_dsl":'
  fprs_json_string "$android_dsl" || return 1
  printf ',"gradle_file":'
  fprs_json_nullable_string "$gradle_file" || return 1
  printf ',"android_gradle_plugin_version":'
  fprs_json_nullable_string "$android_gradle_plugin_version" || return 1
  printf ',"gradle_wrapper_version":'
  fprs_json_nullable_string "$gradle_wrapper_version" || return 1
  printf ',"java_compatibility":'
  fprs_json_nullable_string "$java_compatibility" || return 1
  printf ',"application_id":'
  fprs_json_nullable_string "$application_id" || return 1
  printf ',"namespace":'
  fprs_json_nullable_string "$namespace" || return 1
  printf ',"application_id_candidates":'
  fprs_json_string_array "$application_id_candidates" || return 1
  printf ',"version_name":'
  fprs_json_nullable_string "$version_name" || return 1
  printf ',"version_code":'
  fprs_json_nullable_string "$version_code" || return 1
  printf ',"pubspec_version_name":'
  fprs_json_nullable_string "$pubspec_version_name" || return 1
  printf ',"pubspec_build_number":'
  fprs_json_nullable_string "$pubspec_build_number" || return 1
  printf ',"flavors":'
  fprs_json_string_array "$flavors" || return 1
  printf ',"selected_flavor":'
  fprs_json_nullable_string "$selected_flavor" || return 1
  printf ',"suggested_flavor":'
  fprs_json_nullable_string "$suggested_flavor" || return 1
  printf ',"suggestion_confirmed":%s,"entrypoints":' "$suggestion_confirmed"
  fprs_json_string_array "$entrypoints" || return 1
  printf ',"build_runner":%s,"fastlane":%s,"github_actions":%s' \
    "$build_runner" "$fastlane" "$github_actions"
  printf ',"release_signing":%s,"release_uses_debug_signing":%s,"firebase":%s' \
    "$release_signing" "$release_uses_debug_signing" "$firebase"
  printf ',"firebase_package_names":'
  fprs_json_string_array "$firebase_package_names" || return 1
  printf ',"firebase_apps":'
  fprs_json_firebase_apps || return 1
  printf ',"firebase_app_distribution":%s,"monorepo":%s,"git_dirty":%s' \
    "$firebase_app_distribution" "$monorepo" "$git_dirty"
  printf ',"files_bootstrap_may_change":'
  fprs_json_string_array "$files_bootstrap_may_change" || return 1
  printf ',"warnings":'
  fprs_json_string_array "$warnings" || return 1
  printf ',"failures":'
  fprs_json_string_array "$failures" || return 1
  printf '}\n'
}

fprs_emit_human() {
  printf 'Flutter project inspection\n'
  printf 'Schema version: 1\n'
  printf 'Project root: %s\n' "$project_root"
  printf 'Flutter constraint: %s\n' "$(fprs_human_unknown "$flutter_constraint")"
  printf 'Dart constraint: %s\n' "$(fprs_human_unknown "$dart_constraint")"
  printf 'Flutter version: %s\n' "$(fprs_human_unknown "$flutter_version")"
  printf 'Android DSL: %s\n' "$android_dsl"
  printf 'Gradle file: %s\n' "$(fprs_human_unknown "$gradle_file")"
  printf 'Android Gradle plugin: %s\n' "$(fprs_human_unknown "$android_gradle_plugin_version")"
  printf 'Gradle wrapper: %s\n' "$(fprs_human_unknown "$gradle_wrapper_version")"
  printf 'Java compatibility: %s\n' "$(fprs_human_unknown "$java_compatibility")"
  printf 'Application ID: %s\n' "$(fprs_human_unknown "$application_id")"
  printf 'Namespace: %s\n' "$(fprs_human_unknown "$namespace")"
  printf 'Application ID candidates: %s\n' "$(fprs_human_lines "$application_id_candidates" none)"
  printf 'Version name: %s\n' "$(fprs_human_unknown "$version_name")"
  printf 'Version code: %s\n' "$(fprs_human_unknown "$version_code")"
  printf 'Pubspec version name: %s\n' "$(fprs_human_unknown "$pubspec_version_name")"
  printf 'Pubspec build number: %s\n' "$(fprs_human_unknown "$pubspec_build_number")"
  printf 'Flavors: %s\n' "$(fprs_human_lines "$flavors" none)"
  printf 'Selected flavor: %s\n' "$(fprs_human_lines "$selected_flavor" none)"
  printf 'Suggested flavor: %s\n' "$(fprs_human_lines "$suggested_flavor" none)"
  printf 'Suggestion confirmed: %s\n' "$(fprs_boolean_human "$suggestion_confirmed")"
  printf 'Entrypoints: %s\n' "$(fprs_human_lines "$entrypoints" none)"
  printf 'Build runner: %s\n' "$(fprs_boolean_human "$build_runner")"
  printf 'Fastlane: %s\n' "$(fprs_boolean_human "$fastlane")"
  printf 'GitHub Actions: %s\n' "$(fprs_boolean_human "$github_actions")"
  printf 'Release signing: %s\n' "$(fprs_boolean_human "$release_signing")"
  printf 'Release uses debug signing: %s\n' "$(fprs_boolean_human "$release_uses_debug_signing")"
  printf 'Firebase: %s\n' "$(fprs_boolean_human "$firebase")"
  printf 'Firebase package names: %s\n' "$(fprs_human_lines "$firebase_package_names" none)"
  printf 'Firebase apps: %s\n' "$(fprs_human_firebase_apps)"
  printf 'Firebase App Distribution: %s\n' "$(fprs_boolean_human "$firebase_app_distribution")"
  printf 'Monorepo: %s\n' "$(fprs_boolean_human "$monorepo")"
  if [ "$git_dirty" = null ]; then
    printf 'Git dirty: unknown\n'
  else
    printf 'Git dirty: %s\n' "$(fprs_boolean_human "$git_dirty")"
  fi
  printf 'Files bootstrap may change: %s\n' "$(fprs_human_lines "$files_bootstrap_may_change" none)"
  printf 'Warnings: %s\n' "$(fprs_human_lines "$warnings" none)"
  printf 'Failures: %s\n' "$(fprs_human_lines "$failures" none)"
}

project_argument=
output_format=human
requested_flavor=
project_seen=false
format_seen=false
flavor_seen=false

while [ "$#" -gt 0 ]
do
  case "$1" in
    --project)
      [ "$project_seen" = false ] || fprs_inspection_argument_error 'duplicate --project option'
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_inspection_argument_error 'missing value for --project'
      project_argument=$2
      project_seen=true
      shift 2
      ;;
    --format)
      [ "$format_seen" = false ] || fprs_inspection_argument_error 'duplicate --format option'
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_inspection_argument_error 'missing value for --format'
      output_format=$2
      format_seen=true
      shift 2
      ;;
    --flavor)
      [ "$flavor_seen" = false ] || fprs_inspection_argument_error 'duplicate --flavor option'
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_inspection_argument_error 'missing value for --flavor'
      requested_flavor=$2
      flavor_seen=true
      shift 2
      ;;
    -h|--help)
      if [ "$#" -ne 1 ] || [ "$project_seen" != false ] ||
        [ "$format_seen" != false ] || [ "$flavor_seen" != false ]
      then
        fprs_inspection_argument_error '--help cannot be combined with other arguments'
      fi
      fprs_inspection_usage
      exit 0
      ;;
    --*) fprs_inspection_argument_error "unknown option: $1" ;;
    *) fprs_inspection_argument_error 'positional arguments are not supported' ;;
  esac
done

[ "$project_seen" = true ] || fprs_inspection_argument_error '--project is required'
case "$output_format" in
  human|json) ;;
  *) fprs_inspection_argument_error '--format must be human or json' ;;
esac
if [ -n "$requested_flavor" ] && ! printf '%s\n' "$requested_flavor" |
  grep -E '^[A-Za-z][A-Za-z0-9_-]*$' >/dev/null 2>&1
then
  fprs_inspection_argument_error '--flavor must be a static Gradle flavor name'
fi

project_root=$(fprs_realpath "$project_argument") ||
  fprs_inspection_root_error 'project path could not be resolved'
[ -d "$project_root" ] || fprs_inspection_root_error 'project path is not a directory'
[ -f "$project_root/pubspec.yaml" ] ||
  fprs_inspection_root_error 'project root must contain pubspec.yaml'
[ -r "$project_root/pubspec.yaml" ] || fprs_die 'project pubspec.yaml is not readable'
[ -d "$project_root/android" ] ||
  fprs_inspection_root_error 'project root must contain android/'
[ -d "$project_root/android/app" ] ||
  fprs_inspection_root_error 'project root must contain android/app/'

groovy_gradle="$project_root/android/app/build.gradle"
kotlin_gradle="$project_root/android/app/build.gradle.kts"
dsl_failure=
if [ -f "$groovy_gradle" ] && [ -f "$kotlin_gradle" ]; then
  android_dsl=ambiguous
  gradle_file=
  gradle_path=
  dsl_failure='android/app contains both build.gradle and build.gradle.kts'
elif [ -f "$groovy_gradle" ]; then
  android_dsl=groovy
  gradle_file=android/app/build.gradle
  gradle_path=$groovy_gradle
elif [ -f "$kotlin_gradle" ]; then
  android_dsl=kotlin
  gradle_file=android/app/build.gradle.kts
  gradle_path=$kotlin_gradle
else
  android_dsl=missing
  gradle_file=
  gradle_path=
  dsl_failure='android/app contains neither build.gradle nor build.gradle.kts'
fi
if [ -n "$gradle_path" ] && [ ! -r "$gradle_path" ]; then
  fprs_die 'selected Android Gradle file is not readable'
fi

warnings=
failures=
inspection_status=0
if [ -n "$dsl_failure" ]; then
  fprs_append_failure "$dsl_failure"
  inspection_status=2
fi

flutter_constraint=$(fprs_pubspec_environment_value "$project_root/pubspec.yaml" flutter)
dart_constraint=$(fprs_pubspec_environment_value "$project_root/pubspec.yaml" sdk)
pubspec_version=$(fprs_pubspec_top_value "$project_root/pubspec.yaml" version)
pubspec_version_name=
pubspec_build_number=
if [ -n "$pubspec_version" ]; then
  case "$pubspec_version" in
    *+*)
      pubspec_version_name=${pubspec_version%%+*}
      pubspec_build_number=${pubspec_version#*+}
      ;;
    *) pubspec_version_name=$pubspec_version ;;
  esac
fi
if [ -n "$flutter_constraint" ] && ! printf '%s\n' "$flutter_constraint" |
  grep -E '^[-0-9A-Za-z<>=~^.*+[:space:]]+$' >/dev/null 2>&1
then
  flutter_constraint=
fi
if [ -n "$dart_constraint" ] && ! printf '%s\n' "$dart_constraint" |
  grep -E '^[-0-9A-Za-z<>=~^.*+[:space:]]+$' >/dev/null 2>&1
then
  dart_constraint=
fi
if [ -n "$pubspec_version_name" ] && ! printf '%s\n' "$pubspec_version_name" |
  grep -E '^[0-9A-Za-z][0-9A-Za-z._+-]*$' >/dev/null 2>&1
then
  pubspec_version_name=
fi
if [ -n "$pubspec_build_number" ] && ! printf '%s\n' "$pubspec_build_number" |
  grep -E '^[0-9]+$' >/dev/null 2>&1
then
  pubspec_build_number=
fi

if fprs_pubspec_has_dependency "$project_root/pubspec.yaml" build_runner
then
  build_runner=true
else
  build_runner=false
fi

flutter_version=
if [ -f "$project_root/.fvmrc" ]; then
  flutter_version=$(fprs_extract_json_string_field "$project_root/.fvmrc" flutter)
elif [ -f "$project_root/.fvm/fvm_config.json" ]; then
  flutter_version=$(fprs_extract_json_string_field \
    "$project_root/.fvm/fvm_config.json" flutterSdkVersion)
fi
if [ -n "$flutter_version" ] && ! printf '%s\n' "$flutter_version" |
  grep -E '^[0-9][0-9A-Za-z._+-]*$' >/dev/null 2>&1
then
  flutter_version=
fi

android_gradle_plugin_version=$(fprs_extract_agp_version)
gradle_wrapper_version=$(fprs_extract_gradle_wrapper_version)
android_records=
[ -z "$gradle_path" ] || android_records=$(fprs_extract_android_records)

java_record=$(printf '%s\n' "$android_records" | awk -F '|' '$1 == "java" { print; exit }')
java_record_rest=${java_record#*|}
java_status=${java_record_rest%%|*}
java_compatibility=${java_record_rest#*|}
if [ "$java_status" = unresolved ]; then
  java_compatibility=
  fprs_append_warning 'Java compatibility expression could not be resolved'
fi

application_id_present=false
namespace_present=false
version_code_present=false
version_name_present=false
base_application_id=
namespace=
version_code=
version_name=
if [ -n "$gradle_path" ]; then
  fprs_gradle_key_present "$gradle_path" namespace && namespace_present=true
  namespace=$(fprs_extract_gradle_literal "$gradle_path" namespace)
fi

application_record=$(printf '%s\n' "$android_records" |
  awk -F '|' '$1 == "default" && $2 == "applicationId" { print; exit }')
application_status=$(printf '%s\n' "$application_record" | awk -F '|' '{ print $3 }')
application_value=$(printf '%s\n' "$application_record" | awk -F '|' '{ print $4 }')
version_code_record=$(printf '%s\n' "$android_records" |
  awk -F '|' '$1 == "default" && $2 == "versionCode" { print; exit }')
version_code_status=$(printf '%s\n' "$version_code_record" | awk -F '|' '{ print $3 }')
version_code_value=$(printf '%s\n' "$version_code_record" | awk -F '|' '{ print $4 }')
version_name_record=$(printf '%s\n' "$android_records" |
  awk -F '|' '$1 == "default" && $2 == "versionName" { print; exit }')
version_name_status=$(printf '%s\n' "$version_name_record" | awk -F '|' '{ print $3 }')
version_name_value=$(printf '%s\n' "$version_name_record" | awk -F '|' '{ print $4 }')

[ -n "$application_status" ] || application_status=absent
[ -n "$version_code_status" ] || version_code_status=absent
[ -n "$version_name_status" ] || version_name_status=absent
[ -n "$java_status" ] || java_status=absent

[ "$application_status" = absent ] || application_id_present=true
[ "$version_code_status" = absent ] || version_code_present=true
[ "$version_name_status" = absent ] || version_name_present=true
if [ "$application_status" = resolved ]; then
  base_application_id=$application_value
fi
case "$version_code_status" in
  resolved) version_code=$version_code_value ;;
  gradle)
    version_code_property=$(fprs_read_property \
      "$project_root/android/gradle.properties" VERSION_CODE)
    version_code_property_status=${version_code_property%%|*}
    if [ "$version_code_property_status" = resolved ]; then
      version_code=${version_code_property#*|}
    fi
    ;;
  flutter)
    version_code_property=$(fprs_read_property \
      "$project_root/android/local.properties" flutter.versionCode)
    version_code_property_status=${version_code_property%%|*}
    if [ "$version_code_property_status" = resolved ]; then
      version_code=${version_code_property#*|}
    elif [ "$version_code_property_status" = absent ]; then
      version_code=$pubspec_build_number
    fi
    ;;
esac
case "$version_name_status" in
  resolved) version_name=$version_name_value ;;
  gradle)
    version_name_property=$(fprs_read_property \
      "$project_root/android/gradle.properties" VERSION_NAME)
    version_name_property_status=${version_name_property%%|*}
    if [ "$version_name_property_status" = resolved ]; then
      version_name=${version_name_property#*|}
    fi
    ;;
  flutter)
    version_name_property=$(fprs_read_property \
      "$project_root/android/local.properties" flutter.versionName)
    version_name_property_status=${version_name_property%%|*}
    if [ "$version_name_property_status" = resolved ]; then
      version_name=${version_name_property#*|}
    elif [ "$version_name_property_status" = absent ]; then
      version_name=$pubspec_version_name
    fi
    ;;
esac

if [ -n "$base_application_id" ] && ! printf '%s\n' "$base_application_id" |
  grep -E '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$' >/dev/null 2>&1
then
  base_application_id=
fi
if [ -n "$namespace" ] && ! printf '%s\n' "$namespace" |
  grep -E '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$' >/dev/null 2>&1
then
  namespace=
fi

if [ -n "$version_name" ] && ! printf '%s\n' "$version_name" |
  grep -E '^[0-9A-Za-z][0-9A-Za-z._+-]*$' >/dev/null 2>&1
then
  version_name=
fi
if [ -n "$version_code" ] && ! printf '%s\n' "$version_code" |
  grep -E '^[0-9]+$' >/dev/null 2>&1
then
  version_code=
fi

[ "$application_id_present" = false ] || [ -n "$base_application_id" ] ||
  fprs_append_warning 'application ID expression could not be resolved'
[ "$namespace_present" = false ] || [ -n "$namespace" ] ||
  fprs_append_warning 'namespace expression could not be resolved'
[ "$version_code_present" = false ] || [ -n "$version_code" ] ||
  fprs_append_warning 'version code expression could not be resolved'
[ "$version_name_present" = false ] || [ -n "$version_name" ] ||
  fprs_append_warning 'version name expression could not be resolved'

flavor_records=
[ -z "$gradle_path" ] || flavor_records=$(printf '%s\n' "$android_records" | awk -F '|' '
  $1 == "flavor" { print $2 "|" $3 "|" $4 "|" $5 "|" $6 }
' | LC_ALL=C sort -t '|' -k1,1)
flavors=$(printf '%s\n' "$flavor_records" | awk -F '|' 'NF && $1 != "" { print $1 }')
flavor_count=$(fprs_line_count "$flavors")
product_flavor_state=$(printf '%s\n' "$android_records" |
  awk -F '|' '$1 == "flavor_state" { print; exit }')
[ -n "$product_flavor_state" ] || product_flavor_state='flavor_state|absent|0|0|0'
product_flavor_state_rest=${product_flavor_state#*|}
product_flavor_presence=${product_flavor_state_rest%%|*}
product_flavor_state_rest=${product_flavor_state_rest#*|}
resolved_flavor_declaration_count=${product_flavor_state_rest%%|*}
product_flavor_state_rest=${product_flavor_state_rest#*|}
unresolved_flavor_declaration_count=${product_flavor_state_rest%%|*}
unresolved_flavor_identity_count=${product_flavor_state_rest##*|}
unresolved_flavor_declarations=false
if [ "$unresolved_flavor_declaration_count" -gt 0 ] ||
  [ "$resolved_flavor_declaration_count" -ne "$flavor_count" ]
then
  unresolved_flavor_declarations=true
  fprs_append_warning 'product flavor declarations could not be resolved'
fi
unresolved_flavor_identity=false
[ "$unresolved_flavor_identity_count" -eq 0 ] || unresolved_flavor_identity=true
flavor_dimension_records=
[ -z "$gradle_path" ] || flavor_dimension_records=$(fprs_extract_flavor_dimensions)
flavor_dimensions=$(printf '%s\n' "$flavor_dimension_records" |
  awk '$0 != "?" && NF { print }')
flavor_dimension_count=$(fprs_line_count "$flavor_dimensions")
ambiguous_flavor_dimensions=false
if printf '%s\n' "$flavor_dimension_records" | grep -F -x '?' >/dev/null 2>&1; then
  ambiguous_flavor_dimensions=true
  fprs_append_warning 'flavor dimension expressions prevent deterministic application ID resolution'
elif [ "$flavor_dimension_count" -gt 1 ]; then
  ambiguous_flavor_dimensions=true
  fprs_append_warning 'multiple flavor dimensions prevent deterministic application ID resolution'
fi

release_application_id_suffix_record='absent|'
[ -z "$gradle_path" ] || release_application_id_suffix_record=$(printf '%s\n' "$android_records" |
  awk -F '|' '$1 == "release_suffix" { print $2 "|" $3; exit }')
[ -n "$release_application_id_suffix_record" ] || release_application_id_suffix_record='absent|'
release_application_id_suffix_status=${release_application_id_suffix_record%%|*}
release_application_id_suffix=${release_application_id_suffix_record#*|}
if [ "$release_application_id_suffix_status" = unresolved ]; then
  fprs_append_warning 'release application ID suffix expression could not be resolved'
fi

entrypoints=$(
  for entrypoint_path in "$project_root"/lib/main*.dart
  do
    [ -f "$entrypoint_path" ] || continue
    printf 'lib/%s\n' "${entrypoint_path##*/}"
  done | LC_ALL=C sort -u
)

suggested_flavor=
suggested_matches=
if [ -n "$flavors" ]; then
  while IFS= read -r flavor_name
  do
    [ -n "$flavor_name" ] || continue
    if [ -f "$project_root/lib/main_$flavor_name.dart" ]; then
      if [ -z "$suggested_matches" ]; then
        suggested_matches=$flavor_name
      else
        suggested_matches="$suggested_matches
$flavor_name"
      fi
    fi
  done <<EOF
$flavors
EOF
fi
if [ "$(fprs_line_count "$suggested_matches")" -eq 1 ]; then
  suggested_flavor=$suggested_matches
fi

application_id_candidates=
flavor_candidate_records=
if [ "$flavor_count" -eq 0 ]; then
  if [ "$unresolved_flavor_declarations" = false ] &&
    [ "$release_application_id_suffix_status" != unresolved ] &&
    [ -n "$base_application_id" ]
  then
    application_id_candidates="$base_application_id$release_application_id_suffix"
  fi
else
  candidate_lines=
  while IFS= read -r flavor_record
  do
    [ -n "$flavor_record" ] || continue
    flavor_name=${flavor_record%%|*}
    flavor_rest=${flavor_record#*|}
    flavor_suffix_status=${flavor_rest%%|*}
    flavor_rest=${flavor_rest#*|}
    flavor_suffix=${flavor_rest%%|*}
    flavor_rest=${flavor_rest#*|}
    flavor_override_status=${flavor_rest%%|*}
    flavor_override=${flavor_rest#*|}
    flavor_candidate_status=resolved

    case "$flavor_override_status" in
      resolved) flavor_candidate_base=$flavor_override ;;
      absent) flavor_candidate_base=$base_application_id ;;
      *)
        flavor_candidate_base=
        flavor_candidate_status=unresolved
        fprs_append_warning "application ID expression could not be resolved for flavor $flavor_name"
        ;;
    esac
    if [ "$flavor_suffix_status" = unresolved ]; then
      flavor_candidate_status=unresolved
      fprs_append_warning "application ID suffix expression could not be resolved for flavor $flavor_name"
    fi
    if [ -z "$flavor_candidate_base" ]; then
      flavor_candidate_status=unresolved
    fi
    if [ "$ambiguous_flavor_dimensions" = true ]; then
      flavor_candidate_status=unresolved
    fi
    if [ "$unresolved_flavor_declarations" = true ] ||
      [ "$unresolved_flavor_identity" = true ] ||
      [ "$release_application_id_suffix_status" = unresolved ]
    then
      flavor_candidate_status=unresolved
    fi

    flavor_candidate=
    if [ "$flavor_candidate_status" = resolved ]; then
      flavor_candidate="$flavor_candidate_base$flavor_suffix$release_application_id_suffix"
      if [ -z "$candidate_lines" ]; then
        candidate_lines=$flavor_candidate
      else
        candidate_lines="$candidate_lines
$flavor_candidate"
      fi
    fi
    flavor_candidate_record="$flavor_name|$flavor_candidate|$flavor_candidate_status"
    if [ -z "$flavor_candidate_records" ]; then
      flavor_candidate_records=$flavor_candidate_record
    else
      flavor_candidate_records="$flavor_candidate_records
$flavor_candidate_record"
    fi
  done <<EOF
$flavor_records
EOF
  application_id_candidates=$(printf '%s\n' "$candidate_lines" |
    awk 'NF && !seen[$0]++ { print }' | LC_ALL=C sort)
fi

selected_flavor=
suggestion_confirmed=false
application_id=
if [ -n "$requested_flavor" ]; then
  if selected_record=$(fprs_flavor_record "$requested_flavor"); then
    selected_flavor=$requested_flavor
    selected_candidate_record=$(printf '%s\n' "$flavor_candidate_records" |
      awk -F '|' -v target="$requested_flavor" '$1 == target { print; exit }')
    selected_candidate_rest=${selected_candidate_record#*|}
    selected_candidate=${selected_candidate_rest%%|*}
    selected_candidate_status=${selected_candidate_rest##*|}
    if [ "$selected_candidate_status" = resolved ]; then
      application_id=$selected_candidate
    fi
    if [ "$ambiguous_flavor_dimensions" = true ]; then
      fprs_append_failure 'multiple flavor dimensions require manual variant confirmation'
      inspection_status=2
    fi
  else
    fprs_append_failure 'requested flavor is not defined'
    inspection_status=2
  fi
elif [ "$flavor_count" -gt 1 ]; then
  fprs_append_failure 'multiple product flavors require --flavor'
  inspection_status=2
elif [ -n "$application_id_candidates" ]; then
  application_id=$(printf '%s\n' "$application_id_candidates" | sed -n '1p')
fi

if [ -n "$base_application_id" ] && [ -n "$namespace" ] &&
  [ "$base_application_id" != "$namespace" ]
then
  fprs_append_warning 'namespace differs from default application ID'
fi

release_signing_reference=
[ -z "$gradle_path" ] || release_signing_reference=$(printf '%s\n' "$android_records" |
  awk -F '|' '$1 == "release_signing" { print $2; exit }')
case "$release_signing_reference" in
  release)
    release_signing=true
    release_uses_debug_signing=false
    ;;
  debug)
    release_signing=false
    release_uses_debug_signing=true
    fprs_append_warning 'release build type uses debug signing'
    ;;
  unknown)
    release_signing=false
    release_uses_debug_signing=false
    fprs_append_warning 'release signing expression could not be resolved'
    ;;
  *)
    release_signing=false
    release_uses_debug_signing=false
    ;;
esac

if [ -d "$project_root/android/fastlane" ]; then
  fastlane=true
else
  fastlane=false
fi

github_actions=false
for workflow_path in \
  "$project_root/.github/workflows/"*.yml \
  "$project_root/.github/workflows/"*.yaml
do
  if [ -f "$workflow_path" ]; then
    github_actions=true
    break
  fi
done

firebase=false
firebase_records=
for firebase_file in \
  "$project_root/android/app/google-services.json" \
  "$project_root/android/app/src/"*/google-services.json
do
  [ -f "$firebase_file" ] || continue
  firebase=true
  firebase_file_records=$(fprs_extract_firebase_records "$firebase_file")
  [ -n "$firebase_file_records" ] || continue
  if [ -z "$firebase_records" ]; then
    firebase_records=$firebase_file_records
  else
    firebase_records="$firebase_records
$firebase_file_records"
  fi
done
firebase_records=$(printf '%s\n' "$firebase_records" | awk 'NF && !seen[$0]++ { print }')
firebase_package_names=$(printf '%s\n' "$firebase_records" | awk -F '|' '
  NF && $1 != "" && !seen[$1]++ { print $1 }
')
if [ "$firebase" = true ] && [ -z "$firebase_records" ]; then
  fprs_append_warning 'Firebase client mappings could not be resolved'
fi
if [ "$firebase" = true ] && [ -n "$application_id" ] &&
  ! printf '%s\n' "$firebase_package_names" | grep -F -x "$application_id" >/dev/null 2>&1
then
  fprs_append_warning 'Firebase has no client for selected application ID'
fi

firebase_app_distribution=false
for firebase_distribution_file in \
  "$project_root/android/fastlane/Fastfile" \
  "$project_root/android/fastlane/Pluginfile" \
  "$project_root/android/Gemfile"
do
  [ -f "$firebase_distribution_file" ] || continue
  if grep -F 'firebase_app_distribution' "$firebase_distribution_file" >/dev/null 2>&1; then
    firebase_app_distribution=true
    break
  fi
done

monorepo=false
monorepo_cursor=$project_root
while :
do
  if [ -f "$monorepo_cursor/melos.yaml" ] || [ -f "$monorepo_cursor/melos.yml" ]; then
    monorepo=true
    break
  fi
  if [ -f "$monorepo_cursor/pubspec.yaml" ] &&
    grep -E '^workspace[[:space:]]*:' "$monorepo_cursor/pubspec.yaml" >/dev/null 2>&1
  then
    monorepo=true
    break
  fi
  [ "$monorepo_cursor" != / ] || break
  monorepo_parent=${monorepo_cursor%/*}
  [ -n "$monorepo_parent" ] || monorepo_parent=/
  [ "$monorepo_parent" != "$monorepo_cursor" ] || break
  monorepo_cursor=$monorepo_parent
done

git_dirty=null
if command -v git >/dev/null 2>&1 &&
  GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C "$project_root" \
    rev-parse --is-inside-work-tree \
    >/dev/null 2>&1
then
  if git_status_output=$(GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false \
    -C "$project_root" status --porcelain --untracked-files=normal -- . 2>/dev/null)
  then
    if [ -n "$git_status_output" ]; then
      git_dirty=true
    else
      git_dirty=false
    fi
  else
    git_dirty=null
  fi
fi

files_bootstrap_may_change='android/Gemfile
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
.gitignore'
if [ -n "$gradle_file" ]; then
  files_bootstrap_may_change="$files_bootstrap_may_change
$gradle_file"
fi

case "$output_format" in
  json) fprs_emit_json || fprs_die 'could not emit inspection JSON' ;;
  human) fprs_emit_human || fprs_die 'could not emit inspection report' ;;
esac

if [ "$inspection_status" -eq 2 ]; then
  printf 'ERROR: %s\n' "$(printf '%s\n' "$failures" | sed -n '1p')" >&2
fi
exit "$inspection_status"
