#!/usr/bin/env bash
# Provide Android Gradle signing inspection and configuration primitives.

FPRS_GRADLE_SIGNING_CLASSIFICATION=

fprs_gradle_signing_error() {
  printf 'ERROR: Gradle signing planner: %s\n' "$*" >&2
}

fprs_gradle_signing_task_requires_credentials() {
  [ "$#" -gt 0 ] || return 1
  local fprs_gradle_requested fprs_gradle_direct
  for fprs_gradle_requested in "$@"
  do
    fprs_gradle_direct=${fprs_gradle_requested##*:}
    fprs_gradle_direct=$(printf '%s' "$fprs_gradle_direct" |
      tr '[:upper:]' '[:lower:]') || return 1
    case "$fprs_gradle_direct" in
      assemble*release|bundle*release|publish*release*) return 0 ;;
    esac
  done
  return 1
}

fprs_gradle_signing_properties_path() {
  [ "$#" -eq 1 ] && [ -n "$1" ] || return 2
  if [ "${ANDROID_KEY_PROPERTIES_PATH+x}" = x ]; then
    printf '%s\n' "$ANDROID_KEY_PROPERTIES_PATH"
  else
    printf '%s/key.properties\n' "${1%/}"
  fi
}

fprs_gradle_signing_property_value() {
  [ "$#" -eq 2 ] || return 1
  awk -v target="$2" '
    /^[[:space:]]*[#!]/ { next }
    {
      line = $0
      sub(/\r$/, "", line)
      separator = index(line, "=")
      if (!separator) next
      key = substr(line, 1, separator - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key != target) next
      count++
      value = substr(line, separator + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      selected = value
    }
    END {
      if (count != 1 || selected == "") exit 1
      print selected
    }
  ' "$1"
}

fprs_gradle_signing_guard_check() {
  [ "$#" -eq 3 ] || return 2
  local fprs_gradle_task fprs_gradle_properties fprs_gradle_app_dir
  local fprs_gradle_store_file fprs_gradle_store_password
  local fprs_gradle_key_alias fprs_gradle_key_password fprs_gradle_keystore
  fprs_gradle_task=$1
  fprs_gradle_properties=$2
  fprs_gradle_app_dir=$3
  fprs_gradle_signing_task_requires_credentials "$fprs_gradle_task" || return 0
  if [ ! -f "$fprs_gradle_properties" ] || [ -L "$fprs_gradle_properties" ]; then
    printf 'ERROR: Android release signing properties file is missing\n' >&2
    return 1
  fi
  fprs_gradle_store_file=$(fprs_gradle_signing_property_value \
    "$fprs_gradle_properties" storeFile) || {
    printf 'ERROR: Android release signing properties are incomplete\n' >&2
    return 1
  }
  fprs_gradle_store_password=$(fprs_gradle_signing_property_value \
    "$fprs_gradle_properties" storePassword) || {
    printf 'ERROR: Android release signing properties are incomplete\n' >&2
    return 1
  }
  fprs_gradle_key_alias=$(fprs_gradle_signing_property_value \
    "$fprs_gradle_properties" keyAlias) || {
    printf 'ERROR: Android release signing properties are incomplete\n' >&2
    return 1
  }
  fprs_gradle_key_password=$(fprs_gradle_signing_property_value \
    "$fprs_gradle_properties" keyPassword) || {
    printf 'ERROR: Android release signing properties are incomplete\n' >&2
    return 1
  }
  # Keep all secret values in local variables and never interpolate them into output.
  [ -n "$fprs_gradle_store_password" ] && [ -n "$fprs_gradle_key_alias" ] &&
    [ -n "$fprs_gradle_key_password" ] || return 1
  case "$fprs_gradle_store_file" in
    /*) fprs_gradle_keystore=$fprs_gradle_store_file ;;
    *) fprs_gradle_keystore="${fprs_gradle_app_dir%/}/$fprs_gradle_store_file" ;;
  esac
  if [ ! -f "$fprs_gradle_keystore" ]; then
    printf 'ERROR: Android release keystore file is missing\n' >&2
    return 1
  fi
  return 0
}

fprs_gradle_signing_validate_emitted_guard() {
  [ "$#" -eq 2 ] && [ -f "$2" ] && [ ! -L "$2" ] || return 2
  case "$1" in groovy|kotlin) ;; *) return 2 ;; esac
  local fprs_gradle_guard_report fprs_gradle_guard_marker_status
  local fprs_gradle_guard_begin fprs_gradle_guard_end
  fprs_gradle_guard_report=$(mktemp \
    "${TMPDIR:-/tmp}/.fprs-gradle-guard.XXXXXX" 2>/dev/null) || return 1
  if fprs_gradle_signing_validate_markers "$2" "$fprs_gradle_guard_report"; then
    fprs_gradle_guard_marker_status=0
  else
    fprs_gradle_guard_marker_status=$?
  fi
  if [ "$fprs_gradle_guard_marker_status" -ne 10 ]; then
    rm -f -- "$fprs_gradle_guard_report"
    return 2
  fi
  fprs_gradle_guard_begin=$(sed -n '1p' "$fprs_gradle_guard_report")
  fprs_gradle_guard_end=$(sed -n '2p' "$fprs_gradle_guard_report")
  rm -f -- "$fprs_gradle_guard_report"
  case "$fprs_gradle_guard_begin:$fprs_gradle_guard_end" in
    *[!0-9:]*|:|*:|:*) return 2 ;;
  esac
  [ "$fprs_gradle_guard_begin" -lt "$fprs_gradle_guard_end" ] || return 2
  awk -v dsl="$1" -v begin="$fprs_gradle_guard_begin" \
      -v end="$fprs_gradle_guard_end" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function brace_delta(value,    i, character, opens, closes, quote, escaped) {
      opens = closes = 0
      quote = ""
      escaped = 0
      for (i = 1; i <= length(value); i++) {
        character = substr(value, i, 1)
        if (quote != "") {
          if (escaped) escaped = 0
          else if (character == "\\") escaped = 1
          else if (character == quote) quote = ""
        } else if (character == "\"" || character == "\047") {
          quote = character
        } else if (character == "{") opens++
        else if (character == "}") closes++
      }
      return opens - closes
    }
    function inside_release_guard(before,    guard) {
      for (guard in release_guard_depth) {
        if (before >= guard) return 1
      }
      return 0
    }
    {
      if (NR <= begin || NR >= end) next
      line = $0
      sub(/\r$/, "", line)
      stripped = trim(line)
      before_depth = depth
      if (stripped ~ /^(def|val)[[:space:]]+fprsReleaseSigningTaskRequested[[:space:]]*=[[:space:]]*gradle\.startParameter\.taskNames\.any[[:space:]]*\{[[:space:]]*fprsRequestedTask[[:space:]]*->[[:space:]]*$/) {
        task_any_count++
      }
      if (stripped ~ /^(def|val)[[:space:]]+fprsDirectTask[[:space:]]*=.*fprsRequestedTask.*Locale\.ROOT/) {
        direct_task_count++
      }
      if (stripped ~ /fprsTerminalTaskPrefixes\.any[[:space:]]*\{.*fprsDirectTask\.startsWith\(fprsPrefix\).*&&.*fprsDirectTask\.endsWith\(fprsReleaseToken\).*\}[[:space:]]*\|\|[[:space:]]*$/) {
        terminal_pattern_count++
      }
      if (stripped ~ /fprsContainingTaskPrefixes\.any[[:space:]]*\{.*fprsDirectTask\.startsWith\(fprsPrefix\).*&&.*fprsDirectTask\.contains\(fprsReleaseToken\).*\}[[:space:]]*$/) {
        containing_pattern_count++
      }
      if (stripped == "if (fprsReleaseSigningTaskRequested) {") {
        positive_guard_count++
        release_guard_depth[before_depth + 1] = 1
      }
      if (stripped ~ /fprsKeyProperties\.load\(fprsInput\)/) {
        load_count++
        if (inside_release_guard(before_depth)) guarded_load_count++
      }
      if (stripped ~ /^if \(!fprsKeyPropertiesFile\.isFile(\(\))?\) \{$/) {
        missing_file_check_count++
        if (inside_release_guard(before_depth)) guarded_check_count++
      }
      if (stripped == "if (!fprsSigningValuesComplete) {") {
        incomplete_check_count++
        if (inside_release_guard(before_depth)) guarded_check_count++
      }
      if (stripped ~ /^if \(!file\(fprsStoreFileValue(!{0,2})\)\.isFile(\(\))?\) \{$/) {
        keystore_check_count++
        if (inside_release_guard(before_depth)) guarded_check_count++
      }

      depth += brace_delta(line)
      if (depth < 0) malformed = 1
      for (guard in release_guard_depth) {
        if (depth < guard) delete release_guard_depth[guard]
      }
    }
    END {
      if (depth != 0 || malformed ||
          task_any_count != 1 || direct_task_count != 1 ||
          terminal_pattern_count != 1 || containing_pattern_count != 1 ||
          positive_guard_count != 2 || load_count != 1 ||
          guarded_load_count != 1 || missing_file_check_count != 1 ||
          incomplete_check_count != 1 || keystore_check_count != 1 ||
          guarded_check_count != 3) exit 2
    }
  ' "$2"
}

fprs_gradle_signing_extract_emitted_contract() {
  [ "$#" -eq 2 ] && [ -f "$1" ] && [ ! -L "$1" ] || return 2
  awk '
    function quoted_csv(value,    result, token) {
      result = ""
      while (match(value, /"[A-Za-z][A-Za-z0-9_]*"/)) {
        token = substr(value, RSTART + 1, RLENGTH - 2)
        result = result (result == "" ? "" : ",") token
        value = substr(value, RSTART + RLENGTH)
      }
      return result
    }
    function quoted_value(value) {
      if (!match(value, /"[A-Za-z][A-Za-z0-9_.-]*"/)) return ""
      return substr(value, RSTART + 1, RLENGTH - 2)
    }
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /^[[:space:]]*(def|val)[[:space:]]+fprsTerminalTaskPrefixes[[:space:]]*=/) {
        terminal_count++
        terminal = quoted_csv(line)
      } else if (line ~ /^[[:space:]]*(def|val)[[:space:]]+fprsContainingTaskPrefixes[[:space:]]*=/) {
        containing_count++
        containing = quoted_csv(line)
      } else if (line ~ /^[[:space:]]*(def|val)[[:space:]]+fprsReleaseToken[[:space:]]*=/) {
        token_count++
        release_token = quoted_value(line)
      } else if (line ~ /^[[:space:]]*(def|val)[[:space:]]+fprsSigningPropertyKeys[[:space:]]*=/) {
        keys_count++
        keys = quoted_csv(line)
      } else if (line ~ /^[[:space:]]*(def|val)[[:space:]]+fprsPropertiesEnvironment[[:space:]]*=/) {
        environment_count++
        environment = quoted_value(line)
      } else if (line ~ /^[[:space:]]*(def|val)[[:space:]]+fprsPropertiesFallback[[:space:]]*=/) {
        fallback_count++
        fallback = quoted_value(line)
      }
    }
    END {
      if (terminal_count != 1 || containing_count != 1 || token_count != 1 ||
          keys_count != 1 || environment_count != 1 || fallback_count != 1 ||
          terminal == "" || containing == "" || release_token == "" ||
          keys == "" || environment == "" || fallback == "") exit 2
      print "terminal_task_prefixes=" terminal
      print "containing_task_prefixes=" containing
      print "release_token=" release_token
      print "property_keys=" keys
      print "properties_environment=" environment
      print "properties_fallback=" fallback
    }
  ' "$1" > "$2"
}

fprs_gradle_signing_contract_value() {
  [ "$#" -eq 2 ] || return 2
  awk -F= -v key="$1" '
    $1 == key { count++; value = substr($0, length(key) + 2) }
    END { if (count != 1 || value == "") exit 1; print value }
  ' "$2"
}

fprs_gradle_signing_contract_task_requires_credentials() {
  [ "$#" -gt 1 ] || return 1
  local fprs_gradle_contract fprs_gradle_terminal fprs_gradle_containing
  local fprs_gradle_token fprs_gradle_requested fprs_gradle_direct
  local fprs_gradle_prefix
  fprs_gradle_contract=$1
  shift
  fprs_gradle_terminal=$(fprs_gradle_signing_contract_value \
    terminal_task_prefixes "$fprs_gradle_contract") || return 2
  fprs_gradle_containing=$(fprs_gradle_signing_contract_value \
    containing_task_prefixes "$fprs_gradle_contract") || return 2
  fprs_gradle_token=$(fprs_gradle_signing_contract_value \
    release_token "$fprs_gradle_contract") || return 2
  fprs_gradle_terminal=$(printf '%s' "$fprs_gradle_terminal" | tr ',' ' ')
  fprs_gradle_containing=$(printf '%s' "$fprs_gradle_containing" | tr ',' ' ')
  for fprs_gradle_requested in "$@"
  do
    fprs_gradle_direct=${fprs_gradle_requested##*:}
    fprs_gradle_direct=$(printf '%s' "$fprs_gradle_direct" |
      tr '[:upper:]' '[:lower:]') || return 2
    for fprs_gradle_prefix in $fprs_gradle_terminal
    do
      case "$fprs_gradle_direct" in
        "$fprs_gradle_prefix"*"$fprs_gradle_token") return 0 ;;
      esac
    done
    for fprs_gradle_prefix in $fprs_gradle_containing
    do
      case "$fprs_gradle_direct" in
        "$fprs_gradle_prefix"*"$fprs_gradle_token"*) return 0 ;;
      esac
    done
  done
  return 1
}

fprs_gradle_signing_contract_properties_path() {
  [ "$#" -eq 2 ] && [ -n "$2" ] || return 2
  local fprs_gradle_contract_environment fprs_gradle_contract_fallback
  local fprs_gradle_contract_override
  fprs_gradle_contract_environment=$(fprs_gradle_signing_contract_value \
    properties_environment "$1") || return 2
  fprs_gradle_contract_fallback=$(fprs_gradle_signing_contract_value \
    properties_fallback "$1") || return 2
  case "$fprs_gradle_contract_environment" in
    [A-Za-z_]* ) ;;
    *) return 2 ;;
  esac
  case "$fprs_gradle_contract_environment" in *[!A-Za-z0-9_]*) return 2 ;; esac
  case "$fprs_gradle_contract_fallback" in
    ''|/*|*/*|.|..) return 2 ;;
  esac
  if fprs_gradle_contract_override=$(printenv \
    "$fprs_gradle_contract_environment" 2>/dev/null)
  then
    printf '%s\n' "$fprs_gradle_contract_override"
  else
    printf '%s/%s\n' "${2%/}" "$fprs_gradle_contract_fallback"
  fi
}

fprs_gradle_signing_contract_guard_check() {
  [ "$#" -eq 3 ] || return 2
  local fprs_gradle_contract fprs_gradle_task fprs_gradle_android_root
  local fprs_gradle_properties fprs_gradle_keys fprs_gradle_key
  local fprs_gradle_values fprs_gradle_store_file fprs_gradle_keystore
  local fprs_gradle_task_status
  fprs_gradle_contract=$1
  fprs_gradle_task=$2
  fprs_gradle_android_root=$3
  if fprs_gradle_signing_contract_task_requires_credentials \
    "$fprs_gradle_contract" "$fprs_gradle_task"
  then
    :
  else
    fprs_gradle_task_status=$?
    [ "$fprs_gradle_task_status" -eq 1 ] && return 0
    return 2
  fi
  fprs_gradle_properties=$(fprs_gradle_signing_contract_properties_path \
    "$fprs_gradle_contract" "$fprs_gradle_android_root") || return 2
  if [ ! -f "$fprs_gradle_properties" ] || [ -L "$fprs_gradle_properties" ]; then
    printf 'ERROR: Android release signing properties file is missing\n' >&2
    return 1
  fi
  fprs_gradle_keys=$(fprs_gradle_signing_contract_value \
    property_keys "$fprs_gradle_contract") || return 2
  fprs_gradle_keys=$(printf '%s' "$fprs_gradle_keys" | tr ',' ' ')
  set -- $fprs_gradle_keys
  [ "$#" -eq 4 ] || return 2
  fprs_gradle_values=
  for fprs_gradle_key in "$@"
  do
    case "$fprs_gradle_key" in [A-Za-z]* ) ;; *) return 2 ;; esac
    case "$fprs_gradle_key" in *[!A-Za-z0-9_]*) return 2 ;; esac
    fprs_gradle_key=$(fprs_gradle_signing_property_value \
      "$fprs_gradle_properties" "$fprs_gradle_key") || {
      printf 'ERROR: Android release signing properties are incomplete\n' >&2
      return 1
    }
    if [ -z "$fprs_gradle_values" ]; then
      fprs_gradle_store_file=$fprs_gradle_key
    fi
    fprs_gradle_values="$fprs_gradle_values x"
  done
  case "$fprs_gradle_store_file" in
    /*) fprs_gradle_keystore=$fprs_gradle_store_file ;;
    *) fprs_gradle_keystore="${fprs_gradle_android_root%/}/app/$fprs_gradle_store_file" ;;
  esac
  if [ ! -f "$fprs_gradle_keystore" ]; then
    printf 'ERROR: Android release keystore file is missing\n' >&2
    return 1
  fi
  return 0
}

fprs_gradle_signing_file_mode() {
  [ "$#" -eq 1 ] && [ -e "$1" ] || return 1
  local fprs_gradle_mode
  if fprs_gradle_mode=$(stat -c '%a' "$1" 2>/dev/null) &&
    case "$fprs_gradle_mode" in ''|*[!0-7]*) false ;; *) true ;; esac
  then
    :
  elif fprs_gradle_mode=$(stat -f '%Lp' "$1" 2>/dev/null) &&
    case "$fprs_gradle_mode" in ''|*[!0-7]*) false ;; *) true ;; esac
  then
    :
  else
    return 1
  fi
  printf '%s\n' "$fprs_gradle_mode"
}

fprs_gradle_signing_groovy_block() {
  cat <<'GRADLE'
    // BEGIN flutter-play-store-release schema=1
    def fprsTerminalTaskPrefixes = ["assemble", "bundle"]
    def fprsContainingTaskPrefixes = ["publish"]
    def fprsReleaseToken = "release"
    def fprsSigningPropertyKeys = ["storeFile", "storePassword", "keyAlias", "keyPassword"]
    def fprsPropertiesEnvironment = "ANDROID_KEY_PROPERTIES_PATH"
    def fprsPropertiesFallback = "key.properties"
    def fprsKeyPropertiesPath = providers.environmentVariable(fprsPropertiesEnvironment).orNull
    def fprsKeyPropertiesFile = fprsKeyPropertiesPath != null ? file(fprsKeyPropertiesPath) : rootProject.file(fprsPropertiesFallback)
    def fprsReleaseSigningTaskRequested = gradle.startParameter.taskNames.any { fprsRequestedTask ->
        def fprsDirectTask = fprsRequestedTask.tokenize(":").last().toLowerCase(java.util.Locale.ROOT)
        fprsTerminalTaskPrefixes.any { fprsPrefix -> fprsDirectTask.startsWith(fprsPrefix) && fprsDirectTask.endsWith(fprsReleaseToken) } ||
            fprsContainingTaskPrefixes.any { fprsPrefix -> fprsDirectTask.startsWith(fprsPrefix) && fprsDirectTask.contains(fprsReleaseToken) }
    }
    def fprsKeyProperties = new java.util.Properties()
    if (fprsReleaseSigningTaskRequested) {
        if (fprsKeyPropertiesFile.isFile()) {
            fprsKeyPropertiesFile.withInputStream { fprsInput -> fprsKeyProperties.load(fprsInput) }
        }
    }
    def fprsStoreFileValue = fprsKeyProperties.getProperty(fprsSigningPropertyKeys[0])
    def fprsStorePasswordValue = fprsKeyProperties.getProperty(fprsSigningPropertyKeys[1])
    def fprsKeyAliasValue = fprsKeyProperties.getProperty(fprsSigningPropertyKeys[2])
    def fprsKeyPasswordValue = fprsKeyProperties.getProperty(fprsSigningPropertyKeys[3])
    def fprsSigningValuesComplete = [fprsStoreFileValue, fprsStorePasswordValue, fprsKeyAliasValue, fprsKeyPasswordValue].every {
        fprsValue -> fprsValue != null && !fprsValue.trim().isEmpty()
    }
    if (fprsReleaseSigningTaskRequested) {
        if (!fprsKeyPropertiesFile.isFile()) {
            throw new GradleException("Android release signing properties file is missing")
        }
        if (!fprsSigningValuesComplete) {
            throw new GradleException("Android release signing properties are incomplete")
        }
        if (!file(fprsStoreFileValue).isFile()) {
            throw new GradleException("Android release keystore file is missing")
        }
    }
    signingConfigs {
        release {
            if (fprsSigningValuesComplete) {
                storeFile file(fprsStoreFileValue)
                storePassword fprsStorePasswordValue
                keyAlias fprsKeyAliasValue
                keyPassword fprsKeyPasswordValue
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
    // END flutter-play-store-release
GRADLE
}

fprs_gradle_signing_kotlin_block() {
  cat <<'KOTLIN'
    // BEGIN flutter-play-store-release schema=1
    val fprsTerminalTaskPrefixes = listOf("assemble", "bundle")
    val fprsContainingTaskPrefixes = listOf("publish")
    val fprsReleaseToken = "release"
    val fprsSigningPropertyKeys = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
    val fprsPropertiesEnvironment = "ANDROID_KEY_PROPERTIES_PATH"
    val fprsPropertiesFallback = "key.properties"
    val fprsKeyPropertiesPath = providers.environmentVariable(fprsPropertiesEnvironment).orNull
    val fprsKeyPropertiesFile = if (fprsKeyPropertiesPath != null) file(fprsKeyPropertiesPath) else rootProject.file(fprsPropertiesFallback)
    val fprsReleaseSigningTaskRequested = gradle.startParameter.taskNames.any { fprsRequestedTask ->
        val fprsDirectTask = fprsRequestedTask.substringAfterLast(':').lowercase(java.util.Locale.ROOT)
        fprsTerminalTaskPrefixes.any { fprsPrefix -> fprsDirectTask.startsWith(fprsPrefix) && fprsDirectTask.endsWith(fprsReleaseToken) } ||
            fprsContainingTaskPrefixes.any { fprsPrefix -> fprsDirectTask.startsWith(fprsPrefix) && fprsDirectTask.contains(fprsReleaseToken) }
    }
    val fprsKeyProperties = java.util.Properties()
    if (fprsReleaseSigningTaskRequested) {
        if (fprsKeyPropertiesFile.isFile) {
            fprsKeyPropertiesFile.inputStream().use { fprsInput -> fprsKeyProperties.load(fprsInput) }
        }
    }
    val fprsStoreFileValue = fprsKeyProperties.getProperty(fprsSigningPropertyKeys[0])
    val fprsStorePasswordValue = fprsKeyProperties.getProperty(fprsSigningPropertyKeys[1])
    val fprsKeyAliasValue = fprsKeyProperties.getProperty(fprsSigningPropertyKeys[2])
    val fprsKeyPasswordValue = fprsKeyProperties.getProperty(fprsSigningPropertyKeys[3])
    val fprsSigningValuesComplete = listOf(fprsStoreFileValue, fprsStorePasswordValue, fprsKeyAliasValue, fprsKeyPasswordValue).all {
        fprsValue -> !fprsValue.isNullOrBlank()
    }
    if (fprsReleaseSigningTaskRequested) {
        if (!fprsKeyPropertiesFile.isFile) {
            throw GradleException("Android release signing properties file is missing")
        }
        if (!fprsSigningValuesComplete) {
            throw GradleException("Android release signing properties are incomplete")
        }
        if (!file(fprsStoreFileValue!!).isFile) {
            throw GradleException("Android release keystore file is missing")
        }
    }
    signingConfigs {
        create("release") {
            if (fprsSigningValuesComplete) {
                storeFile = file(fprsStoreFileValue!!)
                storePassword = fprsStorePasswordValue
                keyAlias = fprsKeyAliasValue
                keyPassword = fprsKeyPasswordValue
            }
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
        }
    }
    // END flutter-play-store-release
KOTLIN
}

fprs_gradle_signing_validate_markers() {
  [ "$#" -eq 2 ] || return 1
  awk -v report="$2" '
    function visible_text(raw,    output, i, character, next_character, sequence, pair, context) {
      output = ""
      for (i = 1; i <= length(raw); i++) {
        character = substr(raw, i, 1)
        next_character = substr(raw, i + 1, 1)
        sequence = substr(raw, i, 3)
        pair = substr(raw, i, 2)
        if (dollar_slashy) {
          if (pair == "$/" || pair == "$$") {
            i++
          } else if (pair == "/$") {
            dollar_slashy = 0
            i++
          }
          continue
        }
        if (slashy) {
          if (slashy_escaped) slashy_escaped = 0
          else if (character == "\\") slashy_escaped = 1
          else if (character == "/") slashy = 0
          continue
        }
        if (triple_quote != "") {
          if (sequence == triple_quote) {
            triple_quote = ""
            i += 2
          }
          continue
        }
        if (block_comment) {
          if (character == "*" && next_character == "/") {
            block_comment = 0
            i++
          }
          continue
        }
        if (quote != "") {
          if (escaped) escaped = 0
          else if (character == "\\") escaped = 1
          else if (character == quote) quote = ""
          continue
        }
        if (sequence == "\"\"\"" || sequence == "\047\047\047") {
          triple_quote = sequence
          i += 2
          continue
        }
        if (pair == "$/") {
          dollar_slashy = 1
          i++
          continue
        }
        if (character == "/" && next_character == "*") {
          block_comment = 1
          i++
          continue
        }
        if (character == "\"" || character == "\047") {
          quote = character
          continue
        }
        if (character == "/" && next_character == "/") {
          output = output substr(raw, i)
          break
        }
        if (character == "/" && next_character != "/" && next_character != "*") {
          context = output
          gsub(/[[:space:]]+$/, "", context)
          if (context ~ /(=|\(|\[|,|:|return)$/) {
            slashy = 1
            continue
          }
        }
        output = output character
      }
      return output
    }
    {
      line = visible_text($0)
      sub(/\r$/, "", line)
      if (line ~ /BEGIN flutter-play-store-release/) any_begin++
      if (line ~ /END flutter-play-store-release/) any_end++
      if (line ~ /^[[:space:]]*\/\/ BEGIN flutter-play-store-release schema=1[[:space:]]*$/) {
        exact_begin++
        begin_line = NR
      }
      if (line ~ /^[[:space:]]*\/\/ END flutter-play-store-release[[:space:]]*$/) {
        exact_end++
        end_line = NR
      }
    }
    END {
      print begin_line > report
      print end_line >> report
      if (any_begin == 0 && any_end == 0) exit 0
      if (any_begin != 1 || any_end != 1 || exact_begin != 1 || exact_end != 1 || begin_line >= end_line) exit 2
      exit 10
    }
  ' "$1"
}

fprs_gradle_signing_strip_owned_block() {
  [ "$#" -eq 4 ] || return 1
  awk -v begin="$3" -v end="$4" 'NR < begin || NR > end { print }' \
    "$1" > "$2"
}

fprs_gradle_signing_scan() {
  [ "$#" -eq 3 ] || return 1
  awk -v dsl="$1" '
    function uncomment(raw,    output, i, character, next_character, sequence, pair, context) {
      output = ""
      for (i = 1; i <= length(raw); i++) {
        character = substr(raw, i, 1)
        next_character = substr(raw, i + 1, 1)
        sequence = substr(raw, i, 3)
        pair = substr(raw, i, 2)
        if (dollar_slashy) {
          if (pair == "$/" || pair == "$$") {
            i++
          } else if (pair == "/$") {
            dollar_slashy = 0
            i++
          }
          continue
        }
        if (slashy) {
          if (slashy_escaped) slashy_escaped = 0
          else if (character == "\\") slashy_escaped = 1
          else if (character == "/") slashy = 0
          continue
        }
        if (triple_quote != "") {
          if (sequence == triple_quote) {
            triple_quote = ""
            i += 2
          }
          continue
        }
        if (block_comment) {
          if (character == "*" && next_character == "/") {
            block_comment = 0
            i++
          }
          continue
        }
        if (quote != "") {
          output = output character
          if (escaped) escaped = 0
          else if (character == "\\") escaped = 1
          else if (character == quote) quote = ""
          continue
        }
        if (sequence == "\"\"\"" || sequence == "\047\047\047") {
          triple_quote = sequence
          i += 2
          continue
        }
        if (pair == "$/") {
          dollar_slashy = 1
          i++
          continue
        }
        if (character == "/" && next_character == "*") {
          block_comment = 1
          i++
          continue
        }
        if (character == "/" && next_character == "/") break
        if (character == "\"" || character == "\047") quote = character
        if (character == "/" && next_character != "/" && next_character != "*") {
          context = output
          gsub(/[[:space:]]+$/, "", context)
          if (context ~ /(=|\(|\[|,|:|return)$/) {
            slashy = 1
            continue
          }
        }
        output = output character
      }
      return output
    }
    function brace_delta(value,    i, character, opens, closes, local_quote, local_escaped) {
      opens = closes = 0
      local_quote = ""
      local_escaped = 0
      for (i = 1; i <= length(value); i++) {
        character = substr(value, i, 1)
        if (local_quote != "") {
          if (local_escaped) local_escaped = 0
          else if (character == "\\") local_escaped = 1
          else if (character == local_quote) local_quote = ""
        } else if (character == "\"" || character == "\047") {
          local_quote = character
        } else if (character == "{") opens++
        else if (character == "}") closes++
      }
      brace_opens = opens
      brace_closes = closes
      return opens - closes
    }
    function structural_code(value,    output, i, character, quote_character, escaped) {
      output = ""
      for (i = 1; i <= length(value); i++) {
        character = substr(value, i, 1)
        if (character != "\"" && character != "\047") {
          output = output character
          continue
        }
        quote_character = character
        escaped = 0
        for (i = i + 1; i <= length(value); i++) {
          character = substr(value, i, 1)
          if (escaped) escaped = 0
          else if (character == "\\") escaped = 1
          else if (character == quote_character) break
        }
        output = output " "
      }
      return output
    }
    function android_scope_before(value, signing_position,    prefix, android_prefix) {
      prefix = substr(value, 1, signing_position - 1)
      if (android_depth > 0 &&
          before_depth + brace_delta(prefix) >= android_depth) {
        return 1
      }
      if (match(prefix, /(^|[^A-Za-z0-9_])android[[:space:]]*[{]/)) {
        android_prefix = substr(prefix, RSTART)
        if (brace_delta(android_prefix) > 0) return 1
      }
      return 0
    }
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function assignment_kind(value,    compact, name) {
      compact = value
      gsub(/[[:space:]\r;]/, "", compact)
      if (dsl == "groovy") {
        if (compact == "signingConfigsigningConfigs.debug" ||
            compact == "signingConfig=signingConfigs.debug" ||
            compact == "setSigningConfig(signingConfigs.debug)" ||
            compact == "setSigningConfigsigningConfigs.debug") {
          assignment_name = "debug"
          return "debug"
        }
        if (compact ~ /^signingConfig=?signingConfigs\.[A-Za-z][A-Za-z0-9_]*$/) {
          sub(/^signingConfig=?signingConfigs\./, "", compact)
          assignment_name = compact
          return "custom"
        }
        if (compact ~ /^setSigningConfig\(signingConfigs\.[A-Za-z][A-Za-z0-9_]*\)$/) {
          sub(/^setSigningConfig\(signingConfigs\./, "", compact)
          sub(/\)$/, "", compact)
          assignment_name = compact
          return "custom"
        }
        if (compact ~ /^setSigningConfigsigningConfigs\.[A-Za-z][A-Za-z0-9_]*$/) {
          sub(/^setSigningConfigsigningConfigs\./, "", compact)
          assignment_name = compact
          return "custom"
        }
      } else {
        if (compact == "signingConfig=signingConfigs.getByName(\"debug\")" ||
            compact == "setSigningConfig(signingConfigs.getByName(\"debug\"))") {
          assignment_name = "debug"
          return "debug"
        }
        if (compact ~ /^signingConfig=signingConfigs\.getByName\(\"[A-Za-z][A-Za-z0-9_]*\"\)$/) {
          sub(/^signingConfig=signingConfigs\.getByName\(\"/, "", compact)
          sub(/\"\)$/, "", compact)
          assignment_name = compact
          return "custom"
        }
        if (compact ~ /^setSigningConfig\(signingConfigs\.getByName\(\"[A-Za-z][A-Za-z0-9_]*\"\)\)$/) {
          sub(/^setSigningConfig\(signingConfigs\.getByName\(\"/, "", compact)
          sub(/\"\)\)$/, "", compact)
          assignment_name = compact
          return "custom"
        }
      }
      assignment_name = ""
      return "invalid"
    }
    {
      code = uncomment($0)
      stripped = trim(code)
      structural = structural_code(code)
      first_signing = match(structural, /(^|[^A-Za-z0-9_])(signingConfig|setSigningConfig)([^A-Za-z0-9_]|$)/)
      if (first_signing) {
        first_signing_match_start = RSTART
        first_signing_match_length = RLENGTH
        first_signing_match = substr(structural,
          first_signing_match_start, first_signing_match_length)
        first_signing_token_offset = match(first_signing_match,
          /(signingConfig|setSigningConfig)/)
        first_signing_position = first_signing_match_start + first_signing_token_offset - 1
      } else first_signing_position = 0
      assignment_handled = 0
      before_depth = depth

      if (before_depth == 0 && stripped ~ /^android[[:space:]]*\{[[:space:]]*$/) {
        android_count++
        android_depth = before_depth + 1
        android_open = NR
      }
      if (android_depth > 0 && before_depth == android_depth &&
          stripped ~ /^buildTypes[[:space:]]*\{[[:space:]]*$/) {
        build_types_depth = before_depth + 1
      }
      if (build_types_depth > 0 && before_depth == build_types_depth &&
          (stripped ~ /^release[[:space:]]*\{[[:space:]]*$/ ||
           stripped ~ /^getByName\([[:space:]]*\"release\"[[:space:]]*\)[[:space:]]*\{[[:space:]]*$/)) {
        release_depth = before_depth + 1
        release_scopes++
      }
      if (android_depth > 0 && before_depth == android_depth &&
          stripped ~ /^signingConfigs[[:space:]]*\{[[:space:]]*$/) {
        signing_configs_depth = before_depth + 1
      }
      if (signing_configs_depth > 0 && before_depth == signing_configs_depth) {
        declaration = stripped
        declaration_name = ""
        if (declaration ~ /^[A-Za-z][A-Za-z0-9_]*[[:space:]]*\{[[:space:]]*$/) {
          sub(/[[:space:]]*\{[[:space:]]*$/, "", declaration)
          declaration_name = declaration
        } else if (declaration ~ /^(create|getByName)\([[:space:]]*\"[A-Za-z][A-Za-z0-9_]*\"[[:space:]]*\)[[:space:]]*\{[[:space:]]*$/) {
          sub(/^(create|getByName)\([[:space:]]*\"/, "", declaration)
          sub(/\"[[:space:]]*\)[[:space:]]*\{[[:space:]]*$/, "", declaration)
          declaration_name = declaration
        }
        if (declaration_name != "") declarations[declaration_name]++
      }
      if (release_depth > 0 && before_depth == release_depth &&
          first_signing) {
        kind = assignment_kind(stripped)
        assignments++
        assignment_handled = 1
        if (kind == "debug") {
          debug_count++
          debug_line = NR
        } else if (kind == "custom") {
          custom_count++
          custom_name = assignment_name
        } else invalid_count++
      }
      signing_search_from = 1
      while (signing_search_from <= length(structural)) {
        signing_search = substr(structural, signing_search_from)
        if (!match(signing_search, /(^|[^A-Za-z0-9_])(signingConfig|setSigningConfig)([^A-Za-z0-9_]|$)/)) break
        signing_match_start = RSTART
        signing_match_length = RLENGTH
        signing_search_next = signing_search_from + signing_match_start + signing_match_length - 1
        signing_match = substr(signing_search,
          signing_match_start, signing_match_length)
        signing_token_offset = match(signing_match,
          /(signingConfig|setSigningConfig)/)
        if (signing_token_offset) {
          signing_position = signing_search_from + signing_match_start + signing_token_offset - 2
          if (!(assignment_handled &&
                signing_position == first_signing_position) &&
              android_scope_before(structural, signing_position)) {
            invalid_count++
          }
        }
        signing_search_from = signing_search_next
      }

      delta = brace_delta(code)
      depth += delta
      if (depth < 0) malformed = 1
      if (release_depth > 0 && depth < release_depth) release_depth = 0
      if (build_types_depth > 0 && depth < build_types_depth) build_types_depth = 0
      if (signing_configs_depth > 0 && depth < signing_configs_depth) signing_configs_depth = 0
      if (android_depth > 0 && depth < android_depth) {
        android_close = NR
        android_depth = 0
      }
    }
    END {
      if (depth != 0 || block_comment || quote != "" || triple_quote != "" ||
          slashy || dollar_slashy) malformed = 1
      print "android_count=" android_count
      print "android_open=" android_open
      print "android_close=" android_close
      print "release_scopes=" release_scopes
      print "assignments=" assignments
      print "debug_count=" debug_count
      print "debug_line=" debug_line
      print "custom_count=" custom_count
      print "custom_name=" custom_name
      print "custom_declared=" declarations[custom_name]
      print "release_declared=" declarations["release"]
      print "invalid_count=" invalid_count
      print "malformed=" malformed
    }
  ' "$2" > "$3"
}

fprs_gradle_signing_report_value() {
  [ "$#" -eq 2 ] || return 1
  sed -n "s/^$1=//p" "$2" | sed -n '1p'
}

fprs_gradle_signing_publish_candidate() {
  [ "$#" -eq 2 ] || return 1
  local fprs_gradle_publish_attempt
  if [ "${FPRS_TEST_MODE-}" = 1 ] &&
    [ -n "${FPRS_TEST_GRADLE_CONTROL_DIR-}" ]
  then
    [ -d "$FPRS_TEST_GRADLE_CONTROL_DIR" ] &&
      [ ! -L "$FPRS_TEST_GRADLE_CONTROL_DIR" ] || return 1
    printf 'ready\n' > "$FPRS_TEST_GRADLE_CONTROL_DIR/before-publish.new" ||
      return 1
    mv "$FPRS_TEST_GRADLE_CONTROL_DIR/before-publish.new" \
      "$FPRS_TEST_GRADLE_CONTROL_DIR/before-publish" || return 1
    fprs_gradle_publish_attempt=0
    while [ ! -e "$FPRS_TEST_GRADLE_CONTROL_DIR/continue" ]
    do
      [ "$fprs_gradle_publish_attempt" -lt 500 ] || return 1
      sleep 0.01
      fprs_gradle_publish_attempt=$((fprs_gradle_publish_attempt + 1))
    done
  fi
  python3 -c '
import errno
import os
import signal
import stat
import sys

source, destination = sys.argv[1:]
descriptor = None
created_identity = None

def interrupted(signum, frame):
    raise RuntimeError

for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, interrupted)

try:
    source_info = os.stat(source, follow_symlinks=False)
    if not stat.S_ISREG(source_info.st_mode):
        raise RuntimeError
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(destination, flags, 0o600)
    except FileExistsError:
        raise SystemExit(2)
    except OSError as error:
        if error.errno in (errno.EEXIST, errno.ELOOP):
            raise SystemExit(2)
        raise
    installed = os.fstat(descriptor)
    created_identity = (installed.st_dev, installed.st_ino)
    if not stat.S_ISREG(installed.st_mode) or installed.st_nlink != 1:
        raise RuntimeError
    with open(source, "rb") as input_file:
        while True:
            chunk = input_file.read(65536)
            if not chunk:
                break
            offset = 0
            while offset < len(chunk):
                offset += os.write(descriptor, chunk[offset:])
    os.fchmod(descriptor, stat.S_IMODE(source_info.st_mode))
    os.close(descriptor)
    descriptor = None
except SystemExit:
    raise
except BaseException:
    if descriptor is not None:
        try:
            os.close(descriptor)
        except OSError:
            pass
    if created_identity is not None:
        try:
            current = os.stat(destination, follow_symlinks=False)
            if (current.st_dev, current.st_ino) == created_identity:
                os.unlink(destination)
        except OSError:
            pass
    raise SystemExit(1)
' "$1" "$2" >/dev/null 2>&1
}

fprs_gradle_signing_candidate() {
  FPRS_GRADLE_SIGNING_CLASSIFICATION=
  [ "$#" -ge 3 ] && [ "$#" -le 4 ] || {
    fprs_gradle_signing_error 'candidate requires DSL, source, output, and optional flavor'
    return 2
  }
  case "$1" in groovy|kotlin) ;; *)
    fprs_gradle_signing_error 'DSL must be groovy or kotlin'
    return 2
  esac
  [ -f "$2" ] && [ ! -L "$2" ] || {
    fprs_gradle_signing_error 'source must be a regular file'
    return 2
  }
  if [ "$#" -eq 4 ]; then
    case "$4" in ''|*[!A-Za-z0-9_]*)
      fprs_gradle_signing_error 'flavor is not a conservative Gradle identifier'
      return 2 ;;
    esac
  fi

  local fprs_gradle_output_parent fprs_gradle_output_absolute
  local fprs_gradle_source_parent fprs_gradle_source_absolute
  fprs_gradle_output_parent=${3%/*}
  [ "$fprs_gradle_output_parent" != "$3" ] || fprs_gradle_output_parent=.
  [ -d "$fprs_gradle_output_parent" ] || {
    fprs_gradle_signing_error 'candidate output parent is unavailable'
    return 1
  }
  fprs_gradle_output_parent=$(CDPATH= cd -- "$fprs_gradle_output_parent" && pwd -P) || return 1
  fprs_gradle_output_absolute="$fprs_gradle_output_parent/${3##*/}"
  if [ -e "$fprs_gradle_output_absolute" ] || [ -L "$fprs_gradle_output_absolute" ]; then
    fprs_gradle_signing_error 'candidate output must be a new, unaliased path'
    return 2
  fi
  fprs_gradle_source_parent=${2%/*}
  [ "$fprs_gradle_source_parent" != "$2" ] || fprs_gradle_source_parent=.
  fprs_gradle_source_parent=$(CDPATH= cd -- "$fprs_gradle_source_parent" && pwd -P) || return 1
  fprs_gradle_source_absolute="$fprs_gradle_source_parent/${2##*/}"
  [ "$fprs_gradle_output_absolute" != "$fprs_gradle_source_absolute" ] || {
    fprs_gradle_signing_error 'candidate output must not replace the source'
    return 2
  }

  local fprs_gradle_stage fprs_gradle_marker_status fprs_gradle_owned
  local fprs_gradle_clean fprs_gradle_block fprs_gradle_report
  local fprs_gradle_private_output fprs_gradle_publish_status
  local fprs_gradle_original_report fprs_gradle_marker_report
  local fprs_gradle_marker_begin fprs_gradle_marker_end
  local fprs_gradle_original_android_count fprs_gradle_original_android_open
  local fprs_gradle_original_android_close fprs_gradle_original_malformed
  local fprs_gradle_mode fprs_gradle_android_count fprs_gradle_android_close
  local fprs_gradle_release_scopes fprs_gradle_assignments fprs_gradle_debug_count
  local fprs_gradle_debug_line fprs_gradle_custom_count fprs_gradle_custom_name
  local fprs_gradle_custom_declared fprs_gradle_release_declared
  local fprs_gradle_invalid_count fprs_gradle_malformed fprs_gradle_crlf
  fprs_gradle_stage=$(mktemp -d \
    "${TMPDIR:-/tmp}/.fprs-gradle-signing.XXXXXX" 2>/dev/null) || return 1
  chmod 700 "$fprs_gradle_stage" 2>/dev/null || {
    rm -rf -- "$fprs_gradle_stage"
    return 1
  }
  fprs_gradle_clean="$fprs_gradle_stage/clean"
  fprs_gradle_block="$fprs_gradle_stage/block"
  fprs_gradle_report="$fprs_gradle_stage/report"
  fprs_gradle_original_report="$fprs_gradle_stage/original-report"
  fprs_gradle_marker_report="$fprs_gradle_stage/markers"
  fprs_gradle_private_output="$fprs_gradle_stage/candidate-output"
  fprs_gradle_owned=0
  if fprs_gradle_signing_validate_markers "$2" "$fprs_gradle_marker_report"; then
    fprs_gradle_marker_status=0
  else
    fprs_gradle_marker_status=$?
  fi
  case "$fprs_gradle_marker_status" in
    0) cp "$2" "$fprs_gradle_clean" 2>/dev/null || {
      rm -rf -- "$fprs_gradle_stage"
      return 1
    } ;;
    10)
      fprs_gradle_owned=1
      fprs_gradle_signing_scan "$1" "$2" "$fprs_gradle_original_report" || {
        rm -rf -- "$fprs_gradle_stage"
        return 1
      }
      fprs_gradle_marker_begin=$(sed -n '1p' "$fprs_gradle_marker_report")
      fprs_gradle_marker_end=$(sed -n '2p' "$fprs_gradle_marker_report")
      fprs_gradle_original_android_count=$(fprs_gradle_signing_report_value \
        android_count "$fprs_gradle_original_report")
      fprs_gradle_original_android_open=$(fprs_gradle_signing_report_value \
        android_open "$fprs_gradle_original_report")
      fprs_gradle_original_android_close=$(fprs_gradle_signing_report_value \
        android_close "$fprs_gradle_original_report")
      fprs_gradle_original_malformed=$(fprs_gradle_signing_report_value \
        malformed "$fprs_gradle_original_report")
      if [ "${fprs_gradle_original_android_count:-0}" -ne 1 ] ||
        [ "${fprs_gradle_original_malformed:-0}" -ne 0 ] ||
        [ -z "$fprs_gradle_marker_begin" ] || [ -z "$fprs_gradle_marker_end" ] ||
        [ -z "$fprs_gradle_original_android_open" ] ||
        [ -z "$fprs_gradle_original_android_close" ] ||
        [ "$fprs_gradle_marker_begin" -le "$fprs_gradle_original_android_open" ] ||
        [ "$fprs_gradle_marker_end" -ge "$fprs_gradle_original_android_close" ]
      then
        fprs_gradle_signing_error 'owned Gradle marker is outside the android scope'
        rm -rf -- "$fprs_gradle_stage"
        return 2
      fi
      fprs_gradle_signing_strip_owned_block "$2" "$fprs_gradle_clean" \
        "$fprs_gradle_marker_begin" "$fprs_gradle_marker_end" || {
        rm -rf -- "$fprs_gradle_stage"
        return 1
      }
      ;;
    *)
      fprs_gradle_signing_error 'owned Gradle marker is malformed or repeated'
      rm -rf -- "$fprs_gradle_stage"
      return 2
      ;;
  esac

  fprs_gradle_signing_scan "$1" "$fprs_gradle_clean" "$fprs_gradle_report" || {
    rm -rf -- "$fprs_gradle_stage"
    return 1
  }
  fprs_gradle_android_count=$(fprs_gradle_signing_report_value android_count "$fprs_gradle_report")
  fprs_gradle_android_close=$(fprs_gradle_signing_report_value android_close "$fprs_gradle_report")
  fprs_gradle_release_scopes=$(fprs_gradle_signing_report_value release_scopes "$fprs_gradle_report")
  fprs_gradle_assignments=$(fprs_gradle_signing_report_value assignments "$fprs_gradle_report")
  fprs_gradle_debug_count=$(fprs_gradle_signing_report_value debug_count "$fprs_gradle_report")
  fprs_gradle_debug_line=$(fprs_gradle_signing_report_value debug_line "$fprs_gradle_report")
  fprs_gradle_custom_count=$(fprs_gradle_signing_report_value custom_count "$fprs_gradle_report")
  fprs_gradle_custom_name=$(fprs_gradle_signing_report_value custom_name "$fprs_gradle_report")
  fprs_gradle_custom_declared=$(fprs_gradle_signing_report_value custom_declared "$fprs_gradle_report")
  fprs_gradle_release_declared=$(fprs_gradle_signing_report_value release_declared "$fprs_gradle_report")
  fprs_gradle_invalid_count=$(fprs_gradle_signing_report_value invalid_count "$fprs_gradle_report")
  fprs_gradle_malformed=$(fprs_gradle_signing_report_value malformed "$fprs_gradle_report")
  for fprs_gradle_numeric in \
    fprs_gradle_android_count fprs_gradle_release_scopes fprs_gradle_assignments \
    fprs_gradle_debug_count fprs_gradle_custom_count fprs_gradle_custom_declared \
    fprs_gradle_release_declared fprs_gradle_invalid_count fprs_gradle_malformed
  do
    eval "fprs_gradle_numeric_value=\${$fprs_gradle_numeric:-0}"
    case "$fprs_gradle_numeric_value" in ''|*[!0-9]*)
      rm -rf -- "$fprs_gradle_stage"
      return 1 ;;
    esac
  done
  if [ "${fprs_gradle_android_count:-0}" -ne 1 ] ||
    [ -z "$fprs_gradle_android_close" ] ||
    [ "${fprs_gradle_malformed:-0}" -ne 0 ]; then
    fprs_gradle_signing_error 'android scope is not structurally safe to edit'
    rm -rf -- "$fprs_gradle_stage"
    return 2
  fi
  if [ "${fprs_gradle_invalid_count:-0}" -ne 0 ] ||
    [ "${fprs_gradle_release_scopes:-0}" -gt 1 ] ||
    [ "${fprs_gradle_assignments:-0}" -gt 1 ] ||
    { [ "${fprs_gradle_debug_count:-0}" -gt 0 ] &&
      [ "${fprs_gradle_custom_count:-0}" -gt 0 ]; }
  then
    fprs_gradle_signing_error 'release signing contains multiple or unsupported assignments'
    rm -rf -- "$fprs_gradle_stage"
    return 2
  fi
  if [ "${fprs_gradle_custom_count:-0}" -eq 1 ]; then
    if [ "${fprs_gradle_custom_declared:-0}" -ne 1 ]; then
      fprs_gradle_signing_error "release signing config is not declared structurally: $fprs_gradle_custom_name"
      rm -rf -- "$fprs_gradle_stage"
      return 2
    fi
    cp "$2" "$fprs_gradle_private_output" 2>/dev/null || {
      rm -rf -- "$fprs_gradle_stage"
      return 1
    }
    fprs_gradle_mode=$(fprs_gradle_signing_file_mode "$2") || {
      rm -rf -- "$fprs_gradle_stage"
      return 1
    }
    chmod "$fprs_gradle_mode" "$fprs_gradle_private_output" 2>/dev/null || {
      rm -rf -- "$fprs_gradle_stage"
      return 1
    }
    fprs_gradle_signing_publish_candidate "$fprs_gradle_private_output" \
      "$fprs_gradle_output_absolute"
    fprs_gradle_publish_status=$?
    if [ "$fprs_gradle_publish_status" -ne 0 ]; then
      [ "$fprs_gradle_publish_status" -ne 2 ] ||
        fprs_gradle_signing_error 'candidate output changed before publication'
      rm -rf -- "$fprs_gradle_stage"
      return "$fprs_gradle_publish_status"
    fi
    FPRS_GRADLE_SIGNING_CLASSIFICATION=preserve
    rm -rf -- "$fprs_gradle_stage"
    return 0
  fi
  if [ "${fprs_gradle_release_declared:-0}" -gt 0 ]; then
    fprs_gradle_signing_error 'an unowned release signing config already exists'
    rm -rf -- "$fprs_gradle_stage"
    return 2
  fi

  case "$1" in
    groovy) fprs_gradle_signing_groovy_block > "$fprs_gradle_block" ;;
    kotlin) fprs_gradle_signing_kotlin_block > "$fprs_gradle_block" ;;
  esac || {
    rm -rf -- "$fprs_gradle_stage"
    return 1
  }
  if awk '
    NR == 1 { seen = 1 }
    substr($0, length($0), 1) != "\r" { non_crlf = 1 }
    END { exit(seen && !non_crlf ? 0 : 1) }
  ' "$2"
  then
    fprs_gradle_crlf=1
  else
    fprs_gradle_crlf=0
  fi
  awk -v close_line="$fprs_gradle_android_close" \
      -v remove="${fprs_gradle_debug_line:-0}" \
      -v block="$fprs_gradle_block" -v crlf="$fprs_gradle_crlf" '
    NR == close_line {
      while ((getline inserted < block) > 0) {
        if (crlf) printf "%s\r\n", inserted
        else print inserted
      }
      close(block)
    }
    NR != remove { print }
  ' "$fprs_gradle_clean" > "$fprs_gradle_private_output" || {
    rm -rf -- "$fprs_gradle_stage"
    return 1
  }
  fprs_gradle_signing_validate_emitted_guard "$1" \
    "$fprs_gradle_private_output" || {
    fprs_gradle_signing_error 'generated signing guard is structurally invalid'
    rm -rf -- "$fprs_gradle_stage"
    return 2
  }
  fprs_gradle_mode=$(fprs_gradle_signing_file_mode "$2") || {
    rm -rf -- "$fprs_gradle_stage"
    return 1
  }
  chmod "$fprs_gradle_mode" "$fprs_gradle_private_output" 2>/dev/null || {
    rm -rf -- "$fprs_gradle_stage"
    return 1
  }
  fprs_gradle_signing_publish_candidate "$fprs_gradle_private_output" \
    "$fprs_gradle_output_absolute"
  fprs_gradle_publish_status=$?
  if [ "$fprs_gradle_publish_status" -ne 0 ]; then
    [ "$fprs_gradle_publish_status" -ne 2 ] ||
      fprs_gradle_signing_error 'candidate output changed before publication'
    rm -rf -- "$fprs_gradle_stage"
    return "$fprs_gradle_publish_status"
  fi
  if [ "$fprs_gradle_owned" -eq 1 ]; then
    FPRS_GRADLE_SIGNING_CLASSIFICATION=update-owned
  else
    FPRS_GRADLE_SIGNING_CLASSIFICATION=merge
  fi
  rm -rf -- "$fprs_gradle_stage"
  return 0
}
