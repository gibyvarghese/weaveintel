#!/usr/bin/env bash
# install-node.sh — install Node.js 20 LTS via nvm (no sudo required).
#
# Safe to run repeatedly. If Node >= 20 is already on PATH, this script
# exits 0 immediately. Otherwise it installs nvm into $HOME/.nvm,
# installs Node 20, and prints the export lines you need in your shell.
#
# Supported: macOS, Linux (any distro). Not for Windows — use nvm-windows
# (https://github.com/coreybutler/nvm-windows) or winget instead.

set -euo pipefail

if [ -t 1 ]; then
  C_BLUE='\033[0;34m'; C_GRN='\033[0;32m'; C_YLW='\033[0;33m'; C_RED='\033[0;31m'; C_RST='\033[0m'
else
  C_BLUE=''; C_GRN=''; C_YLW=''; C_RED=''; C_RST=''
fi

step() { printf "${C_BLUE}==>${C_RST} %s\n" "$*"; }
info() { printf "${C_GRN}[ok]${C_RST} %s\n" "$*"; }
warn() { printf "${C_YLW}[warn]${C_RST} %s\n" "$*"; }
fail() { printf "${C_RED}[fail]${C_RST} %s\n" "$*" >&2; exit 1; }

REQUIRED_MAJOR=20
NVM_DIR_DEFAULT="${HOME}/.nvm"
NVM_VERSION="v0.40.1"

# 1. Already installed? -------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  CURRENT="$(node -v 2>/dev/null || echo unknown)"
  CURRENT_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${CURRENT_MAJOR:-0}" -ge "$REQUIRED_MAJOR" ]; then
    info "Node ${CURRENT} already installed (>= ${REQUIRED_MAJOR}). Nothing to do."
    exit 0
  fi
  warn "Found Node ${CURRENT} but require >= ${REQUIRED_MAJOR}. Will install via nvm."
fi

# 2. OS sanity ---------------------------------------------------------------
case "$(uname -s)" in
  Darwin|Linux) : ;;
  *) fail "Unsupported OS: $(uname -s). Use nvm-windows on Windows." ;;
esac

# 3. Install nvm if missing --------------------------------------------------
export NVM_DIR="${NVM_DIR:-$NVM_DIR_DEFAULT}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  step "Installing nvm ${NVM_VERSION} into ${NVM_DIR}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | PROFILE=/dev/null bash
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | PROFILE=/dev/null bash
  else
    fail "Neither curl nor wget found. Install one and re-run."
  fi
else
  info "nvm already present at ${NVM_DIR}"
fi

# 4. Source nvm and install Node ${REQUIRED_MAJOR} ---------------------------
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

step "Installing Node ${REQUIRED_MAJOR} (LTS) via nvm"
nvm install "$REQUIRED_MAJOR"
nvm alias default "$REQUIRED_MAJOR"
nvm use "$REQUIRED_MAJOR"

info "node $(node -v) / npm $(npm -v) ready."

# 5. Tell the user how to make it persistent --------------------------------
cat <<EOF

${C_GRN}Done.${C_RST} Add the following to your shell profile (~/.zshrc, ~/.bashrc, ~/.profile)
if it's not there already, so future shells can find Node:

  export NVM_DIR="\$HOME/.nvm"
  [ -s "\$NVM_DIR/nvm.sh" ] && \\. "\$NVM_DIR/nvm.sh"
  [ -s "\$NVM_DIR/bash_completion" ] && \\. "\$NVM_DIR/bash_completion"

For the current shell, you can either source the lines above or just run:

  source "\$NVM_DIR/nvm.sh"

Then continue with: ${C_BLUE}./scripts/start-geneweave.sh${C_RST}
EOF
