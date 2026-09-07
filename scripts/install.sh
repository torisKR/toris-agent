#!/bin/sh
# toris installer — download a prebuilt standalone binary from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/torisKR/toris-agent/main/scripts/install.sh | sh
#
# Environment overrides:
#   TORIS_VERSION   release tag to install (default: latest, e.g. v0.3.0)
#   TORIS_INSTALL   directory to install into (default: ~/.local/bin)
#
# The script is POSIX sh, idempotent (re-running upgrades in place), and verifies
# the download against the published SHA-256 checksum before installing.
set -eu

REPO="torisKR/toris-agent"
BIN_NAME="toris"

info() { printf '\033[38;5;75m›\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1" >&2; }
err() {
  printf '\033[31mx\033[0m %s\n' "$1" >&2
  exit 1
}

need() { command -v "$1" >/dev/null 2>&1; }

# --- pick a downloader ------------------------------------------------------
if need curl; then
  dl() { curl -fsSL "$1" -o "$2"; }
  dl_stdout() { curl -fsSL "$1"; }
elif need wget; then
  dl() { wget -qO "$2" "$1"; }
  dl_stdout() { wget -qO - "$1"; }
else
  err "need curl or wget to download toris"
fi

# --- detect os/arch ---------------------------------------------------------
os=$(uname -s 2>/dev/null || echo unknown)
arch=$(uname -m 2>/dev/null || echo unknown)

case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT) os=win ;;
  *) err "unsupported OS: $os" ;;
esac

case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) err "unsupported architecture: $arch" ;;
esac

target="${os}-${arch}"
ext=""
[ "$os" = "win" ] && ext=".exe"
asset="${BIN_NAME}-${target}${ext}"

# Not every triple is built; fail with a clear message rather than a 404 later.
case "$target" in
  linux-x64 | darwin-x64 | darwin-arm64 | win-x64) : ;;
  *) err "no prebuilt binary for $target — install from npm instead: npm i -g $REPO" ;;
esac

# --- resolve the release ----------------------------------------------------
version="${TORIS_VERSION:-latest}"
if [ "$version" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
  info "Installing the latest toris ($target)"
else
  base="https://github.com/${REPO}/releases/download/${version}"
  info "Installing toris $version ($target)"
fi

# --- download to a temp dir -------------------------------------------------
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t toris)
trap 'rm -rf "$tmp"' EXIT INT TERM

info "Downloading $asset"
dl "${base}/${asset}" "${tmp}/${asset}" || err "download failed: ${base}/${asset}"

# --- verify checksum (best effort, fails closed if a checksum is present) ---
if dl "${base}/${asset}.sha256" "${tmp}/${asset}.sha256" 2>/dev/null; then
  expected=$(awk '{print $1}' "${tmp}/${asset}.sha256")
  if need sha256sum; then
    actual=$(sha256sum "${tmp}/${asset}" | awk '{print $1}')
  elif need shasum; then
    actual=$(shasum -a 256 "${tmp}/${asset}" | awk '{print $1}')
  else
    actual=""
    warn "no sha256sum/shasum found; skipping checksum verification"
  fi
  if [ -n "$actual" ]; then
    [ "$actual" = "$expected" ] || err "checksum mismatch for $asset (expected $expected, got $actual)"
    info "Checksum verified"
  fi
else
  warn "no published checksum for $asset; skipping verification"
fi

# --- install ----------------------------------------------------------------
install_dir="${TORIS_INSTALL:-$HOME/.local/bin}"
mkdir -p "$install_dir"
dest="${install_dir}/${BIN_NAME}${ext}"

chmod +x "${tmp}/${asset}"
# `cp` then `mv` within the same dir is atomic and works even if `toris` is busy.
cp "${tmp}/${asset}" "${dest}.new"
mv "${dest}.new" "$dest"
info "Installed to $dest"

# --- next steps -------------------------------------------------------------
printf '\n'
case ":${PATH}:" in
  *":${install_dir}:"*)
    info "Run 'toris doctor' to check your setup, then 'toris' to start chatting."
    ;;
  *)
    warn "${install_dir} is not on your PATH."
    printf "   Add this to your shell profile:\n\n     export PATH=\"%s:\$PATH\"\n\n" "$install_dir"
    info "Then run 'toris doctor' to check your setup."
    ;;
esac
