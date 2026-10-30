#!/bin/sh
# Installs Afterhours on macOS or Linux. On Windows, install.ps1 runs this inside WSL.
#
#   curl -fsSL https://github.com/{{repo}}/releases/latest/download/install.sh | sh
#
# What it does, asking before anything that needs your password:
#   1. installs what Afterhours needs and doesn't find (tmux, git, curl) with your package manager;
#   2. installs Claude Code if it isn't there;
#   3. downloads Afterhours for this machine and checks it against the release's checksums;
#   4. runs `cq install` (cq in ~/.afterhours/bin, linked into ~/.local/bin, started in the
#      background: a LaunchAgent on macOS, a systemd user service on Linux);
#   5. runs `cq setup`, which signs Claude Code in and connects your Telegram bot.
#
# Settings, as environment variables:
#   AFTERHOURS_VERSION=v0.6.0   install that release instead of the latest
#   AFTERHOURS_BINARY=./cq      install this binary instead of downloading one
#   AFTERHOURS_REPO=owner/repo  where releases come from
#   AFTERHOURS_BASE_URL=…       download from here instead (for tests)
#   AFTERHOURS_YES=1            answer yes to every question (for scripts and cloud-init)
#   AFTERHOURS_NO_SETUP=1       stop after installing; run `cq setup` yourself later
set -eu

repo="${AFTERHOURS_REPO:-{{repo}}}"

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\nError: %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# Questions go to the terminal even when this script arrives through a pipe (curl … | sh).
tty_ok() { [ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null; }
yes_to() {
  [ "${AFTERHOURS_YES:-}" = 1 ] && return 0
  tty_ok || return 1
  printf '%s [Y/n] ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=n
  case "$answer" in '' | y | Y | yes | YES | Yes) return 0 ;; *) return 1 ;; esac
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "Afterhours runs on macOS and Linux. On Windows, run this in PowerShell instead:
  irm https://github.com/$repo/releases/latest/download/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "There's no Afterhours build for $(uname -m)." ;;
esac

say "Afterhours: line up Claude Code tasks from Telegram; they run on this computer while you're away."

# --- 1. tmux, git, curl -----------------------------------------------------------------------
sudo_cmd() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
install_packages() {
  if [ "$os" = darwin ]; then
    if ! have brew; then
      fail "Afterhours needs $* and installs them with Homebrew, which isn't here. Install Homebrew first (one line, from https://brew.sh):
  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"
then run this again."
    fi
    brew install "$@"
  elif have apt-get; then sudo_cmd apt-get update -qq && sudo_cmd apt-get install -y "$@"
  elif have dnf; then sudo_cmd dnf install -y "$@"
  elif have yum; then sudo_cmd yum install -y "$@"
  elif have pacman; then sudo_cmd pacman -S --needed --noconfirm "$@"
  elif have zypper; then sudo_cmd zypper install -y "$@"
  elif have apk; then sudo_cmd apk add "$@"
  else fail "Install $* with your package manager, then run this again."
  fi
}
missing=""
for tool in tmux git curl; do have "$tool" || missing="$missing $tool"; done
if [ -n "$missing" ]; then
  step "1. Tools Afterhours uses:$missing"
  if yes_to "Install$missing now?"; then
    # shellcheck disable=SC2086 # the list is meant to split into words
    install_packages $missing
  else
    fail "Afterhours needs$missing. Install what is missing, then run this again."
  fi
fi

# --- 2. Claude Code ---------------------------------------------------------------------------
claude_path() {
  if have claude; then command -v claude
  elif [ -x "$HOME/.local/bin/claude" ]; then echo "$HOME/.local/bin/claude"
  else return 1
  fi
}
if ! claude_path >/dev/null; then
  step "2. Claude Code"
  say "Afterhours runs Claude Code, Anthropic's coding assistant, with your own Claude account."
  if yes_to "Install Claude Code now (its official installer, from claude.ai)?"; then
    curl -fsSL https://claude.ai/install.sh | bash
    claude_path >/dev/null || fail "Claude Code didn't install. See https://claude.com/claude-code, then run this again."
  else
    fail "Install Claude Code (https://claude.com/claude-code), then run this again."
  fi
fi

# --- 3. Afterhours ----------------------------------------------------------------------------
step "3. Afterhours"
asset="cq-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ -n "${AFTERHOURS_BINARY:-}" ]; then
  cp "$AFTERHOURS_BINARY" "$tmp/cq"
else
  case "$repo" in
    *'{'*) fail "Set AFTERHOURS_REPO=owner/repo: this copy of the script didn't come with a release." ;;
  esac
  if [ -n "${AFTERHOURS_BASE_URL:-}" ]; then
    base="$AFTERHOURS_BASE_URL"
  elif [ -n "${AFTERHOURS_VERSION:-}" ]; then
    base="https://github.com/$repo/releases/download/$AFTERHOURS_VERSION"
  else
    base="https://github.com/$repo/releases/latest/download"
  fi
  say "Downloading ${asset}…"
  curl -fsSL "$base/$asset" -o "$tmp/cq"
  curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
  expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
  if have sha256sum; then actual="$(sha256sum "$tmp/cq" | awk '{ print $1 }')"; else actual="$(shasum -a 256 "$tmp/cq" | awk '{ print $1 }')"; fi
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "The download doesn't match its checksum. Nothing was installed."
fi

chmod 755 "$tmp/cq"
"$tmp/cq" version >/dev/null 2>&1 || fail "That build doesn't run on this system ($os $arch)."
say "Installing Afterhours $("$tmp/cq" version)…"
mkdir -p "$HOME/.local/bin"
"$tmp/cq" install

# `cq` in new terminals: ~/.local/bin on the PATH, added to your shell's startup file if it isn't.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
      */fish) rc="" ;;
      *) rc="$HOME/.profile" ;;
    esac
    if [ -n "$rc" ] && ! grep -qs '.local/bin' "$rc"; then
      printf '\n# Afterhours (cq)\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$rc"
      say "Added ~/.local/bin to your PATH in ${rc#"$HOME"/} (new terminals get it)."
    elif [ -z "$rc" ]; then
      say "Add ~/.local/bin to your PATH: fish_add_path ~/.local/bin"
    fi
    ;;
esac

# --- 4. Setup ---------------------------------------------------------------------------------
cq="$HOME/.afterhours/bin/cq"
[ -x "$cq" ] || cq="$tmp/cq"
if [ "${AFTERHOURS_NO_SETUP:-}" = 1 ] || ! tty_ok; then
  say ""
  say "Installed. Finish setting up (sign Claude in, connect your Telegram bot) with:"
  say "  cq setup"
  exit 0
fi
step "4. Setting up (Claude Code, your folders, your Telegram bot)"
"$cq" setup </dev/tty
