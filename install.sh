#!/bin/sh
# Installs Afterhours on macOS or Linux. On Windows, run it inside WSL2.
#
#   curl -fsSL https://github.com/{{repo}}/releases/latest/download/install.sh | sh
#
# Settings, as environment variables:
#   AFTERHOURS_VERSION=v0.2.0   install that release instead of the latest
#   AFTERHOURS_BINARY=./cq      install this binary instead of downloading one
#   AFTERHOURS_REPO=owner/repo  where releases come from
#
# It checks the download against the release's SHA256SUMS, then runs `cq install`: that puts cq
# in ~/.afterhours/bin, links it into ~/.local/bin, and starts it in the background (a
# LaunchAgent on macOS, a systemd user service on Linux).
set -eu

repo="${AFTERHOURS_REPO:-{{repo}}}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "Afterhours runs on macOS and Linux. On Windows, run this inside WSL2." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "There's no Afterhours build for $(uname -m)." ;;
esac

# The tools it works with. Starting it without them would only fail again and again.
hint() {
  if [ "$os" = darwin ]; then echo "brew install $*"
  elif have apt-get; then echo "sudo apt-get install -y $*"
  elif have dnf; then echo "sudo dnf install -y $*"
  elif have yum; then echo "sudo yum install -y $*"
  elif have pacman; then echo "sudo pacman -S --noconfirm $*"
  elif have zypper; then echo "sudo zypper install -y $*"
  elif have apk; then echo "sudo apk add $*"
  else echo "install $* with your package manager"
  fi
}
missing=""
for tool in tmux git curl; do have "$tool" || missing="$missing $tool"; done
if [ -n "$missing" ]; then
  fail "Afterhours needs$missing. Install them first:
  $(hint $missing)
then run this again."
fi
if ! have claude && [ ! -x "$HOME/.local/bin/claude" ]; then
  fail "Afterhours runs Claude Code, which isn't installed. Install it and sign in first:
  curl -fsSL https://claude.ai/install.sh | bash
  claude          (sign in; on a server without a browser: claude setup-token, see the Linux guide)
then run this again."
fi

asset="cq-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ -n "${AFTERHOURS_BINARY:-}" ]; then
  cp "$AFTERHOURS_BINARY" "$tmp/cq"
else
  case "$repo" in
    *'{'*) fail "Set AFTERHOURS_REPO=owner/repo: this copy of the script didn't come with a release." ;;
  esac
  if [ -n "${AFTERHOURS_VERSION:-}" ]; then
    base="https://github.com/$repo/releases/download/$AFTERHOURS_VERSION"
  else
    base="https://github.com/$repo/releases/latest/download"
  fi
  say "Downloading $asset…"
  curl -fsSL "$base/$asset" -o "$tmp/cq"
  curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
  expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
  if have sha256sum; then actual="$(sha256sum "$tmp/cq" | awk '{ print $1 }')"; else actual="$(shasum -a 256 "$tmp/cq" | awk '{ print $1 }')"; fi
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "The download doesn't match its checksum. Nothing was installed."
fi

chmod 755 "$tmp/cq"
"$tmp/cq" version >/dev/null 2>&1 || fail "That build doesn't run on this system ($os $arch)."
say "Installing Afterhours $("$tmp/cq" version)…"
"$tmp/cq" install
