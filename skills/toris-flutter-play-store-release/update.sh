#!/usr/bin/env bash
# Synchronize supported global skill directories from a verified canonical package.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || {
  printf 'ERROR: could not resolve the package directory\n' >&2
  exit 1
}

source_path=
source_seen=0
dry_run=0
while [ "$#" -gt 0 ]
do
  case "$1" in
    --source)
      [ "$source_seen" -eq 0 ] && [ "$#" -ge 2 ] && [ -n "$2" ] || {
        printf 'ERROR: --source requires one nonempty value\n' >&2
        exit 2
      }
      source_path=$2
      source_seen=1
      shift 2
      ;;
    --dry-run)
      [ "$dry_run" -eq 0 ] || {
        printf 'ERROR: --dry-run may be specified only once\n' >&2
        exit 2
      }
      dry_run=1
      shift
      ;;
    *)
      printf 'ERROR: unknown update argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
[ "$source_seen" -eq 1 ] || {
  printf 'ERROR: update requires --source PATH\n' >&2
  exit 2
}

# shellcheck source=scripts/lib/package_sync.sh
. "$SCRIPT_DIR/scripts/lib/package_sync.sh" || exit 1
fprs_package_sync_main update "$source_path" "$dry_run" 0
