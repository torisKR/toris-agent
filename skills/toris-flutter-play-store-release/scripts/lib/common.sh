#!/usr/bin/env bash
# Provide portable shared helpers for package and project scripts.

LC_ALL=C
export LC_ALL
umask 077

fprs_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

fprs_warn() {
  printf 'WARNING: %s\n' "$*" >&2
}

fprs_info() {
  printf 'INFO: %s\n' "$*" >&2
}

fprs_require_arg() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    fprs_die "missing value for ${1:-argument}"
  fi
}

fprs_realpath() {
  if [ "$#" -ne 1 ] || [ -z "$1" ]; then
    return 1
  fi

  local fprs_path fprs_parent fprs_leaf fprs_resolved_parent
  case "$1" in
    /*) fprs_path=$1 ;;
    *) fprs_path=$PWD/$1 ;;
  esac

  if [ -d "$fprs_path" ]; then
    (CDPATH= cd -- "$fprs_path" 2>/dev/null && pwd -P)
    return
  fi

  fprs_parent=${fprs_path%/*}
  fprs_leaf=${fprs_path##*/}
  [ -n "$fprs_parent" ] || fprs_parent=/
  [ -n "$fprs_leaf" ] || return 1
  fprs_resolved_parent=$(CDPATH= cd -- "$fprs_parent" 2>/dev/null && pwd -P) ||
    return 1
  printf '%s/%s\n' "${fprs_resolved_parent%/}" "$fprs_leaf"
}

fprs_sha256() {
  if [ "$#" -ne 1 ] || [ ! -r "$1" ]; then
    fprs_die 'cannot read input for SHA-256'
  fi

  local fprs_digest_line fprs_digest
  if command -v shasum >/dev/null 2>&1; then
    fprs_digest_line=$(shasum -a 256 < "$1" 2>/dev/null) ||
      fprs_die 'could not calculate SHA-256'
  elif command -v sha256sum >/dev/null 2>&1; then
    fprs_digest_line=$(sha256sum < "$1" 2>/dev/null) ||
      fprs_die 'could not calculate SHA-256'
  else
    fprs_die 'SHA-256 tool is unavailable'
  fi

  fprs_digest=${fprs_digest_line%%[[:space:]]*}
  case "$fprs_digest" in
    ''|*[!0-9a-fA-F]*) fprs_die 'SHA-256 tool returned an invalid digest' ;;
  esac
  [ "${#fprs_digest}" -eq 64 ] ||
    fprs_die 'SHA-256 tool returned an invalid digest'
  printf '%s\n' "$fprs_digest" | tr 'A-F' 'a-f'
}

fprs_mktemp_dir() {
  if [ "$#" -lt 1 ] || [ -z "$1" ]; then
    fprs_die 'temporary directory prefix is required'
  fi

  local fprs_prefix fprs_base fprs_resolved_base fprs_created
  fprs_prefix=$1
  fprs_base=${2:-${TMPDIR:-/tmp}}
  case "$fprs_prefix" in
    *[!A-Za-z0-9._-]*|.|..) fprs_die 'temporary directory prefix is invalid' ;;
  esac
  fprs_resolved_base=$(fprs_realpath "$fprs_base") ||
    fprs_die 'temporary directory parent is unavailable'
  [ -d "$fprs_resolved_base" ] ||
    fprs_die 'temporary directory parent is unavailable'

  fprs_created=$(mktemp -d "$fprs_resolved_base/.${fprs_prefix}.XXXXXX" 2>/dev/null) ||
    fprs_die 'could not create a temporary directory'
  if ! chmod 700 "$fprs_created" 2>/dev/null; then
    rm -rf -- "$fprs_created" 2>/dev/null || true
    fprs_die 'could not secure a temporary directory'
  fi
  printf '%s\n' "$fprs_created"
}

fprs_file_mode() {
  if [ "$#" -ne 1 ] || [ ! -e "$1" ]; then
    return 1
  fi

  local fprs_mode
  if fprs_mode=$(stat -c '%a' "$1" 2>/dev/null) &&
    case "$fprs_mode" in ''|*[!0-7]*) false ;; *) true ;; esac
  then
    :
  elif fprs_mode=$(stat -f '%Lp' "$1" 2>/dev/null) &&
    case "$fprs_mode" in ''|*[!0-7]*) false ;; *) true ;; esac
  then
    :
  else
    return 1
  fi
  printf '%s\n' "$fprs_mode"
}

fprs_json_escape() {
  [ "$#" -eq 1 ] || return 1
  printf '%s' "$1" | od -An -v -tu1 | awk '
    {
      for (i = 1; i <= NF; i++) {
        byte = $i + 0
        if (byte == 8) printf "\\b"
        else if (byte == 9) printf "\\t"
        else if (byte == 10) printf "\\n"
        else if (byte == 12) printf "\\f"
        else if (byte == 13) printf "\\r"
        else if (byte == 34) printf "\\\""
        else if (byte == 92) printf "\\\\"
        else if (byte < 32) printf "\\u%04x", byte
        else printf "%c", byte
      }
    }
  '
}

fprs_is_truthy() {
  [ "$#" -eq 1 ] || return 1
  local fprs_normalized
  fprs_normalized=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]') || return 1
  case "$fprs_normalized" in
    1|true|yes|y|on|enabled) return 0 ;;
    *) return 1 ;;
  esac
}

fprs_cleanup_dir() {
  if [ "$#" -ne 1 ] || [ -z "$1" ]; then
    return 1
  fi

  local fprs_dir fprs_name
  fprs_dir=$1
  fprs_name=${fprs_dir##*/}
  case "$fprs_dir" in /|.|..|*/.|*/..) return 1 ;; esac
  case "$fprs_name" in .*.*) ;; *) return 1 ;; esac
  [ -d "$fprs_dir" ] || return 0
  [ ! -L "$fprs_dir" ] || return 1
  rm -rf -- "$fprs_dir"
}

fprs_atomic_replace() {
  if [ "$#" -ne 2 ] || [ ! -f "$1" ]; then
    return 1
  fi
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -c '
import os
import sys
replace = getattr(os, "replace", None)
if replace is None:
    raise SystemExit(1)
try:
    replace(sys.argv[1], sys.argv[2])
except OSError:
    raise SystemExit(1)
' "$1" "$2" >/dev/null 2>&1
}
