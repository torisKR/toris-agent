#!/usr/bin/env bash
# Provide atomic project-edit staging, application, and rollback primitives.

# This file is sourced by package entrypoints. Keep all public and private names
# under the fprs_project_transaction namespace so it is safe to compose.

FPRS_PROJECT_TRANSACTION_ACTIVE=0
FPRS_PROJECT_TRANSACTION_ROOT=
FPRS_PROJECT_TRANSACTION_STAGE=
FPRS_PROJECT_TRANSACTION_COUNT=0
FPRS_PROJECT_TRANSACTION_APPLIED=0
FPRS_PROJECT_TRANSACTION_VALIDATED=0
FPRS_PROJECT_TRANSACTION_CREATED_DIR_COUNT=0
FPRS_PROJECT_TRANSACTION_PRIOR_HUP=
FPRS_PROJECT_TRANSACTION_PRIOR_INT=
FPRS_PROJECT_TRANSACTION_PRIOR_TERM=
FPRS_PROJECT_TRANSACTION_TRAPS_SAVED=0
FPRS_PROJECT_TRANSACTION_CURRENT_RECORD=
FPRS_PROJECT_TRANSACTION_FD_OPEN=0
FPRS_PROJECT_TRANSACTION_ROOT_FD_OPEN=0
FPRS_PROJECT_TRANSACTION_CHILD_PID=
FPRS_PROJECT_TRANSACTION_HOOK_PID=
FPRS_PROJECT_TRANSACTION_CONTROL_DIR=

fprs_project_transaction_error() {
  printf 'ERROR: project transaction: %s\n' "$*" >&2
}

fprs_project_transaction_file_mode() {
  [ "$#" -eq 1 ] && [ -e "$1" ] || return 1
  local fprs_transaction_mode
  if fprs_transaction_mode=$(stat -c '%a' "$1" 2>/dev/null) &&
    case "$fprs_transaction_mode" in ''|*[!0-7]*) false ;; *) true ;; esac
  then
    :
  elif fprs_transaction_mode=$(stat -f '%Lp' "$1" 2>/dev/null) &&
    case "$fprs_transaction_mode" in ''|*[!0-7]*) false ;; *) true ;; esac
  then
    :
  else
    return 1
  fi
  printf '%s\n' "$fprs_transaction_mode"
}

fprs_project_transaction_safe_relative() {
  [ "$#" -eq 1 ] && [ -n "$1" ] || return 1
  case "$1" in
    /*|*/|*//*|*$'\n'*|*$'\t'*) return 1 ;;
  esac
  local fprs_transaction_remaining fprs_transaction_component
  fprs_transaction_remaining=$1
  while [ -n "$fprs_transaction_remaining" ]
  do
    case "$fprs_transaction_remaining" in
      */*)
        fprs_transaction_component=${fprs_transaction_remaining%%/*}
        fprs_transaction_remaining=${fprs_transaction_remaining#*/}
        ;;
      *)
        fprs_transaction_component=$fprs_transaction_remaining
        fprs_transaction_remaining=
        ;;
    esac
    case "$fprs_transaction_component" in ''|.|..) return 1 ;; esac
  done
  return 0
}

fprs_project_transaction_save_traps() {
  FPRS_PROJECT_TRANSACTION_PRIOR_HUP=$(trap -p HUP)
  FPRS_PROJECT_TRANSACTION_PRIOR_INT=$(trap -p INT)
  FPRS_PROJECT_TRANSACTION_PRIOR_TERM=$(trap -p TERM)
  FPRS_PROJECT_TRANSACTION_TRAPS_SAVED=1
}

fprs_project_transaction_restore_one_trap() {
  local fprs_transaction_signal fprs_transaction_saved
  fprs_transaction_signal=$1
  fprs_transaction_saved=$2
  if [ -n "$fprs_transaction_saved" ]; then
    eval "$fprs_transaction_saved"
  else
    trap - "$fprs_transaction_signal"
  fi
}

fprs_project_transaction_restore_traps() {
  [ "$FPRS_PROJECT_TRANSACTION_TRAPS_SAVED" -eq 1 ] || return 0
  fprs_project_transaction_restore_one_trap HUP "$FPRS_PROJECT_TRANSACTION_PRIOR_HUP"
  fprs_project_transaction_restore_one_trap INT "$FPRS_PROJECT_TRANSACTION_PRIOR_INT"
  fprs_project_transaction_restore_one_trap TERM "$FPRS_PROJECT_TRANSACTION_PRIOR_TERM"
  FPRS_PROJECT_TRANSACTION_TRAPS_SAVED=0
}

fprs_project_transaction_target_path() {
  [ "$#" -eq 1 ] || return 1
  fprs_project_transaction_safe_relative "$1" || return 1

  local fprs_transaction_relative fprs_transaction_parent
  local fprs_transaction_parent_physical fprs_transaction_target
  local fprs_transaction_remaining fprs_transaction_component fprs_transaction_next
  fprs_transaction_relative=$1
  fprs_transaction_parent=${fprs_transaction_relative%/*}
  if [ "$fprs_transaction_parent" = "$fprs_transaction_relative" ]; then
    fprs_transaction_parent=.
  fi
  fprs_transaction_parent_physical=$FPRS_PROJECT_TRANSACTION_ROOT
  fprs_transaction_remaining=$fprs_transaction_parent
  while [ "$fprs_transaction_remaining" != . ] &&
    [ -n "$fprs_transaction_remaining" ]
  do
    case "$fprs_transaction_remaining" in
      */*)
        fprs_transaction_component=${fprs_transaction_remaining%%/*}
        fprs_transaction_remaining=${fprs_transaction_remaining#*/}
        ;;
      *)
        fprs_transaction_component=$fprs_transaction_remaining
        fprs_transaction_remaining=
        ;;
    esac
    fprs_transaction_next="$fprs_transaction_parent_physical/$fprs_transaction_component"
    [ ! -L "$fprs_transaction_next" ] || return 1
    if [ -e "$fprs_transaction_next" ]; then
      [ -d "$fprs_transaction_next" ] || return 1
      fprs_transaction_parent_physical=$(
        CDPATH= cd -- "$fprs_transaction_next" 2>/dev/null && pwd -P
      ) || return 1
      case "$fprs_transaction_parent_physical" in
        "$FPRS_PROJECT_TRANSACTION_ROOT"|"$FPRS_PROJECT_TRANSACTION_ROOT"/*) ;;
        *) return 1 ;;
      esac
    else
      fprs_transaction_parent_physical=$fprs_transaction_next
    fi
  done
  fprs_transaction_target="$fprs_transaction_parent_physical/${fprs_transaction_relative##*/}"
  [ ! -L "$fprs_transaction_target" ] || return 1
  printf '%s\n' "$fprs_transaction_target"
}

fprs_project_transaction_record_dir() {
  printf '%s/records/%08d\n' "$FPRS_PROJECT_TRANSACTION_STAGE" "$1"
}

fprs_project_transaction_cleanup() {
  local fprs_transaction_stage fprs_transaction_cleanup_failed
  fprs_transaction_stage=${FPRS_PROJECT_TRANSACTION_STAGE-}
  fprs_transaction_cleanup_failed=0
  if [ -n "$fprs_transaction_stage" ] &&
    case "${fprs_transaction_stage##*/}" in .fprs-project-transaction.*) true ;; *) false ;; esac &&
    [ -d "$fprs_transaction_stage" ] && [ ! -L "$fprs_transaction_stage" ]
  then
    rm -rf -- "$fprs_transaction_stage" 2>/dev/null ||
      fprs_transaction_cleanup_failed=1
  fi
  FPRS_PROJECT_TRANSACTION_STAGE=
  FPRS_PROJECT_TRANSACTION_ACTIVE=0
  FPRS_PROJECT_TRANSACTION_COUNT=0
  FPRS_PROJECT_TRANSACTION_APPLIED=0
  FPRS_PROJECT_TRANSACTION_VALIDATED=0
  FPRS_PROJECT_TRANSACTION_CREATED_DIR_COUNT=0
  FPRS_PROJECT_TRANSACTION_CURRENT_RECORD=
  FPRS_PROJECT_TRANSACTION_CHILD_PID=
  FPRS_PROJECT_TRANSACTION_HOOK_PID=
  FPRS_PROJECT_TRANSACTION_CONTROL_DIR=
  if [ "$FPRS_PROJECT_TRANSACTION_FD_OPEN" -eq 1 ]; then
    exec 9<&-
  fi
  FPRS_PROJECT_TRANSACTION_FD_OPEN=0
  if [ "$FPRS_PROJECT_TRANSACTION_ROOT_FD_OPEN" -eq 1 ]; then
    exec 8<&-
  fi
  FPRS_PROJECT_TRANSACTION_ROOT_FD_OPEN=0
  fprs_project_transaction_restore_traps
  [ "$fprs_transaction_cleanup_failed" -eq 0 ]
}

fprs_project_transaction_begin() {
  [ "$#" -eq 1 ] || {
    fprs_project_transaction_error 'begin requires one project root'
    return 2
  }
  [ "$FPRS_PROJECT_TRANSACTION_ACTIVE" -eq 0 ] || {
    fprs_project_transaction_error 'another project transaction is active'
    return 2
  }
  [ -d "$1" ] || {
    fprs_project_transaction_error 'project root is not a directory'
    return 2
  }

  FPRS_PROJECT_TRANSACTION_ROOT=$(CDPATH= cd -- "$1" 2>/dev/null && pwd -P) || {
    fprs_project_transaction_error 'could not resolve the project root physically'
    return 2
  }
  fprs_project_transaction_save_traps
  command -v python3 >/dev/null 2>&1 || {
    fprs_project_transaction_error 'transaction runtime is unavailable'
    fprs_project_transaction_restore_traps
    return 3
  }
  FPRS_PROJECT_TRANSACTION_STAGE=$(mktemp -d \
    "${TMPDIR:-/tmp}/.fprs-project-transaction.XXXXXX" 2>/dev/null) || {
    fprs_project_transaction_error 'could not create a private stage'
    return 1
  }
  if ! chmod 700 "$FPRS_PROJECT_TRANSACTION_STAGE" 2>/dev/null ||
    ! mkdir "$FPRS_PROJECT_TRANSACTION_STAGE/records" 2>/dev/null ||
    ! mkdir "$FPRS_PROJECT_TRANSACTION_STAGE/created-dirs" 2>/dev/null
  then
    fprs_project_transaction_error 'could not secure the private stage'
    fprs_project_transaction_cleanup >/dev/null 2>&1 || true
    return 1
  fi
  if ! python3 -c '
import os
import stat
import sys
root, output = sys.argv[1:]
try:
    info = os.stat(root, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError
    with open(output, "w", encoding="ascii") as target:
        target.write("%d\n%d\n" % (info.st_dev, info.st_ino))
except BaseException:
    raise SystemExit(1)
' "$FPRS_PROJECT_TRANSACTION_ROOT" \
    "$FPRS_PROJECT_TRANSACTION_STAGE/root-identity" >/dev/null 2>&1
  then
    fprs_project_transaction_error 'could not pin the project root identity'
    fprs_project_transaction_cleanup >/dev/null 2>&1 || true
    return 3
  fi
  FPRS_PROJECT_TRANSACTION_ACTIVE=1
  FPRS_PROJECT_TRANSACTION_COUNT=0
  FPRS_PROJECT_TRANSACTION_APPLIED=0
  FPRS_PROJECT_TRANSACTION_VALIDATED=0
  FPRS_PROJECT_TRANSACTION_CREATED_DIR_COUNT=0
  trap 'fprs_project_transaction_signal HUP' HUP
  trap 'fprs_project_transaction_signal INT' INT
  trap 'fprs_project_transaction_signal TERM' TERM
  return 0
}

fprs_project_transaction_register() {
  [ "$FPRS_PROJECT_TRANSACTION_ACTIVE" -eq 1 ] || {
    fprs_project_transaction_error 'register requires an active transaction'
    return 2
  }
  [ "$#" -eq 2 ] || {
    fprs_project_transaction_error 'register requires a target and candidate'
    return 2
  }
  [ -f "$2" ] && [ ! -L "$2" ] || {
    fprs_project_transaction_error 'candidate must be a regular file'
    return 2
  }

  local fprs_transaction_target fprs_transaction_index
  local fprs_transaction_record fprs_transaction_existing_record
  local fprs_transaction_existing_target fprs_transaction_mode
  fprs_transaction_target=$(fprs_project_transaction_target_path "$1") || {
    fprs_project_transaction_error "refused target outside the physical root: $1"
    return 2
  }

  fprs_transaction_index=1
  while [ "$fprs_transaction_index" -le "$FPRS_PROJECT_TRANSACTION_COUNT" ]
  do
    fprs_transaction_existing_record=$(
      fprs_project_transaction_record_dir "$fprs_transaction_index"
    )
    fprs_transaction_existing_target=$(cat \
      "$fprs_transaction_existing_record/target" 2>/dev/null) || return 1
    [ "$fprs_transaction_existing_target" != "$fprs_transaction_target" ] || {
      fprs_project_transaction_error "target was registered twice: $1"
      return 2
    }
    fprs_transaction_index=$((fprs_transaction_index + 1))
  done

  fprs_transaction_index=$((FPRS_PROJECT_TRANSACTION_COUNT + 1))
  fprs_transaction_record=$(
    fprs_project_transaction_record_dir "$fprs_transaction_index"
  )
  mkdir "$fprs_transaction_record" 2>/dev/null || return 1
  printf '%s\n' "$fprs_transaction_target" > "$fprs_transaction_record/target" || return 1
  printf '%s\n' "$1" > "$fprs_transaction_record/relative" || return 1
  if ! cp "$2" "$fprs_transaction_record/candidate" 2>/dev/null; then
    fprs_project_transaction_error 'could not stage a candidate'
    return 1
  fi

  if [ -e "$fprs_transaction_target" ]; then
    [ -f "$fprs_transaction_target" ] && [ ! -L "$fprs_transaction_target" ] || {
      fprs_project_transaction_error "target is not a regular file: $1"
      return 2
    }
    fprs_transaction_mode=$(
      fprs_project_transaction_file_mode "$fprs_transaction_target"
    ) || return 1
    printf 'yes\n' > "$fprs_transaction_record/existed" || return 1
    printf '%s\n' "$fprs_transaction_mode" > "$fprs_transaction_record/mode" || return 1
    cp "$fprs_transaction_target" "$fprs_transaction_record/original" 2>/dev/null || {
      fprs_project_transaction_error 'could not preserve original bytes'
      return 1
    }
    if ! python3 -c '
import os
import stat
import sys
target, original, output = sys.argv[1:]
try:
    info = os.stat(target, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError
    with open(target, "rb") as left, open(original, "rb") as right:
        while True:
            left_chunk = left.read(65536)
            right_chunk = right.read(65536)
            if left_chunk != right_chunk:
                raise RuntimeError
            if not left_chunk:
                break
    with open(output, "w", encoding="ascii") as identity:
        identity.write("%d\n%d\n" % (info.st_dev, info.st_ino))
except BaseException:
    raise SystemExit(1)
' "$fprs_transaction_target" "$fprs_transaction_record/original" \
      "$fprs_transaction_record/target-identity" >/dev/null 2>&1
    then
      fprs_project_transaction_error "target changed while it was staged: $1"
      return 2
    fi
  else
    fprs_transaction_mode=$(fprs_project_transaction_file_mode "$2") || return 1
    printf 'no\n' > "$fprs_transaction_record/existed" || return 1
    printf '%s\n' "$fprs_transaction_mode" > "$fprs_transaction_record/mode" || return 1
  fi
  chmod "$fprs_transaction_mode" "$fprs_transaction_record/candidate" 2>/dev/null || return 1
  FPRS_PROJECT_TRANSACTION_COUNT=$fprs_transaction_index
  FPRS_PROJECT_TRANSACTION_VALIDATED=0
  return 0
}

fprs_project_transaction_validate_record() {
  local fprs_transaction_index fprs_transaction_record
  local fprs_transaction_relative fprs_transaction_target
  local fprs_transaction_current_target fprs_transaction_existed
  local fprs_transaction_mode fprs_transaction_current_mode
  fprs_transaction_index=$1
  shift
  fprs_transaction_record=$(
    fprs_project_transaction_record_dir "$fprs_transaction_index"
  )
  fprs_transaction_relative=$(cat "$fprs_transaction_record/relative") || return 1
  fprs_transaction_target=$(cat "$fprs_transaction_record/target") || return 1
  fprs_transaction_current_target=$(
    fprs_project_transaction_target_path "$fprs_transaction_relative"
  ) || {
    fprs_project_transaction_error "target containment changed: $fprs_transaction_relative"
    return 2
  }
  [ "$fprs_transaction_current_target" = "$fprs_transaction_target" ] || {
    fprs_project_transaction_error "target containment changed: $fprs_transaction_relative"
    return 2
  }
  [ -f "$fprs_transaction_record/candidate" ] &&
    [ ! -L "$fprs_transaction_record/candidate" ] || return 1
  fprs_transaction_existed=$(cat "$fprs_transaction_record/existed") || return 1
  fprs_transaction_mode=$(cat "$fprs_transaction_record/mode") || return 1
  case "$fprs_transaction_existed" in
    yes)
      [ -f "$fprs_transaction_target" ] && [ ! -L "$fprs_transaction_target" ] || {
        fprs_project_transaction_error "target changed after planning: $fprs_transaction_relative"
        return 2
      }
      cmp -s "$fprs_transaction_record/original" "$fprs_transaction_target" || {
        fprs_project_transaction_error "target bytes changed after planning: $fprs_transaction_relative"
        return 2
      }
      fprs_transaction_current_mode=$(
        fprs_project_transaction_file_mode "$fprs_transaction_target"
      ) || return 1
      [ "$fprs_transaction_current_mode" = "$fprs_transaction_mode" ] || {
        fprs_project_transaction_error "target mode changed after planning: $fprs_transaction_relative"
        return 2
      }
      ;;
    no)
      [ ! -e "$fprs_transaction_target" ] && [ ! -L "$fprs_transaction_target" ] || {
        fprs_project_transaction_error "new target appeared after planning: $fprs_transaction_relative"
        return 2
      }
      ;;
    *) return 1 ;;
  esac
  if [ "$#" -gt 0 ]; then
    "$@" "$fprs_transaction_relative" \
      "$fprs_transaction_record/candidate" || {
      fprs_project_transaction_error "candidate validation failed: $fprs_transaction_relative"
      return 1
    }
  fi
  return 0
}

fprs_project_transaction_validate() {
  [ "$FPRS_PROJECT_TRANSACTION_ACTIVE" -eq 1 ] || {
    fprs_project_transaction_error 'validation requires an active transaction'
    return 2
  }
  local fprs_transaction_index fprs_transaction_record
  fprs_transaction_index=1
  while [ "$fprs_transaction_index" -le "$FPRS_PROJECT_TRANSACTION_COUNT" ]
  do
    fprs_project_transaction_validate_record "$fprs_transaction_index" "$@" || return $?
    fprs_transaction_index=$((fprs_transaction_index + 1))
  done
  FPRS_PROJECT_TRANSACTION_VALIDATED=1
  return 0
}


fprs_project_transaction_rollback() {
  # Project mutations and their rollback are owned by the single Python
  # lifecycle invoked by commit. Before commit, there is nothing to undo.
  return 0
}

fprs_project_transaction_signal() {
  local fprs_transaction_signal fprs_transaction_child
  fprs_transaction_signal=$1
  trap - HUP INT TERM
  fprs_transaction_child=${FPRS_PROJECT_TRANSACTION_CHILD_PID-}
  if [ -n "$fprs_transaction_child" ]; then
    kill -s "$fprs_transaction_signal" "$fprs_transaction_child" \
      2>/dev/null || true
    if wait "$fprs_transaction_child" 2>/dev/null; then :; else :; fi
    FPRS_PROJECT_TRANSACTION_CHILD_PID=
  fi
  if [ -n "${FPRS_PROJECT_TRANSACTION_HOOK_PID-}" ]; then
    if [ -n "${FPRS_PROJECT_TRANSACTION_CONTROL_DIR-}" ]; then
      : > "$FPRS_PROJECT_TRANSACTION_CONTROL_DIR/done" 2>/dev/null || true
    fi
    if wait "$FPRS_PROJECT_TRANSACTION_HOOK_PID" 2>/dev/null; then :; else :; fi
    FPRS_PROJECT_TRANSACTION_HOOK_PID=
  fi
  if [ -f "$FPRS_PROJECT_TRANSACTION_STAGE/rollback-conflict" ]; then
    fprs_project_transaction_error \
      "caught $fprs_transaction_signal; rollback attempted; conflict retained safely"
  else
    fprs_project_transaction_error \
      "caught $fprs_transaction_signal; rollback attempted"
  fi
  fprs_project_transaction_cleanup >/dev/null 2>&1 || true
  exit 3
}

fprs_project_transaction_run_python() {
  [ "$#" -eq 11 ] || return 3
  exec python3 -c '
import contextlib
import ctypes
import errno
import os
import signal
import stat
import sys
import time

(
    root_path,
    stage,
    count_text,
    fail_after_text,
    test_mode_text,
    signal_at,
    control_dir,
    pause_at,
    pause_relative,
    hook_all_text,
    fail_at,
) = sys.argv[1:]


class TransactionFailure(Exception):
    pass


class TransactionSignal(Exception):
    pass


signals = {signal.SIGHUP, signal.SIGINT, signal.SIGTERM}
test_mode = test_mode_text == "1"
hook_all = test_mode and hook_all_text == "1"
event_sequence = 0
published = []
temporaries = []
created_directories = []
directory_fds = {}
all_directory_fds = []
root_fd = None
root_identity = None
rollback_started = False
atomic_exchange = None
atomic_rename_no_replace = None
quarantine_sequence = 0
rollback_conflict = False


def interrupted(signum, frame):
    raise TransactionSignal()


for caught_signal in signals:
    signal.signal(caught_signal, interrupted)


def read_lines(path, expected=None):
    with open(path, encoding="utf-8") as source:
        values = source.read().splitlines()
    if expected is not None and len(values) != expected:
        raise TransactionFailure()
    return values


def read_one(path):
    values = read_lines(path, 1)
    if not values[0]:
        raise TransactionFailure()
    return values[0]


def safe_components(relative):
    if not relative or relative.startswith("/") or relative.endswith("/"):
        raise TransactionFailure()
    components = relative.split("/")
    if any(component in ("", ".", "..") for component in components):
        raise TransactionFailure()
    if any("\n" in component or "\t" in component for component in components):
        raise TransactionFailure()
    return components


def identity(info):
    return (info.st_dev, info.st_ino)


def load_atomic_operations():
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        try:
            operation = library.renameatx_np
        except AttributeError:
            raise TransactionFailure()
        operation.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        operation.restype = ctypes.c_int
        exchange_flag = 0x00000002
        no_replace_flag = 0x00000004
    elif sys.platform.startswith("linux"):
        try:
            operation = library.renameat2
        except AttributeError:
            raise TransactionFailure()
        operation.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        operation.restype = ctypes.c_int
        exchange_flag = 0x00000002
        no_replace_flag = 0x00000001
    else:
        raise TransactionFailure()

    def rename_with_flag(left_fd, left_name, right_fd, right_name, flag):
        ctypes.set_errno(0)
        result = operation(
            left_fd,
            os.fsencode(left_name),
            right_fd,
            os.fsencode(right_name),
            flag,
        )
        if result != 0:
            error_number = ctypes.get_errno() or errno.EIO
            raise OSError(error_number, os.strerror(error_number))

    def exchange(left_fd, left_name, right_fd, right_name):
        rename_with_flag(
            left_fd, left_name, right_fd, right_name, exchange_flag)

    def rename_no_replace(left_fd, left_name, right_fd, right_name):
        rename_with_flag(
            left_fd, left_name, right_fd, right_name, no_replace_flag)

    return exchange, rename_no_replace


def open_directory(name, parent_fd=None):
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if parent_fd is None:
        descriptor = os.open(name, flags)
    else:
        descriptor = os.open(name, flags, dir_fd=parent_fd)
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode):
        os.close(descriptor)
        raise TransactionFailure()
    all_directory_fds.append(descriptor)
    return descriptor, info


def lstat_at(parent_fd, name):
    return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)


def file_equal_at(parent_fd, name, expected_path):
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(name, flags, dir_fd=parent_fd)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return False
        with os.fdopen(os.dup(descriptor), "rb") as current, open(expected_path, "rb") as expected:
            while True:
                current_chunk = current.read(65536)
                expected_chunk = expected.read(65536)
                if current_chunk != expected_chunk:
                    return False
                if not current_chunk:
                    return True
    finally:
        os.close(descriptor)


def write_control_event(boundary, relative, critical):
    global event_sequence
    if not test_mode or not control_dir:
        return
    selected = hook_all or (
        boundary == pause_at and (not pause_relative or relative == pause_relative)
    )
    if not selected:
        return
    event_sequence += 1
    if hook_all:
        event_path = os.path.join(control_dir, "event.%08d" % event_sequence)
        answer_path = os.path.join(control_dir, "ack.%08d" % event_sequence)
    else:
        event_path = os.path.join(control_dir, "event")
        answer_path = os.path.join(control_dir, "continue")
    temporary_path = event_path + ".new.%d" % os.getpid()
    with open(temporary_path, "w", encoding="utf-8") as event:
        event.write("%d\n%s\n%s\n" % (os.getpgrp(), boundary, relative))
        event.flush()
    os.replace(temporary_path, event_path)
    while True:
        if os.path.exists(answer_path):
            if hook_all:
                answer = read_one(answer_path)
                if answer != "0":
                    raise TransactionFailure()
            return
        if critical and signal.sigpending().intersection(signals):
            return
        time.sleep(0.005)


def test_boundary(boundary, relative, critical=False):
    if not test_mode:
        return
    write_control_event(boundary, relative, critical)
    if signal_at == boundary:
        os.kill(os.getpid(), signal.SIGTERM)


def fail_after_syscall(boundary):
    if test_mode and fail_at == boundary:
        raise TransactionFailure()


@contextlib.contextmanager
def blocked_mutation():
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def verify_root_path():
    current = os.stat(root_path, follow_symlinks=False)
    if not stat.S_ISDIR(current.st_mode) or identity(current) != root_identity:
        raise TransactionFailure()


def cached_directory(parent_key, component, child_key):
    parent_fd = directory_fds[parent_key]
    descriptor = directory_fds[child_key]
    path_info = lstat_at(parent_fd, component)
    descriptor_info = os.fstat(descriptor)
    if not stat.S_ISDIR(path_info.st_mode):
        raise TransactionFailure()
    if identity(path_info) != identity(descriptor_info):
        raise TransactionFailure()
    return descriptor


def parent_for(components, relative):
    key = ()
    for component in components[:-1]:
        child_key = key + (component,)
        if child_key in directory_fds:
            cached_directory(key, component, child_key)
            key = child_key
            continue
        parent_fd = directory_fds[key]
        try:
            path_info = lstat_at(parent_fd, component)
        except FileNotFoundError:
            path_info = None
        if path_info is None:
            created = {
                "parent_fd": parent_fd,
                "name": component,
                "fd": None,
                "identity": None,
                "created": False,
                "relative": relative,
            }
            created_directories.append(created)
            with blocked_mutation():
                os.mkdir(component, 0o755, dir_fd=parent_fd)
                created["created"] = True
                fail_after_syscall("project-after-mkdir-syscall")
                test_boundary("project-dir-created", relative, True)
                child_fd, child_info = open_directory(component, parent_fd)
                created["fd"] = child_fd
                created["identity"] = identity(child_info)
                directory_fds[child_key] = child_fd
        else:
            if not stat.S_ISDIR(path_info.st_mode):
                raise TransactionFailure()
            child_fd, child_info = open_directory(component, parent_fd)
            if identity(path_info) != identity(child_info):
                raise TransactionFailure()
            directory_fds[child_key] = child_fd
        key = child_key
    return directory_fds[key]


def verify_parent_reachable(components, expected_parent_fd):
    verify_root_path()
    descriptor = root_fd
    for component in components[:-1]:
        descriptor, unused = open_directory(component, descriptor)
    if identity(os.fstat(descriptor)) != identity(os.fstat(expected_parent_fd)):
        raise TransactionFailure()


def validate_target(record, parent_fd):
    name = record["components"][-1]
    try:
        current = lstat_at(parent_fd, name)
    except FileNotFoundError:
        current = None
    if record["existed"]:
        if current is None or not stat.S_ISREG(current.st_mode):
            raise TransactionFailure()
        if identity(current) != record["target_identity"]:
            raise TransactionFailure()
        if stat.S_IMODE(current.st_mode) != record["mode"]:
            raise TransactionFailure()
        if not file_equal_at(parent_fd, name, record["original"]):
            raise TransactionFailure()
    elif current is not None:
        raise TransactionFailure()


def make_temp(record, parent_fd, index):
    stage_name = os.path.basename(stage)
    name = ".fprs-project-write.%s.%08d" % (stage_name, index)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    temporary = {
        "parent_fd": parent_fd,
        "name": name,
        "fd": None,
        "identity": None,
        "current_identity": None,
        "created": False,
        "removed": False,
    }
    temporaries.append(temporary)
    with blocked_mutation():
        descriptor = os.open(name, flags, 0o600, dir_fd=parent_fd)
        temporary["fd"] = descriptor
        temporary["created"] = True
        fail_after_syscall("project-after-open-syscall")
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise TransactionFailure()
        temporary["identity"] = identity(info)
        temporary["current_identity"] = identity(info)
        test_boundary("project-temp-created", record["relative"], True)
    source_flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        source_flags |= os.O_NOFOLLOW
    source_fd = os.open(record["candidate"], source_flags)
    try:
        source_info = os.fstat(source_fd)
        if not stat.S_ISREG(source_info.st_mode):
            raise TransactionFailure()
        while True:
            chunk = os.read(source_fd, 65536)
            if not chunk:
                break
            offset = 0
            while offset < len(chunk):
                offset += os.write(descriptor, chunk[offset:])
        os.fchmod(descriptor, record["mode"])
        final_info = os.fstat(descriptor)
        if identity(final_info) != temporary["identity"] or final_info.st_nlink != 1:
            raise TransactionFailure()
    finally:
        os.close(source_fd)
    return temporary


def temporary_owned_identity(temporary):
    if temporary["current_identity"] is not None:
        return temporary["current_identity"]
    if temporary["identity"] is not None:
        return temporary["identity"]
    if temporary["fd"] is not None:
        try:
            return identity(os.fstat(temporary["fd"]))
        except OSError:
            return None
    return None


def restore_quarantine(parent_fd, quarantine_name, canonical_name):
    global rollback_conflict
    rollback_conflict = True
    try:
        atomic_rename_no_replace(
            parent_fd, quarantine_name, parent_fd, canonical_name)
    except OSError:
        return "retained"
    return "restored"


def quarantine_delete(
        parent_fd,
        canonical_name,
        expected_identity,
        entry_kind,
        relative,
        boundary=None):
    global quarantine_sequence, rollback_conflict
    quarantine_sequence += 1
    quarantine_name = ".fprs-project-quarantine.%s.%08d.%s" % (
        os.path.basename(stage), quarantine_sequence, entry_kind)
    try:
        atomic_rename_no_replace(
            parent_fd, canonical_name, parent_fd, quarantine_name)
    except FileNotFoundError:
        return "absent"
    except OSError:
        rollback_conflict = True
        return "blocked"
    if boundary is not None:
        test_boundary(boundary, relative, True)
    try:
        moved = lstat_at(parent_fd, quarantine_name)
    except OSError:
        rollback_conflict = True
        return "missing"
    expected_kind = (
        stat.S_ISREG(moved.st_mode)
        if entry_kind == "file"
        else stat.S_ISDIR(moved.st_mode)
    )
    if (
        expected_identity is not None
        and identity(moved) == expected_identity
        and expected_kind
    ):
        try:
            if entry_kind == "file":
                os.unlink(quarantine_name, dir_fd=parent_fd)
            else:
                os.rmdir(quarantine_name, dir_fd=parent_fd)
        except OSError:
            return restore_quarantine(
                parent_fd, quarantine_name, canonical_name)
        return "deleted"
    return restore_quarantine(parent_fd, quarantine_name, canonical_name)


def remove_temporary(temporary, expected_identity=None):
    if not temporary["created"] or temporary["removed"]:
        return True
    owned = expected_identity
    if owned is None:
        owned = temporary_owned_identity(temporary)
    result = quarantine_delete(
        temporary["parent_fd"],
        temporary["name"],
        owned,
        "file",
        temporary["name"],
    )
    temporary["removed"] = True
    return result in ("deleted", "absent")


def publish(record, parent_fd, temporary):
    relative = record["relative"]
    name = record["components"][-1]
    test_boundary("project-before-publish", relative)
    verify_parent_reachable(record["components"], parent_fd)
    validate_target(record, parent_fd)
    current_temp = lstat_at(parent_fd, temporary["name"])
    if identity(current_temp) != temporary["identity"] or current_temp.st_nlink != 1:
        raise TransactionFailure()
    if record["existed"]:
        test_boundary("project-existing-before-exchange", relative)
    else:
        test_boundary("project-created-before-link", relative)
    publication = {
        "parent_fd": parent_fd,
        "name": name,
        "installed_identity": temporary["identity"],
        "existed": record["existed"],
        "original": record["original"],
        "mode": record["mode"],
        "relative": relative,
        "temporary": temporary,
        "mutated": False,
    }
    published.append(publication)
    with blocked_mutation():
        if record["existed"]:
            atomic_exchange(parent_fd, temporary["name"], parent_fd, name)
            publication["mutated"] = True
            temporary["current_identity"] = record["target_identity"]
            fail_after_syscall("project-after-publish-syscall")
            test_boundary("project-published", relative, True)
            exchanged = lstat_at(parent_fd, temporary["name"])
            valid_exchanged = (
                stat.S_ISREG(exchanged.st_mode)
                and identity(exchanged) == record["target_identity"]
                and stat.S_IMODE(exchanged.st_mode) == record["mode"]
                and file_equal_at(parent_fd, temporary["name"], record["original"])
            )
            installed = lstat_at(parent_fd, name)
            valid_installed = (
                stat.S_ISREG(installed.st_mode)
                and identity(installed) == temporary["identity"]
            )
            if not valid_exchanged or not valid_installed:
                atomic_exchange(parent_fd, temporary["name"], parent_fd, name)
                publication["mutated"] = False
                temporary["current_identity"] = temporary["identity"]
                raise TransactionFailure()
            if not remove_temporary(temporary, record["target_identity"]):
                raise TransactionFailure()
        else:
            os.link(
                temporary["name"],
                name,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
                follow_symlinks=False,
            )
            publication["mutated"] = True
            fail_after_syscall("project-after-publish-syscall")
            test_boundary("project-published", relative, True)
            installed = lstat_at(parent_fd, name)
            if (
                not stat.S_ISREG(installed.st_mode)
                or identity(installed) != temporary["identity"]
            ):
                raise TransactionFailure()
            if not remove_temporary(temporary, temporary["identity"]):
                raise TransactionFailure()
    test_boundary("project-after-publish", relative)
    test_boundary("project-write", relative)


def copy_to_descriptor(source_path, destination_fd):
    with open(source_path, "rb") as source:
        while True:
            chunk = source.read(65536)
            if not chunk:
                return
            offset = 0
            while offset < len(chunk):
                offset += os.write(destination_fd, chunk[offset:])


def create_rollback_file(parent_fd, name, mode, source_path=None):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    temporary = {
        "parent_fd": parent_fd,
        "name": name,
        "fd": None,
        "identity": None,
        "current_identity": None,
        "created": False,
        "removed": False,
    }
    temporaries.append(temporary)
    descriptor = os.open(name, flags, 0o600, dir_fd=parent_fd)
    temporary["fd"] = descriptor
    temporary["created"] = True
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise TransactionFailure()
    temporary["identity"] = identity(info)
    temporary["current_identity"] = identity(info)
    if source_path is not None:
        copy_to_descriptor(source_path, descriptor)
    os.fchmod(descriptor, mode)
    final_info = os.fstat(descriptor)
    if identity(final_info) != temporary["identity"] or final_info.st_nlink != 1:
        raise TransactionFailure()
    return temporary


def rollback_existing(publication, index):
    parent_fd = publication["parent_fd"]
    restore = create_rollback_file(
        parent_fd,
        ".fprs-project-restore.%s.%08d" % (os.path.basename(stage), index),
        publication["mode"],
        publication["original"],
    )
    test_boundary(
        "project-rollback-existing-before-exchange",
        publication["relative"],
        True,
    )
    try:
        atomic_exchange(parent_fd, restore["name"], parent_fd, publication["name"])
    except FileNotFoundError:
        publication["mutated"] = False
        remove_temporary(restore)
        return
    restore["current_identity"] = publication["installed_identity"]
    exchanged = lstat_at(parent_fd, restore["name"])
    if identity(exchanged) == publication["installed_identity"]:
        publication["mutated"] = False
        remove_temporary(restore, publication["installed_identity"])
        return
    atomic_exchange(parent_fd, restore["name"], parent_fd, publication["name"])
    restore["current_identity"] = restore["identity"]
    publication["mutated"] = False
    remove_temporary(restore)


def rollback_created(publication, index):
    parent_fd = publication["parent_fd"]
    test_boundary(
        "project-rollback-created-before-exchange",
        publication["relative"],
        True,
    )
    quarantine_delete(
        parent_fd,
        publication["name"],
        publication["installed_identity"],
        "file",
        publication["relative"],
        "project-created-file-quarantined",
    )
    publication["mutated"] = False


def rollback():
    global rollback_started
    rollback_started = True
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    try:
        for index, publication in enumerate(reversed(published), 1):
            if not publication["mutated"]:
                continue
            try:
                if publication["existed"]:
                    rollback_existing(publication, index)
                    remove_temporary(
                        publication["temporary"],
                        publication["temporary"].get("current_identity"),
                    )
                else:
                    rollback_created(publication, index)
            except BaseException:
                pass
        for temporary in reversed(temporaries):
            remove_temporary(temporary)
        for created in reversed(created_directories):
            if not created["created"]:
                continue
            try:
                expected = created["identity"]
                if expected is None and created["fd"] is not None:
                    expected = identity(os.fstat(created["fd"]))
                quarantine_delete(
                    created["parent_fd"],
                    created["name"],
                    expected,
                    "directory",
                    created["relative"],
                    "project-created-directory-quarantined",
                )
            except OSError:
                pass
        if rollback_conflict:
            try:
                marker_fd = os.open(
                    os.path.join(stage, "rollback-conflict"),
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                os.close(marker_fd)
            except OSError:
                pass
    finally:
        for caught_signal in signals:
            signal.signal(caught_signal, signal.SIG_IGN)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def close_descriptors():
    for temporary in temporaries:
        if temporary["fd"] is None:
            continue
        try:
            os.close(temporary["fd"])
        except OSError:
            pass
    for descriptor in reversed(all_directory_fds):
        try:
            os.close(descriptor)
        except OSError:
            pass


try:
    if test_mode and control_dir and not hook_all:
        os.setpgrp()
    atomic_exchange, atomic_rename_no_replace = load_atomic_operations()
    count = int(count_text)
    fail_after = int(fail_after_text) if fail_after_text else 0
    if count < 0 or fail_after < 0:
        raise TransactionFailure()
    root_values = read_lines(os.path.join(stage, "root-identity"), 2)
    root_identity = (int(root_values[0]), int(root_values[1]))
    root_fd, root_info = open_directory(root_path)
    if identity(root_info) != root_identity:
        raise TransactionFailure()
    verify_root_path()
    directory_fds[()] = root_fd
    records = []
    for index in range(1, count + 1):
        record_dir = os.path.join(stage, "records", "%08d" % index)
        relative = read_one(os.path.join(record_dir, "relative"))
        components = safe_components(relative)
        existed_text = read_one(os.path.join(record_dir, "existed"))
        if existed_text not in ("yes", "no"):
            raise TransactionFailure()
        mode_text = read_one(os.path.join(record_dir, "mode"))
        if any(character not in "01234567" for character in mode_text):
            raise TransactionFailure()
        candidate = os.path.join(record_dir, "candidate")
        candidate_info = os.stat(candidate, follow_symlinks=False)
        if not stat.S_ISREG(candidate_info.st_mode):
            raise TransactionFailure()
        record = {
            "relative": relative,
            "components": components,
            "candidate": candidate,
            "mode": int(mode_text, 8),
            "existed": existed_text == "yes",
            "original": os.path.join(record_dir, "original"),
            "target_identity": None,
        }
        if record["existed"]:
            target_values = read_lines(os.path.join(record_dir, "target-identity"), 2)
            record["target_identity"] = (int(target_values[0]), int(target_values[1]))
            original_info = os.stat(record["original"], follow_symlinks=False)
            if not stat.S_ISREG(original_info.st_mode):
                raise TransactionFailure()
        records.append(record)
    for index, record in enumerate(records, 1):
        verify_root_path()
        test_boundary("project-before-target-validation", record["relative"])
        parent_fd = parent_for(record["components"], record["relative"])
        validate_target(record, parent_fd)
        temporary = make_temp(record, parent_fd, index)
        publish(record, parent_fd, temporary)
        if fail_after and index == fail_after:
            raise TransactionFailure()
except BaseException:
    try:
        rollback()
    finally:
        close_descriptors()
    raise SystemExit(3)
else:
    close_descriptors()
    raise SystemExit(0)
' "$@"
}


fprs_project_transaction_commit() {
  [ "$FPRS_PROJECT_TRANSACTION_ACTIVE" -eq 1 ] || {
    fprs_project_transaction_error 'commit requires an active transaction'
    return 2
  }
  if ! fprs_project_transaction_validate; then
    fprs_project_transaction_error 'project snapshot changed before publication'
    fprs_project_transaction_cleanup >/dev/null 2>&1 || true
    return 3
  fi
  command -v python3 >/dev/null 2>&1 || {
    fprs_project_transaction_error 'transaction runtime is unavailable'
    fprs_project_transaction_cleanup >/dev/null 2>&1 || true
    return 3
  }

  local fprs_transaction_fail_after fprs_transaction_fail_at
  local fprs_transaction_test_mode
  local fprs_transaction_signal_at fprs_transaction_control_dir
  local fprs_transaction_pause_at fprs_transaction_pause_relative
  local fprs_transaction_hook_all fprs_transaction_hook_pid
  local fprs_transaction_hook_sequence fprs_transaction_hook_event
  local fprs_transaction_hook_boundary fprs_transaction_hook_relative
  local fprs_transaction_hook_status fprs_transaction_status
  fprs_transaction_fail_after=
  fprs_transaction_fail_at=
  fprs_transaction_test_mode=0
  fprs_transaction_signal_at=
  fprs_transaction_control_dir=
  fprs_transaction_pause_at=
  fprs_transaction_pause_relative=
  fprs_transaction_hook_all=0
  fprs_transaction_hook_pid=
  if [ "${FPRS_TEST_MODE-}" = 1 ]; then
    fprs_transaction_test_mode=1
    fprs_transaction_fail_after=${FPRS_TEST_FAIL_PROJECT_WRITE_AFTER-}
    case "$fprs_transaction_fail_after" in
      ''|*[!0-9]*) fprs_transaction_fail_after= ;;
    esac
    fprs_transaction_signal_at=${FPRS_TEST_SIGNAL_AT-}
    fprs_transaction_fail_at=${FPRS_TEST_FAIL_AT-}
    fprs_transaction_control_dir=${FPRS_TEST_CONTROL_DIR-}
    fprs_transaction_pause_at=${FPRS_TEST_PAUSE_AT-}
    fprs_transaction_pause_relative=${FPRS_TEST_PAUSE_RELATIVE-}
    if type fprs_project_transaction_test_hook >/dev/null 2>&1; then
      fprs_transaction_control_dir="$FPRS_PROJECT_TRANSACTION_STAGE/test-control"
      mkdir "$fprs_transaction_control_dir" 2>/dev/null || {
        fprs_project_transaction_cleanup >/dev/null 2>&1 || true
        return 3
      }
      chmod 700 "$fprs_transaction_control_dir" 2>/dev/null || {
        fprs_project_transaction_cleanup >/dev/null 2>&1 || true
        return 3
      }
      fprs_transaction_hook_all=1
      (
        fprs_transaction_hook_sequence=1
        while [ ! -e "$fprs_transaction_control_dir/done" ]
        do
          fprs_transaction_hook_event="$fprs_transaction_control_dir/event.$(printf '%08d' "$fprs_transaction_hook_sequence")"
          if [ -s "$fprs_transaction_hook_event" ]; then
            fprs_transaction_hook_boundary=$(sed -n '2p' "$fprs_transaction_hook_event")
            fprs_transaction_hook_relative=$(sed -n '3p' "$fprs_transaction_hook_event")
            if fprs_project_transaction_test_hook \
              "$fprs_transaction_hook_boundary" "$fprs_transaction_hook_relative"
            then
              fprs_transaction_hook_status=0
            else
              fprs_transaction_hook_status=1
            fi
            printf '%s\n' "$fprs_transaction_hook_status" > \
              "$fprs_transaction_control_dir/ack.$(printf '%08d' "$fprs_transaction_hook_sequence").new" || exit 1
            mv "$fprs_transaction_control_dir/ack.$(printf '%08d' "$fprs_transaction_hook_sequence").new" \
              "$fprs_transaction_control_dir/ack.$(printf '%08d' "$fprs_transaction_hook_sequence")" || exit 1
            fprs_transaction_hook_sequence=$((fprs_transaction_hook_sequence + 1))
          else
            sleep 0.01
          fi
        done
      ) &
      fprs_transaction_hook_pid=$!
      FPRS_PROJECT_TRANSACTION_HOOK_PID=$fprs_transaction_hook_pid
      FPRS_PROJECT_TRANSACTION_CONTROL_DIR=$fprs_transaction_control_dir
    fi
  fi

  fprs_project_transaction_run_python \
    "$FPRS_PROJECT_TRANSACTION_ROOT" "$FPRS_PROJECT_TRANSACTION_STAGE" \
    "$FPRS_PROJECT_TRANSACTION_COUNT" "$fprs_transaction_fail_after" \
    "$fprs_transaction_test_mode" "$fprs_transaction_signal_at" \
    "$fprs_transaction_control_dir" "$fprs_transaction_pause_at" \
    "$fprs_transaction_pause_relative" "$fprs_transaction_hook_all" \
    "$fprs_transaction_fail_at" >/dev/null 2>&1 &
  FPRS_PROJECT_TRANSACTION_CHILD_PID=$!
  if wait "$FPRS_PROJECT_TRANSACTION_CHILD_PID"; then
    fprs_transaction_status=0
  else
    fprs_transaction_status=$?
  fi
  FPRS_PROJECT_TRANSACTION_CHILD_PID=
  if [ -n "$fprs_transaction_hook_pid" ]; then
    : > "$fprs_transaction_control_dir/done"
    wait "$fprs_transaction_hook_pid" 2>/dev/null || true
    FPRS_PROJECT_TRANSACTION_HOOK_PID=
    FPRS_PROJECT_TRANSACTION_CONTROL_DIR=
  fi
  if [ "$fprs_transaction_status" -ne 0 ]; then
    if [ -f "$FPRS_PROJECT_TRANSACTION_STAGE/rollback-conflict" ]; then
      fprs_project_transaction_error \
        'project write failed; rollback attempted; conflict retained safely'
    else
      fprs_project_transaction_error 'project write failed; rollback attempted'
    fi
    fprs_project_transaction_cleanup >/dev/null 2>&1 || true
    return 3
  fi
  if ! fprs_project_transaction_cleanup; then
    fprs_project_transaction_error 'project writes completed but private cleanup failed'
    return 1
  fi
  return 0
}

fprs_project_transaction_abort() {
  [ "$FPRS_PROJECT_TRANSACTION_ACTIVE" -eq 1 ] || return 0
  fprs_project_transaction_rollback || true
  fprs_project_transaction_cleanup
}
