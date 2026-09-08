#!/usr/bin/env bash
# Encode a local release secret for safe transfer into a secret manager.

set -u

FPRS_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
. "$FPRS_SCRIPT_DIR/lib/common.sh"

fprs_codec_work_dir=

fprs_codec_cleanup() {
  local fprs_codec_status
  fprs_codec_status=$1
  trap - EXIT HUP INT TERM
  if [ -n "$fprs_codec_work_dir" ]; then
    fprs_cleanup_dir "$fprs_codec_work_dir" >/dev/null 2>&1 || true
  fi
  exit "$fprs_codec_status"
}

trap 'fprs_codec_cleanup $?' EXIT
trap 'exit 1' HUP
trap 'exit 1' INT
trap 'exit 1' TERM

fprs_codec_usage_error() {
  printf 'ERROR: invalid or ambiguous arguments\n' >&2
  exit 2
}

fprs_codec_output_parent() {
  local fprs_codec_path fprs_codec_parent fprs_codec_leaf
  fprs_codec_path=$1
  case "$fprs_codec_path" in
    */*)
      fprs_codec_parent=${fprs_codec_path%/*}
      fprs_codec_leaf=${fprs_codec_path##*/}
      [ -n "$fprs_codec_parent" ] || fprs_codec_parent=/
      ;;
    *)
      fprs_codec_parent=.
      fprs_codec_leaf=$fprs_codec_path
      ;;
  esac
  case "$fprs_codec_leaf" in ''|.|..) return 2 ;; esac
  fprs_realpath "$fprs_codec_parent"
}

fprs_codec_detect_encode_style() {
  command -v base64 >/dev/null 2>&1 || return 1
  if printf '' | base64 -w 0 >/dev/null 2>&1; then
    printf 'gnu\n'
  elif printf '' | base64 -b 0 >/dev/null 2>&1; then
    printf 'bsd\n'
  else
    return 1
  fi
}

fprs_codec_input=-
fprs_codec_output=-
fprs_codec_seen_input=false
fprs_codec_seen_output=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --input)
      [ "$fprs_codec_seen_input" = false ] || fprs_codec_usage_error
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_codec_usage_error
      case "$2" in --*) fprs_codec_usage_error ;; esac
      fprs_codec_input=$2
      fprs_codec_seen_input=true
      shift 2
      ;;
    --output)
      [ "$fprs_codec_seen_output" = false ] || fprs_codec_usage_error
      [ "$#" -ge 2 ] && [ -n "$2" ] || fprs_codec_usage_error
      case "$2" in --*) fprs_codec_usage_error ;; esac
      fprs_codec_output=$2
      fprs_codec_seen_output=true
      shift 2
      ;;
    *)
      fprs_codec_usage_error
      ;;
  esac
done

if [ "$fprs_codec_input" != - ]; then
  [ -r "$fprs_codec_input" ] && [ ! -d "$fprs_codec_input" ] ||
    fprs_die 'input is not a readable file'
fi

if [ "$fprs_codec_output" = - ]; then
  fprs_codec_stage_parent=${TMPDIR:-/tmp}
  fprs_codec_stage_parent=$(fprs_realpath "$fprs_codec_stage_parent") ||
    fprs_die 'temporary directory is unavailable'
else
  [ ! -d "$fprs_codec_output" ] || fprs_codec_usage_error
  fprs_codec_stage_parent=$(fprs_codec_output_parent "$fprs_codec_output") || {
    fprs_codec_parent_status=$?
    [ "$fprs_codec_parent_status" -eq 2 ] && fprs_codec_usage_error
    fprs_die 'output directory is unavailable'
  }
  [ -d "$fprs_codec_stage_parent" ] || fprs_die 'output directory is unavailable'
  fprs_codec_output_name=${fprs_codec_output##*/}
  case "$fprs_codec_stage_parent" in
    /) fprs_codec_publish_path=/$fprs_codec_output_name ;;
    *) fprs_codec_publish_path=$fprs_codec_stage_parent/$fprs_codec_output_name ;;
  esac
fi

if [ "$fprs_codec_input" != - ] && [ "$fprs_codec_output" != - ]; then
  if [ -e "$fprs_codec_output" ] && [ "$fprs_codec_input" -ef "$fprs_codec_output" ]; then
    fprs_codec_usage_error
  fi
  fprs_codec_input_real=$(fprs_realpath "$fprs_codec_input") ||
    fprs_die 'input path cannot be resolved'
  fprs_codec_output_real=$(fprs_realpath "$fprs_codec_output") ||
    fprs_die 'output path cannot be resolved'
  [ "$fprs_codec_input_real" != "$fprs_codec_output_real" ] ||
    fprs_codec_usage_error
fi

fprs_codec_work_dir=$(fprs_mktemp_dir fprs-secret-codec "$fprs_codec_stage_parent") || exit 1
fprs_codec_raw=$fprs_codec_work_dir/encoded.raw
fprs_codec_staged=$fprs_codec_work_dir/encoded

if [ "$fprs_codec_input" = - ]; then
  exec 3<&0 || fprs_die 'could not open standard input'
else
  exec 3< "$fprs_codec_input" || fprs_die 'could not open input'
fi

fprs_codec_encode_style=$(fprs_codec_detect_encode_style) || {
  exec 3<&-
  fprs_die 'compatible Base64 encoder is unavailable'
}

case "$fprs_codec_encode_style" in
  gnu)
    base64 -w 0 <&3 > "$fprs_codec_raw" 2>/dev/null || {
      exec 3<&-
      fprs_die 'could not encode secret'
    }
    ;;
  bsd)
    base64 -b 0 <&3 > "$fprs_codec_raw" 2>/dev/null || {
      exec 3<&-
      fprs_die 'could not encode secret'
    }
    ;;
  *)
    exec 3<&-
    fprs_die 'compatible Base64 encoder is unavailable'
    ;;
esac
exec 3<&-

tr -d '\r\n' < "$fprs_codec_raw" > "$fprs_codec_staged" 2>/dev/null ||
  fprs_die 'could not normalize encoded secret'
printf '\n' >> "$fprs_codec_staged" || fprs_die 'could not finish encoded secret'
chmod 600 "$fprs_codec_staged" 2>/dev/null || fprs_die 'could not secure encoded secret'

if [ "$fprs_codec_output" = - ]; then
  cat "$fprs_codec_staged" || fprs_die 'could not write encoded secret'
else
  fprs_atomic_replace "$fprs_codec_staged" "$fprs_codec_publish_path" ||
    fprs_die 'could not publish encoded secret'
fi
