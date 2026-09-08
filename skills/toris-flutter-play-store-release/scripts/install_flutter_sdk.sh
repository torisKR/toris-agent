#!/usr/bin/env bash
# Install an exact verified Flutter SDK archive for the generated workflow.

set -eu

OFFICIAL_MANIFEST_URL='https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json'
OFFICIAL_BASE_URL='https://storage.googleapis.com/flutter_infra_release/releases'

version=
channel=
architecture=
destination=
manifest_url=$OFFICIAL_MANIFEST_URL
manifest_override=false
work_root=
active_child=

usage() {
  cat >&2 <<'USAGE'
Usage: install_flutter_sdk.sh --version VERSION --channel stable|beta \
  --architecture x64|arm64 --destination PATH [--manifest-url URL]
USAGE
  exit "${1:-2}"
}

die() {
  printf 'install_flutter_sdk.sh: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$work_root" ] && [ -d "$work_root" ]; then
    rm -rf -- "$work_root"
  fi
}

handle_signal() {
  signal_number=$1
  if [ -n "$active_child" ]; then
    kill -TERM "$active_child" 2>/dev/null || true
    wait "$active_child" 2>/dev/null || true
    active_child=
  fi
  cleanup
  trap - EXIT HUP INT TERM
  exit "$signal_number"
}

trap cleanup EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--channel|--architecture|--destination|--manifest-url)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --version) version=$2 ;;
        --channel) channel=$2 ;;
        --architecture) architecture=$2 ;;
        --destination) destination=$2 ;;
        --manifest-url) manifest_url=$2; manifest_override=true ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage 0
      ;;
    *)
      usage
      ;;
  esac
done

[ -n "$version" ] && [ -n "$channel" ] && [ -n "$architecture" ] &&
  [ -n "$destination" ] || usage

case "$version" in
  *[!0-9A-Za-z.+-]*|'') die 'version must be an exact Flutter release version' ;;
esac
printf '%s\n' "$version" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+([.+-][0-9A-Za-z.-]+)?$' \
  >/dev/null 2>&1 || die 'version must be an exact Flutter release version'
case "$channel" in stable|beta) ;; *) die 'channel must be stable or beta' ;; esac
case "$architecture" in x64|arm64) ;; *) die 'architecture must be x64 or arm64' ;; esac

test_mode=${FPRS_TEST_MODE:-0}
if [ "$manifest_override" = true ]; then
  [ "$test_mode" = 1 ] || die '--manifest-url is available only in test mode'
  case "$manifest_url" in file://*) ;; *) die 'test manifest URL must use file://' ;; esac
elif [ "$manifest_url" != "$OFFICIAL_MANIFEST_URL" ]; then
  die 'production manifest trust root cannot be replaced'
fi

destination_parent=$(dirname -- "$destination")
destination_leaf=$(basename -- "$destination")
[ "$destination_leaf" != '.' ] && [ "$destination_leaf" != '..' ] &&
  [ "$destination_leaf" != '/' ] || die 'invalid destination'
[ -d "$destination_parent" ] && [ ! -L "$destination_parent" ] ||
  die 'destination parent must be an existing real directory'
destination_parent=$(CDPATH= cd -- "$destination_parent" && pwd -P) ||
  die 'cannot resolve destination parent'
destination=$destination_parent/$destination_leaf

destination_mode=absent
destination_dev=
destination_ino=
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -d "$destination" ] && [ ! -L "$destination" ] ||
    die 'existing destination must be a real empty directory'
  if find "$destination" -mindepth 1 -maxdepth 1 -print -quit | grep . >/dev/null 2>&1; then
    die 'existing destination is not empty; preserving it'
  fi
  destination_mode=empty
  destination_identity=$(python3 - "$destination" <<'PY'
import os, sys
value = os.lstat(sys.argv[1])
print(f"{value.st_dev} {value.st_ino}")
PY
  ) || die 'cannot inspect existing destination'
  destination_dev=${destination_identity%% *}
  destination_ino=${destination_identity#* }
fi

umask 077
work_root=$(mktemp -d "$destination_parent/.flutter-sdk-install.XXXXXX") ||
  die 'cannot create private installation staging directory'
chmod 700 "$work_root" || die 'cannot protect staging directory'
manifest_file=$work_root/releases_linux.json
archive_file=$work_root/flutter-sdk.tar.xz
metadata_dir=$work_root/metadata
extract_root=$work_root/extracted
mkdir -m 700 "$metadata_dir" "$extract_root" || die 'cannot prepare private staging directories'

download_to() {
  source_url=$1
  output_path=$2
  case "$source_url" in
    file://*)
      [ "$test_mode" = 1 ] || die 'file downloads are available only in test mode'
      cp -- "${source_url#file://}" "$output_path" || die 'local fixture download failed'
      ;;
    https://*)
      curl --fail --silent --show-error --location \
        --proto '=https' --proto-redir '=https' --retry 0 \
        --output "$output_path" "$source_url" || die 'HTTPS download failed'
      ;;
    *)
      die 'download URL must use HTTPS'
      ;;
  esac
}

download_to "$manifest_url" "$manifest_file"

if ! OFFICIAL_BASE_URL=$OFFICIAL_BASE_URL FPRS_TEST_MODE=$test_mode \
  python3 - "$manifest_file" "$metadata_dir" "$version" "$channel" "$architecture" <<'PY'
import json, os, pathlib, re, sys

manifest_path, output_dir, version, channel, architecture = sys.argv[1:]
with open(manifest_path, "rb") as handle:
    manifest = json.load(handle)
if not isinstance(manifest, dict) or not isinstance(manifest.get("releases"), list):
    raise SystemExit("invalid Flutter release manifest")
base_url = manifest.get("base_url")
official = os.environ["OFFICIAL_BASE_URL"]
test_mode = os.environ.get("FPRS_TEST_MODE") == "1"
if base_url != official:
    if not (test_mode and isinstance(base_url, str) and base_url.startswith("file://")):
        raise SystemExit("manifest base_url does not match the fixed trust root")

matches = []
for release in manifest["releases"]:
    if not isinstance(release, dict):
        continue
    if (release.get("version"), release.get("channel"), release.get("dart_sdk_arch")) == (
        version, channel, architecture
    ):
        matches.append(release)
if len(matches) != 1:
    raise SystemExit(f"expected exactly one release match, found {len(matches)}")
release = matches[0]
archive = release.get("archive")
checksum = release.get("sha256")
if not isinstance(archive, str) or not archive or "\\" in archive or "\0" in archive:
    raise SystemExit("invalid release archive path")
pure = pathlib.PurePosixPath(archive)
if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
    raise SystemExit("release archive path is not a contained relative path")
if str(pure) != archive:
    raise SystemExit("release archive path is not normalized")
if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
    raise SystemExit("invalid release SHA-256")
for name, value in (("base_url", base_url), ("archive", archive), ("sha256", checksum.lower())):
    target = os.path.join(output_dir, name)
    with open(target, "x", encoding="utf-8", newline="") as handle:
        handle.write(value)
    os.chmod(target, 0o600)
PY
then
  die 'manifest validation failed'
fi

base_url=$(cat "$metadata_dir/base_url")
archive_path=$(cat "$metadata_dir/archive")
expected_sha=$(cat "$metadata_dir/sha256")
download_to "$base_url/$archive_path" "$archive_file"

actual_sha=$(python3 - "$archive_file" <<'PY'
import hashlib, sys
digest = hashlib.sha256()
with open(sys.argv[1], "rb") as handle:
    for block in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(block)
print(digest.hexdigest())
PY
) || die 'cannot calculate archive SHA-256'
[ "$actual_sha" = "$expected_sha" ] || die 'Flutter archive SHA-256 mismatch'

python3 - "$archive_file" "$extract_root" <<'PY' || die 'unsafe or invalid Flutter archive'
import copy, os, posixpath, tarfile, sys

archive_path, extract_root = sys.argv[1:]
if not hasattr(tarfile, "data_filter"):
    raise SystemExit("Python tarfile.data_filter support is required")

def normalized_member(name):
    if not isinstance(name, str) or not name or "\\" in name or "\0" in name or name.startswith("/"):
        raise ValueError("absolute or malformed archive member")
    if any(component in (".", "..") for component in name.split("/")):
        raise ValueError("raw archive member contains a dot path component")
    value = posixpath.normpath(name)
    if value in ("", ".", "..") or value.startswith("../"):
        raise ValueError("archive member escapes extraction root")
    if value != "flutter" and not value.startswith("flutter/"):
        raise ValueError("archive member is outside flutter/")
    return value

def contained_link(member, normalized):
    target = member.linkname
    if not target or "\\" in target or "\0" in target or target.startswith("/"):
        raise ValueError("absolute or malformed archive link")
    if any(component in (".", "..") for component in target.split("/")):
        raise ValueError("raw archive link contains a dot path component")
    if member.issym():
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(normalized), target))
    else:
        resolved = posixpath.normpath(target)
    if resolved != "flutter" and not resolved.startswith("flutter/"):
        raise ValueError("archive link escapes flutter/")

with tarfile.open(archive_path, "r:*") as archive:
    members = archive.getmembers()
    seen = set()
    safe = []
    for member in members:
        normalized = normalized_member(member.name)
        if normalized in seen:
            raise ValueError("duplicate normalized archive member")
        seen.add(normalized)
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError("special archive member is forbidden")
        if member.mode & 0o7000:
            raise ValueError("privileged archive mode is forbidden")
        if member.uid < 0 or member.gid < 0 or member.uid >= 2**31 or member.gid >= 2**31:
            raise ValueError("unsafe archive ownership metadata")
        if any(str(key).startswith(("GNU.sparse", "SCHILY.dev", "security.")) for key in member.pax_headers):
            raise ValueError("unsafe extended archive metadata")
        if member.issym() or member.islnk():
            contained_link(member, normalized)
        filtered = tarfile.data_filter(member, extract_root)
        if filtered is None:
            continue
        try:
            filtered = filtered.replace(uid=None, gid=None, uname=None, gname=None, deep=False)
        except AttributeError:
            filtered = copy.copy(filtered)
            filtered.uid = filtered.gid = filtered.uname = filtered.gname = None
        safe.append(filtered)
    if "flutter" not in seen or "flutter/bin/flutter" not in seen:
        raise ValueError("archive does not contain the Flutter executable")
    archive.extractall(extract_root, members=safe, filter=tarfile.data_filter)

flutter_root = os.path.realpath(os.path.join(extract_root, "flutter"))
if os.path.commonpath((os.path.realpath(extract_root), flutter_root)) != os.path.realpath(extract_root):
    raise SystemExit("extracted Flutter root escapes staging")
PY

flutter_binary=$extract_root/flutter/bin/flutter
[ -f "$flutter_binary" ] && [ ! -L "$flutter_binary" ] && [ -x "$flutter_binary" ] ||
  die 'verified archive did not produce an executable flutter/bin/flutter'
version_output=$work_root/flutter-version.json
set +e
FLUTTER_SUPPRESS_ANALYTICS=true "$flutter_binary" --version --machine >"$version_output" 2>/dev/null &
active_child=$!
wait "$active_child"
flutter_status=$?
active_child=
set -e
[ "$flutter_status" -eq 0 ] || die 'extracted Flutter executable failed version verification'
python3 - "$version_output" "$version" <<'PY' || die 'extracted Flutter version does not match request'
import json, sys
with open(sys.argv[1], "rb") as handle:
    value = json.load(handle)
if not isinstance(value, dict) or value.get("frameworkVersion") != sys.argv[2]:
    raise SystemExit(1)
PY

python3 - "$extract_root/flutter" "$destination" "$destination_mode" \
  "$destination_dev" "$destination_ino" <<'PY' || die 'could not publish verified Flutter SDK atomically'
import ctypes, errno, os, platform, sys

source, destination, mode, expected_dev, expected_ino = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
AT_FDCWD = -2

def native_rename(old, new, flag):
    system = platform.system()
    if system == "Linux" and hasattr(libc, "renameat2"):
        call = libc.renameat2
        call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    elif system == "Darwin" and hasattr(libc, "renameatx_np"):
        call = libc.renameatx_np
        call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    else:
        raise OSError(errno.ENOTSUP, "atomic rename flags are unavailable")
    if call(AT_FDCWD, os.fsencode(old), AT_FDCWD, os.fsencode(new), flag) != 0:
        value = ctypes.get_errno()
        raise OSError(value, os.strerror(value))

if mode == "absent":
    native_rename(source, destination, 1 if platform.system() == "Linux" else 4)
else:
    before = os.lstat(destination)
    if (before.st_dev, before.st_ino) != (int(expected_dev), int(expected_ino)):
        raise SystemExit("existing empty destination changed during installation")
    native_rename(source, destination, 2)
    moved = os.lstat(source)
    if (moved.st_dev, moved.st_ino) != (int(expected_dev), int(expected_ino)) or os.listdir(source):
        native_rename(source, destination, 2)
        raise SystemExit("existing destination changed during atomic publication")
    os.rmdir(source)
PY

printf 'Installed Flutter %s (%s/%s) at %s\n' \
  "$version" "$channel" "$architecture" "$destination"
