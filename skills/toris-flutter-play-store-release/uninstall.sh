#!/usr/bin/env bash
# Remove only installed copies that identify as this canonical package.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || {
  printf 'ERROR: could not resolve the package directory\n' >&2
  exit 1
}

dry_run=0
confirmed=0
while [ "$#" -gt 0 ]
do
  case "$1" in
    --dry-run)
      [ "$dry_run" -eq 0 ] || {
        printf 'ERROR: --dry-run may be specified only once\n' >&2
        exit 2
      }
      dry_run=1
      shift
      ;;
    --yes)
      [ "$confirmed" -eq 0 ] || {
        printf 'ERROR: --yes may be specified only once\n' >&2
        exit 2
      }
      confirmed=1
      shift
      ;;
    *)
      printf 'ERROR: unknown uninstall argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
if [ "$dry_run" -eq 0 ] && [ "$confirmed" -ne 1 ]; then
  printf 'ERROR: uninstall requires --yes before mutation\n' >&2
  exit 2
fi

# shellcheck source=scripts/lib/package_sync.sh
. "$SCRIPT_DIR/scripts/lib/package_sync.sh" || exit 1
fprs_package_sync_main uninstall '' "$dry_run" "$confirmed"
