#!/usr/bin/env bash
# Provide validated package synchronization and recovery primitives.
#!/usr/bin/env bash
# Synchronize verified package copies with an atomic dual-destination lifecycle.

fprs_package_sync_main() {
  if [ "$#" -ne 4 ]; then
    printf 'ERROR: package lifecycle received an invalid invocation\n' >&2
    return 2
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'ERROR: Python 3 is required for the package lifecycle\n' >&2
    return 1
  fi
  fprs_package_sync_old_hup=$(trap -p HUP)
  fprs_package_sync_old_int=$(trap -p INT)
  fprs_package_sync_old_term=$(trap -p TERM)
  FPRS_PACKAGE_SYNC_SIGNALLED=0
  python3 - "$@" <<'PY' &
import contextlib
import ctypes
import errno
import hashlib
import os
import re
import shutil
import signal
import socket
import stat
import sys
import time
import uuid

PACKAGE_ID = "toris-flutter-play-store-release"
SCHEMA = "1"
RECEIPT = ".skill-install-receipt"
STATE_NAME = ".toris-flutter-play-store-release-install-state"
MANIFEST = "install-manifest.txt"
IDENTITY = ".skill-package-id"
EXPECTED_IDENTITY = b"package_id=toris-flutter-play-store-release\nschema_version=1\n"
REQUIRED_EXECUTABLES = {
    "install.sh", "update.sh", "uninstall.sh",
    "scripts/bootstrap_android_fastlane.sh",
    "scripts/decode_secret.sh", "scripts/encode_secret.sh",
    "scripts/inspect_flutter_project.sh",
    "scripts/install_flutter_sdk.sh",
    "scripts/validate_release_setup.sh",
}
JOURNAL_KEYS = [
    "schema_version", "package_id", "transaction_id", "operation", "phase",
    "claude_existed", "claude_destination", "claude_stage", "claude_rollback",
    "claude_quarantine", "agents_existed", "agents_destination", "agents_stage",
    "agents_rollback", "agents_quarantine",
]
INSTALL_PHASES = [
    "staged", "claude_old_moved", "agents_old_moved",
    "claude_new_installed", "agents_new_installed", "validated", "committed",
]
UNINSTALL_PHASES = [
    "planned", "claude_quarantined", "agents_quarantined", "committed",
    "cleanup_complete",
]


class LifecycleError(Exception):
    status = 1


class Refusal(LifecycleError):
    status = 2


class TransactionError(LifecycleError):
    status = 3


class LifecycleSignal(BaseException):
    pass


def caught_signal(signum, frame):
    raise LifecycleSignal(signum)


for caught in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(caught, caught_signal)


def load_atomic_rename():
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        operation = getattr(library, "renameatx_np", None)
        flag = 0x00000004
        at_fdcwd = -2
    elif sys.platform.startswith("linux"):
        operation = getattr(library, "renameat2", None)
        flag = 0x00000001
        at_fdcwd = -100
    else:
        operation = None
        flag = 0
    if operation is None:
        raise LifecycleError("atomic no-replace rename is unavailable on this platform")
    operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    operation.restype = ctypes.c_int

    def rename(source, destination):
        ctypes.set_errno(0)
        result = operation(at_fdcwd, os.fsencode(source), at_fdcwd, os.fsencode(destination), flag)
        if result != 0:
            number = ctypes.get_errno() or errno.EIO
            raise OSError(number, os.strerror(number), destination)
    return rename


atomic_rename = load_atomic_rename()


def refuse(message):
    raise Refusal(message)


def lstat(path):
    try:
        return os.lstat(path)
    except OSError as error:
        if error.errno == errno.ENOENT:
            return None
        raise


def is_present(path):
    return lstat(path) is not None


def require_owned_directory(path, mode=None, label="directory"):
    info = lstat(path)
    if info is None or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        refuse("%s is not a regular directory: %s" % (label, path))
    if info.st_uid != os.getuid():
        refuse("%s is not owned by the current user: %s" % (label, path))
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        refuse("%s must have mode %04o: %s" % (label, mode, path))
    return info


def sha256_file(path):
    digest = hashlib.sha256()
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            refuse("manifest entry is not a regular file: %s" % path)
        with os.fdopen(os.dup(descriptor), "rb") as source:
            for chunk in iter(lambda: source.read(65536), b""):
                digest.update(chunk)
    finally:
        os.close(descriptor)
    return digest.hexdigest()


def safe_relative(value):
    if not value or value.startswith("/") or value.endswith("/"):
        return False
    if "\\" in value or "\x00" in value or "\n" in value or "\r" in value or "\t" in value:
        return False
    components = value.split("/")
    if any(part in ("", ".", "..") for part in components):
        return False
    return all(re.match(r"^[A-Za-z0-9._-]+$", part) for part in components)


def validate_source(source_value, destinations):
    lexical = os.path.abspath(source_value)
    source_info = lstat(lexical)
    if source_info is None or not stat.S_ISDIR(source_info.st_mode) or stat.S_ISLNK(source_info.st_mode):
        refuse("source must be a regular non-symlink directory: %s" % lexical)
    source = os.path.realpath(lexical)
    for destination in destinations:
        destination_real = os.path.realpath(destination)
        try:
            common = os.path.commonpath([source, destination_real])
        except ValueError:
            common = ""
        if common in (source, destination_real):
            refuse("source and installed destinations must not overlap")

    identity_path = os.path.join(source, IDENTITY)
    identity_info = lstat(identity_path)
    if identity_info is None or not stat.S_ISREG(identity_info.st_mode) or stat.S_ISLNK(identity_info.st_mode):
        refuse("source package identity is missing or unsafe")
    with open(identity_path, "rb") as identity_file:
        if identity_file.read() != EXPECTED_IDENTITY:
            refuse("source package identity does not match %s schema %s" % (PACKAGE_ID, SCHEMA))

    manifest_path = os.path.join(source, MANIFEST)
    manifest_info = lstat(manifest_path)
    if manifest_info is None or not stat.S_ISREG(manifest_info.st_mode) or stat.S_ISLNK(manifest_info.st_mode):
        refuse("source install manifest is missing or unsafe")
    try:
        with open(manifest_path, "r", encoding="utf-8", newline="") as manifest_file:
            manifest_text = manifest_file.read()
    except UnicodeError:
        refuse("source install manifest must be UTF-8")
    if "\r" in manifest_text or not manifest_text.endswith("\n"):
        refuse("source install manifest must use newline-terminated LF records")
    entries = manifest_text.splitlines()
    if not entries or entries != sorted(entries) or len(entries) != len(set(entries)):
        refuse("source install manifest must be sorted and unique")
    if IDENTITY not in entries or MANIFEST not in entries or "scripts/lib/package_sync.sh" not in entries:
        refuse("source install manifest is missing lifecycle identity files")

    metadata = []
    for relative in entries:
        if not safe_relative(relative):
            refuse("unsafe install manifest entry: %s" % relative)
        current = source
        for component in relative.split("/")[:-1]:
            current = os.path.join(current, component)
            info = lstat(current)
            if info is None or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                refuse("manifest parent is missing or unsafe: %s" % relative)
        path = os.path.join(source, relative)
        info = lstat(path)
        if info is None or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            refuse("manifest entry is missing or unsafe: %s" % relative)
        mode = stat.S_IMODE(info.st_mode)
        if mode & 0o022 or mode & ~0o777:
            refuse("manifest entry has an unsafe mode: %s" % relative)
        if relative in REQUIRED_EXECUTABLES and not mode & 0o100:
            refuse("manifest entry must be executable: %s" % relative)
        metadata.append((relative, mode, sha256_file(path)))
    return source, metadata


def receipt_bytes(metadata):
    lines = ["package_id=%s" % PACKAGE_ID, "schema_version=%s" % SCHEMA]
    for relative, mode, digest in metadata:
        lines.append("file\t%04o\t%s\t%s" % (mode, digest, relative))
    return ("\n".join(lines) + "\n").encode("utf-8")


def parse_receipt(path):
    info = lstat(path)
    if info is None or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        refuse("installed receipt is missing or unsafe: %s" % path)
    if stat.S_IMODE(info.st_mode) != 0o644:
        refuse("installed receipt mode is invalid: %s" % path)
    try:
        with open(path, "r", encoding="utf-8", newline="") as receipt_file:
            text = receipt_file.read()
    except UnicodeError:
        refuse("installed receipt is not UTF-8: %s" % path)
    if "\r" in text or not text.endswith("\n"):
        refuse("installed receipt format is invalid: %s" % path)
    lines = text.splitlines()
    if lines[:2] != ["package_id=" + PACKAGE_ID, "schema_version=" + SCHEMA]:
        refuse("installed receipt identity is invalid: %s" % path)
    metadata = []
    for line in lines[2:]:
        fields = line.split("\t")
        if len(fields) != 4 or fields[0] != "file" or not re.match(r"^[0-7]{4}$", fields[1]):
            refuse("installed receipt record is invalid: %s" % path)
        relative = fields[3]
        digest = fields[2]
        if not safe_relative(relative) or not re.match(r"^[0-9a-f]{64}$", digest):
            refuse("installed receipt record is unsafe: %s" % path)
        metadata.append((relative, int(fields[1], 8), digest))
    paths = [record[0] for record in metadata]
    if not paths or paths != sorted(paths) or len(paths) != len(set(paths)):
        refuse("installed receipt paths are not sorted and unique: %s" % path)
    return text.encode("utf-8"), metadata


def expected_directories(paths):
    result = set()
    for relative in paths:
        parts = relative.split("/")[:-1]
        for index in range(1, len(parts) + 1):
            result.add("/".join(parts[:index]))
    return result


def validate_installed(destination):
    top = lstat(destination)
    if top is None or not stat.S_ISDIR(top.st_mode) or stat.S_ISLNK(top.st_mode):
        refuse("installed destination is not a regular directory: %s" % destination)
    receipt, metadata = parse_receipt(os.path.join(destination, RECEIPT))
    paths = [record[0] for record in metadata]
    if IDENTITY not in paths or MANIFEST not in paths:
        refuse("installed receipt is missing package identity files: %s" % destination)

    for relative, mode, digest in metadata:
        path = os.path.join(destination, relative)
        info = lstat(path)
        if info is None or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            refuse("installed manifest entry is missing or unsafe: %s" % relative)
        if stat.S_IMODE(info.st_mode) != mode:
            refuse("installed manifest entry mode changed: %s" % relative)
        if sha256_file(path) != digest:
            refuse("installed manifest entry content changed: %s" % relative)

    with open(os.path.join(destination, IDENTITY), "rb") as identity_file:
        if identity_file.read() != EXPECTED_IDENTITY:
            refuse("installed package identity changed: %s" % destination)
    with open(os.path.join(destination, MANIFEST), "r", encoding="utf-8", newline="") as manifest_file:
        installed_manifest = manifest_file.read()
    if installed_manifest != "".join(relative + "\n" for relative in paths):
        refuse("installed manifest and receipt disagree: %s" % destination)

    actual_files = set()
    actual_directories = set()
    for root, directories, files in os.walk(destination, topdown=True, followlinks=False):
        relative_root = os.path.relpath(root, destination)
        if relative_root == ".":
            relative_root = ""
        for name in list(directories):
            path = os.path.join(root, name)
            info = lstat(path)
            relative = name if not relative_root else relative_root + "/" + name
            if info is None or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                refuse("unexpected installed symlink or non-directory: %s" % relative)
            actual_directories.add(relative)
        for name in files:
            path = os.path.join(root, name)
            info = lstat(path)
            relative = name if not relative_root else relative_root + "/" + name
            if info is None or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                refuse("unexpected installed symlink or non-file: %s" % relative)
            actual_files.add(relative)
    expected_files = set(paths)
    expected_files.add(RECEIPT)
    if actual_files != expected_files:
        refuse("installed tree contains missing or unexpected files: %s" % destination)
    if actual_directories != expected_directories(paths):
        refuse("installed tree contains missing or unexpected directories: %s" % destination)
    return receipt, metadata, (top.st_dev, top.st_ino)


def validate_destination(destination):
    info = lstat(destination)
    if info is None:
        return None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        refuse("destination exists but is not a regular installed package: %s" % destination)
    return validate_installed(destination)


def make_parent(path):
    # The fixed destination parents are created one component at a time without
    # accepting a symlink at any existing component.
    missing = []
    cursor = path
    while lstat(cursor) is None:
        missing.append(cursor)
        parent = os.path.dirname(cursor)
        if parent == cursor:
            raise LifecycleError("could not find a destination parent")
        cursor = parent
    info = lstat(cursor)
    if info is None or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        refuse("destination parent chain is unsafe: %s" % cursor)
    for directory in reversed(missing):
        os.mkdir(directory, 0o755)
    cursor = path
    while cursor:
        info = lstat(cursor)
        if info is None or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            refuse("destination parent is unsafe: %s" % cursor)
        if cursor == os.path.dirname(cursor):
            break
        cursor = os.path.dirname(cursor)


def copy_regular(source_path, destination_path, mode, expected_digest):
    source_flags = os.O_RDONLY
    destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        source_flags |= os.O_NOFOLLOW
        destination_flags |= os.O_NOFOLLOW
    source_fd = os.open(source_path, source_flags)
    destination_fd = None
    digest = hashlib.sha256()
    try:
        source_info = os.fstat(source_fd)
        if not stat.S_ISREG(source_info.st_mode) or stat.S_IMODE(source_info.st_mode) != mode:
            raise LifecycleError("source changed while staging: %s" % source_path)
        destination_fd = os.open(destination_path, destination_flags, 0o600)
        while True:
            chunk = os.read(source_fd, 65536)
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                view = view[written:]
        if digest.hexdigest() != expected_digest:
            raise LifecycleError("source changed while staging: %s" % source_path)
        os.fchmod(destination_fd, mode)
        os.fsync(destination_fd)
    finally:
        if destination_fd is not None:
            os.close(destination_fd)
        os.close(source_fd)


def build_stage(source, metadata, stage):
    os.mkdir(stage, 0o700)
    created = set()
    for relative, mode, digest in metadata:
        parent_relative = os.path.dirname(relative)
        if parent_relative and parent_relative not in created:
            cursor = stage
            accumulated = []
            for component in parent_relative.split("/"):
                accumulated.append(component)
                key = "/".join(accumulated)
                cursor = os.path.join(cursor, component)
                if key not in created:
                    os.mkdir(cursor, 0o755)
                    created.add(key)
        copy_regular(os.path.join(source, relative), os.path.join(stage, relative), mode, digest)
    receipt_path = os.path.join(stage, RECEIPT)
    descriptor = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        payload = receipt_bytes(metadata)
        view = memoryview(payload)
        while view:
            view = view[os.write(descriptor, view):]
        os.fchmod(descriptor, 0o644)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(stage, 0o755)
    validate_installed(stage)


def parse_key_file(path, expected_keys):
    info = lstat(path)
    if info is None or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        refuse("lifecycle owner record is missing or unsafe")
    values = {}
    with open(path, "r", encoding="utf-8", newline="") as source:
        for line in source.read().splitlines():
            if "=" not in line:
                refuse("lifecycle owner record is malformed")
            key, value = line.split("=", 1)
            if key not in expected_keys or key in values or not value:
                refuse("lifecycle owner record is malformed")
            values[key] = value
    if set(values) != set(expected_keys):
        refuse("lifecycle owner record is incomplete")
    return values


def process_identity(pid):
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/%d/stat" % pid, "r", encoding="ascii") as source:
                raw = source.read().strip()
            closing = raw.rfind(")")
            fields = raw[closing + 2:].split() if closing >= 0 else []
            start_ticks = fields[19] if len(fields) > 19 else ""
            if re.match(r"^[0-9]+$", start_ticks):
                return "linux-proc-start:" + start_ticks
        except (OSError, UnicodeError):
            return None
    elif sys.platform == "darwin":
        try:
            fields = [
                ("flags", ctypes.c_uint32), ("status", ctypes.c_uint32),
                ("xstatus", ctypes.c_uint32), ("pid", ctypes.c_uint32),
                ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32),
                ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32),
                ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32),
                ("svgid", ctypes.c_uint32), ("rfu", ctypes.c_uint32),
                ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
                ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32),
                ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32),
                ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32),
                ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64),
            ]
            bsd_info_type = type("ProcBsdInfo", (ctypes.Structure,), {"_fields_": fields})
            library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            operation = library.proc_pidinfo
            operation.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
            operation.restype = ctypes.c_int
            info = bsd_info_type()
            copied = operation(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
            if copied == ctypes.sizeof(info) and info.pid == pid and info.start_sec > 0:
                return "darwin-libproc-start:%d:%d" % (info.start_sec, info.start_usec)
        except (AttributeError, OSError):
            return None
    return None


def valid_process_identity(value):
    return bool(
        re.match(r"^linux-proc-start:[0-9]+$", value) or
        re.match(r"^darwin-libproc-start:[0-9]+:[0-9]+$", value)
    )


class LifecycleLock:
    def __init__(self, state_root):
        self.state_root = state_root
        self.path = os.path.join(state_root, "lock")
        self.token = uuid.uuid4().hex
        self.held = False

    def validate_state(self):
        require_owned_directory(self.state_root, 0o700, "lifecycle state directory")
        allowed = {"lock", "transaction"}
        unexpected = set(os.listdir(self.state_root)) - allowed
        if unexpected:
            refuse("lifecycle state contains unexpected entries; inspect %s" % self.state_root)

    def acquire(self):
        owner_identity = process_identity(os.getpid())
        if owner_identity is None:
            raise LifecycleError("cannot prove lifecycle process identity; manually inspect %s" % self.state_root)
        if lstat(self.state_root) is None:
            os.mkdir(self.state_root, 0o700)
        self.validate_state()
        try:
            os.mkdir(self.path, 0o700)
        except OSError as error:
            if error.errno != errno.EEXIST:
                raise
            self.reclaim_or_refuse()
            os.mkdir(self.path, 0o700)
        owner_path = os.path.join(self.path, "owner")
        owner = (
            "schema_version=1\n"
            "token=%s\n"
            "host=%s\n"
            "pid=%d\n"
            "process_identity=%s\n"
        ) % (self.token, socket.gethostname(), os.getpid(), owner_identity)
        descriptor = os.open(owner_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(descriptor, owner.encode("utf-8"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        self.held = True

    def reclaim_or_refuse(self):
        require_owned_directory(self.path, 0o700, "lifecycle lock")
        if set(os.listdir(self.path)) != {"owner"}:
            refuse("lifecycle lock is incomplete; inspect %s" % self.path)
        owner = parse_key_file(os.path.join(self.path, "owner"),
            ["schema_version", "token", "host", "pid", "process_identity"])
        if owner["schema_version"] != "1" or owner["host"] != socket.gethostname():
            refuse("lifecycle lock ownership cannot be proved; inspect %s" % self.path)
        if not valid_process_identity(owner["process_identity"]):
            refuse("lifecycle lock process identity is invalid; inspect %s" % self.path)
        try:
            pid = int(owner["pid"])
            if pid <= 0:
                raise ValueError()
        except ValueError:
            refuse("lifecycle lock PID is invalid; inspect %s" % self.path)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            shutil.rmtree(self.path)
            return
        except PermissionError:
            refuse("lifecycle lock process cannot be checked; inspect %s" % self.path)
        live_identity = process_identity(pid)
        if live_identity is None:
            refuse("lifecycle lock process identity cannot be proved; inspect %s" % self.path)
        if live_identity == owner["process_identity"]:
            refuse("another package lifecycle operation is running (PID %d)" % pid)
        shutil.rmtree(self.path)

    def release(self):
        if not self.held:
            return
        owner_path = os.path.join(self.path, "owner")
        owner = parse_key_file(owner_path,
            ["schema_version", "token", "host", "pid", "process_identity"])
        if owner["token"] != self.token:
            refuse("lifecycle lock ownership changed; inspect %s" % self.path)
        os.unlink(owner_path)
        os.rmdir(self.path)
        self.held = False


@contextlib.contextmanager
def locked(state_root):
    lock = LifecycleLock(state_root)
    lock.acquire()
    try:
        yield
    finally:
        lock.release()
        try:
            os.rmdir(state_root)
        except OSError:
            pass


def journal_write(path, record):
    if set(record) != set(JOURNAL_KEYS):
        raise LifecycleError("internal journal schema mismatch")
    parent = os.path.dirname(path)
    temporary = os.path.join(parent, ".transaction.%s.tmp" % uuid.uuid4().hex)
    payload = "".join("%s=%s\n" % (key, record[key]) for key in JOURNAL_KEYS)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, payload.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    directory_fd = os.open(parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def journal_read(path, destinations):
    info = lstat(path)
    if info is None or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        refuse("transaction journal is missing or unsafe: %s" % path)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        refuse("transaction journal ownership or mode is unsafe: %s" % path)
    values = {}
    try:
        with open(path, "r", encoding="utf-8", newline="") as source:
            text = source.read()
    except UnicodeError:
        refuse("transaction journal must be UTF-8")
    if "\r" in text or not text.endswith("\n"):
        refuse("transaction journal format is invalid")
    for line in text.splitlines():
        if "=" not in line:
            refuse("transaction journal record is invalid")
        key, value = line.split("=", 1)
        if key not in JOURNAL_KEYS or key in values:
            refuse("transaction journal contains unknown or duplicate keys")
        values[key] = value
    if set(values) != set(JOURNAL_KEYS):
        refuse("transaction journal is incomplete")
    if values["schema_version"] != SCHEMA or values["package_id"] != PACKAGE_ID:
        refuse("transaction journal package identity is invalid")
    transaction_id = values["transaction_id"]
    if not re.match(r"^[0-9a-f]{32}$", transaction_id):
        refuse("transaction journal ID is invalid")
    operation = values["operation"]
    phases = INSTALL_PHASES if operation in ("install", "update") else UNINSTALL_PHASES if operation == "uninstall" else []
    if values["phase"] not in phases:
        refuse("transaction journal operation or phase is invalid")
    roles = ("claude", "agents")
    for index, role in enumerate(roles):
        if values[role + "_existed"] not in ("0", "1"):
            refuse("transaction journal prior-state flag is invalid")
        if values[role + "_destination"] != destinations[index]:
            refuse("transaction journal destination is invalid")
        parent = os.path.dirname(destinations[index])
        expected = {
            "stage": os.path.join(parent, ".%s.%s.%s.stage" % (PACKAGE_ID, transaction_id, role)),
            "rollback": os.path.join(parent, ".%s.%s.%s.rollback" % (PACKAGE_ID, transaction_id, role)),
            "quarantine": os.path.join(parent, ".%s.%s.%s.quarantine" % (PACKAGE_ID, transaction_id, role)),
        }
        for kind in ("stage", "rollback", "quarantine"):
            value = values[role + "_" + kind]
            wanted = expected[kind] if ((operation in ("install", "update") and kind != "quarantine") or (operation == "uninstall" and kind == "quarantine")) else ""
            if value != wanted:
                refuse("transaction journal %s path is invalid" % kind)
    return values


def journal_remove(path):
    info = lstat(path)
    if info is None:
        return
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        refuse("transaction journal changed during cleanup")
    os.unlink(path)


def checkpoint(record, path):
    journal_write(path, record)
    if os.environ.get("FPRS_TEST_MODE") != "1":
        return
    phase = record["phase"]
    control = os.environ.get("FPRS_TEST_CONTROL_DIR", "")
    pause = os.environ.get("FPRS_TEST_PAUSE_INSTALL_PHASE", "")
    if control and pause == phase:
        require_owned_directory(control, label="test control directory")
        ready = os.path.join(control, phase + ".ready")
        with open(ready + ".new", "w", encoding="ascii") as marker:
            marker.write("ready\n")
        os.replace(ready + ".new", ready)
        continuation = os.path.join(control, phase + ".continue")
        while not os.path.exists(continuation):
            time.sleep(0.01)
    if os.environ.get("FPRS_TEST_KILL_INSTALL_PHASE") == phase:
        os.kill(os.getpid(), 9)
    if os.environ.get("FPRS_TEST_SIGNAL_INSTALL_PHASE") == phase:
        signal_name = os.environ.get("FPRS_TEST_SIGNAL_NAME", "TERM")
        signal_number = {"HUP": signal.SIGHUP, "INT": signal.SIGINT, "TERM": signal.SIGTERM}.get(signal_name)
        if signal_number is None:
            raise TransactionError("invalid injected lifecycle signal")
        os.kill(os.getpid(), signal_number)
    if os.environ.get("FPRS_TEST_FAIL_INSTALL_PHASE") == phase:
        raise TransactionError("injected lifecycle failure after %s" % phase)


def remove_verified(path):
    if not is_present(path):
        return
    validate_installed(path)
    shutil.rmtree(path)


def synchronized_with(metadata, installed):
    return installed is not None and installed[0] == receipt_bytes(metadata)


def transaction_record(operation, transaction_id, current, destinations):
    roles = ("claude", "agents")
    record = {
        "schema_version": SCHEMA,
        "package_id": PACKAGE_ID,
        "transaction_id": transaction_id,
        "operation": operation,
        "phase": "staged" if operation in ("install", "update") else "planned",
    }
    for index, role in enumerate(roles):
        parent = os.path.dirname(destinations[index])
        record[role + "_existed"] = "1" if current[index] is not None else "0"
        record[role + "_destination"] = destinations[index]
        record[role + "_stage"] = os.path.join(parent,
            ".%s.%s.%s.stage" % (PACKAGE_ID, transaction_id, role)) if operation in ("install", "update") else ""
        record[role + "_rollback"] = os.path.join(parent,
            ".%s.%s.%s.rollback" % (PACKAGE_ID, transaction_id, role)) if operation in ("install", "update") else ""
        record[role + "_quarantine"] = os.path.join(parent,
            ".%s.%s.%s.quarantine" % (PACKAGE_ID, transaction_id, role)) if operation == "uninstall" else ""
    return record


def recover_install_precommit(record, journal_path):
    for role in ("claude", "agents"):
        destination = record[role + "_destination"]
        stage = record[role + "_stage"]
        rollback = record[role + "_rollback"]
        existed = record[role + "_existed"] == "1"
        if is_present(rollback):
            validate_installed(rollback)
            if is_present(destination):
                validate_installed(destination)
                if is_present(stage):
                    remove_verified(stage)
                atomic_rename(destination, stage)
            atomic_rename(rollback, destination)
        elif existed:
            if not is_present(destination):
                raise LifecycleError("recovery is missing the prior %s installation" % role)
            validate_installed(destination)
        elif is_present(destination):
            validate_installed(destination)
            if is_present(stage):
                remove_verified(stage)
            atomic_rename(destination, stage)
        if is_present(stage):
            remove_verified(stage)
        if is_present(rollback):
            raise LifecycleError("recovery retained an unexpected %s rollback" % role)
    journal_remove(journal_path)


def finish_install_commit(record, journal_path):
    destinations = [record["claude_destination"], record["agents_destination"]]
    installed = [validate_installed(path) for path in destinations]
    if installed[0][0] != installed[1][0]:
        raise LifecycleError("committed installed copies differ; recovery evidence was retained")
    for role in ("claude", "agents"):
        stage = record[role + "_stage"]
        rollback = record[role + "_rollback"]
        if is_present(stage):
            remove_verified(stage)
        if is_present(rollback):
            remove_verified(rollback)
    journal_remove(journal_path)


def recover_uninstall_precommit(record, journal_path):
    for role in ("claude", "agents"):
        destination = record[role + "_destination"]
        quarantine = record[role + "_quarantine"]
        existed = record[role + "_existed"] == "1"
        if existed and is_present(quarantine):
            validate_installed(quarantine)
            if is_present(destination):
                raise LifecycleError("cannot restore %s because its destination is occupied" % role)
            atomic_rename(quarantine, destination)
        elif existed:
            if not is_present(destination):
                raise LifecycleError("recovery is missing the prior %s installation" % role)
            validate_installed(destination)
        elif is_present(destination) or is_present(quarantine):
            raise LifecycleError("recovery found unexpected %s installation content" % role)
    journal_remove(journal_path)


def finish_uninstall_commit(record, journal_path):
    for role in ("claude", "agents"):
        destination = record[role + "_destination"]
        quarantine = record[role + "_quarantine"]
        if is_present(destination):
            raise LifecycleError("committed uninstall destination reappeared: %s" % destination)
        if is_present(quarantine):
            if os.environ.get("FPRS_TEST_MODE") == "1" and os.environ.get("FPRS_TEST_FAIL_UNINSTALL_CLEANUP") == role:
                raise LifecycleError("injected %s quarantine cleanup failure" % role)
            remove_verified(quarantine)
    record["phase"] = "cleanup_complete"
    checkpoint(record, journal_path)
    journal_remove(journal_path)


def recover_transaction(journal_path, destinations):
    record = journal_read(journal_path, destinations)
    if record["operation"] in ("install", "update"):
        if record["phase"] == "committed":
            finish_install_commit(record, journal_path)
        else:
            recover_install_precommit(record, journal_path)
    elif record["phase"] in ("committed", "cleanup_complete"):
        finish_uninstall_commit(record, journal_path)
    else:
        recover_uninstall_precommit(record, journal_path)
    print("INFO: recovered interrupted %s transaction" % record["operation"], file=sys.stderr)


def synchronize(operation, source, metadata, destinations, journal_path):
    current = [validate_destination(path) for path in destinations]
    if all(synchronized_with(metadata, item) for item in current):
        print("INFO: both installed copies are already synchronized", file=sys.stderr)
        return
    for destination in destinations:
        make_parent(os.path.dirname(destination))
    record = transaction_record(operation, uuid.uuid4().hex, current, destinations)
    artifacts = [record[role + suffix] for role in ("claude", "agents") for suffix in ("_stage", "_rollback")]
    for artifact in artifacts:
        if is_present(artifact):
            refuse("transaction artifact already exists: %s" % artifact)
    try:
        build_stage(source, metadata, record["claude_stage"])
        build_stage(source, metadata, record["agents_stage"])
        if validate_installed(record["claude_stage"])[0] != validate_installed(record["agents_stage"])[0]:
            raise LifecycleError("staged package copies differ")
        checkpoint(record, journal_path)
        for index, role in enumerate(("claude", "agents")):
            if current[index] is not None:
                atomic_rename(record[role + "_destination"], record[role + "_rollback"])
            record["phase"] = role + "_old_moved"
            checkpoint(record, journal_path)
        for role in ("claude", "agents"):
            if os.environ.get("FPRS_TEST_MODE") == "1" and os.environ.get("FPRS_TEST_FAIL_INSTALL_SWAP") == role:
                raise TransactionError("injected %s install swap failure" % role)
            atomic_rename(record[role + "_stage"], record[role + "_destination"])
            record["phase"] = role + "_new_installed"
            checkpoint(record, journal_path)
        installed = [validate_installed(path) for path in destinations]
        if installed[0][0] != installed[1][0]:
            raise LifecycleError("installed package copies differ")
        record["phase"] = "validated"
        checkpoint(record, journal_path)
        record["phase"] = "committed"
        checkpoint(record, journal_path)
        finish_install_commit(record, journal_path)
        print("INFO: %s completed for both installed copies" % operation, file=sys.stderr)
    except BaseException as error:
        if is_present(journal_path):
            saved = journal_read(journal_path, destinations)
            if saved["phase"] == "committed":
                raise TransactionError("%s committed; new copies were preserved and cleanup will resume on the next invocation" % operation) from error
            try:
                recover_install_precommit(saved, journal_path)
            except BaseException as recovery_error:
                raise TransactionError("%s failed and rollback evidence was retained: %s" % (operation, recovery_error)) from error
            raise TransactionError("%s failed; prior installations were restored" % operation) from error
        for role in ("claude", "agents"):
            stage = record[role + "_stage"]
            if is_present(stage):
                remove_verified(stage)
        raise


def uninstall(destinations, journal_path):
    current = [validate_destination(path) for path in destinations]
    if current == [None, None]:
        print("INFO: both installed copies are already absent", file=sys.stderr)
        return
    record = transaction_record("uninstall", uuid.uuid4().hex, current, destinations)
    for role in ("claude", "agents"):
        if is_present(record[role + "_quarantine"]):
            refuse("transaction quarantine already exists: %s" % record[role + "_quarantine"])
    try:
        checkpoint(record, journal_path)
        for index, role in enumerate(("claude", "agents")):
            if current[index] is not None:
                if os.environ.get("FPRS_TEST_MODE") == "1" and os.environ.get("FPRS_TEST_FAIL_UNINSTALL_SWAP") == role:
                    raise TransactionError("injected %s uninstall rename failure" % role)
                atomic_rename(record[role + "_destination"], record[role + "_quarantine"])
            record["phase"] = role + "_quarantined"
            checkpoint(record, journal_path)
        record["phase"] = "committed"
        checkpoint(record, journal_path)
        finish_uninstall_commit(record, journal_path)
        print("INFO: verified installed copies were removed", file=sys.stderr)
    except BaseException as error:
        if is_present(journal_path):
            saved = journal_read(journal_path, destinations)
            if saved["phase"] in ("committed", "cleanup_complete"):
                raise TransactionError("uninstall committed; absent destinations were preserved and cleanup will resume on the next invocation") from error
            try:
                recover_uninstall_precommit(saved, journal_path)
            except BaseException as recovery_error:
                raise TransactionError("uninstall failed and rollback evidence was retained: %s" % recovery_error) from error
            raise TransactionError("uninstall failed; prior installations were restored") from error
        raise


def dry_run(operation, source_value, destinations):
    if operation in ("install", "update"):
        source, metadata = validate_source(source_value, destinations)
        current = [validate_destination(path) for path in destinations]
        action = "no change" if all(synchronized_with(metadata, item) for item in current) else "synchronize both copies"
        print("DRY-RUN: verified source %s; would %s" % (source, action))
    else:
        current = [validate_destination(path) for path in destinations]
        count = sum(item is not None for item in current)
        print("DRY-RUN: would remove %d verified installed cop%s" % (count, "y" if count == 1 else "ies"))


def main():
    if len(sys.argv) != 5:
        raise Refusal("invalid lifecycle invocation")
    operation, source_value, dry_text, confirmed_text = sys.argv[1:]
    if operation not in ("install", "update", "uninstall") or dry_text not in ("0", "1") or confirmed_text not in ("0", "1"):
        raise Refusal("invalid lifecycle invocation")
    home_value = os.environ.get("HOME", "")
    if not home_value or not os.path.isabs(home_value):
        refuse("HOME must be an absolute directory")
    home = os.path.realpath(home_value)
    require_owned_directory(home, label="HOME")
    destinations = [
        os.path.join(home, ".claude", "skills", PACKAGE_ID),
        os.path.join(home, ".agents", "skills", PACKAGE_ID),
    ]
    state_root = os.path.join(home, STATE_NAME)

    if dry_text == "1":
        if is_present(state_root):
            require_owned_directory(state_root, 0o700, "lifecycle state directory")
            if os.listdir(state_root):
                refuse("dry-run cannot proceed while lifecycle state requires recovery")
        dry_run(operation, source_value, destinations)
        return
    if operation == "uninstall" and confirmed_text != "1":
        refuse("uninstall requires explicit confirmation")

    with locked(state_root):
        transaction_path = os.path.join(state_root, "transaction")
        if is_present(transaction_path):
            recover_transaction(transaction_path, destinations)
        if operation in ("install", "update"):
            source, metadata = validate_source(source_value, destinations)
            synchronize(operation, source, metadata, destinations, transaction_path)
        else:
            uninstall(destinations, transaction_path)


try:
    main()
except LifecycleError as error:
    print("ERROR: %s" % error, file=sys.stderr)
    raise SystemExit(error.status)
except KeyboardInterrupt:
    print("ERROR: package lifecycle was interrupted", file=sys.stderr)
    raise SystemExit(3)
except LifecycleSignal:
    print("ERROR: package lifecycle was interrupted", file=sys.stderr)
    raise SystemExit(3)
except Exception as error:
    print("ERROR: package lifecycle failed: %s" % error, file=sys.stderr)
    raise SystemExit(1)
PY
  FPRS_PACKAGE_SYNC_CHILD_PID=$!
  trap 'FPRS_PACKAGE_SYNC_SIGNALLED=1; kill -HUP "$FPRS_PACKAGE_SYNC_CHILD_PID" 2>/dev/null || true' HUP
  trap 'FPRS_PACKAGE_SYNC_SIGNALLED=1; kill -INT "$FPRS_PACKAGE_SYNC_CHILD_PID" 2>/dev/null || true' INT
  trap 'FPRS_PACKAGE_SYNC_SIGNALLED=1; kill -TERM "$FPRS_PACKAGE_SYNC_CHILD_PID" 2>/dev/null || true' TERM
  while :
  do
    wait "$FPRS_PACKAGE_SYNC_CHILD_PID"
    fprs_package_sync_status=$?
    if [ "$FPRS_PACKAGE_SYNC_SIGNALLED" -eq 1 ] && [ "$fprs_package_sync_status" -ge 128 ]; then
      continue
    fi
    break
  done
  if [ -n "$fprs_package_sync_old_hup" ]; then eval "$fprs_package_sync_old_hup"; else trap - HUP; fi
  if [ -n "$fprs_package_sync_old_int" ]; then eval "$fprs_package_sync_old_int"; else trap - INT; fi
  if [ -n "$fprs_package_sync_old_term" ]; then eval "$fprs_package_sync_old_term"; else trap - TERM; fi
  unset FPRS_PACKAGE_SYNC_CHILD_PID FPRS_PACKAGE_SYNC_SIGNALLED
  return "$fprs_package_sync_status"
}
