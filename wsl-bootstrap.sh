#!/usr/bin/env bash
# AntiRugDex — B0 toolchain bootstrap for WSL/Ubuntu.
#
# Read this before running it. It installs a Rust + Solana + Anchor toolchain into
# your WSL home directory and then proves the toolchain works by building a
# throwaway program in ~/anchor-probe.
#
#   bash wsl-bootstrap.sh
#
# It does NOT touch the AntiRugDex project. It never runs `anchor init` anywhere
# near the Windows checkout — that directory already has a
# package.json / tsconfig.json / .gitignore and is not a git repo, so a scaffold
# there would be unrecoverable.
#
# Safe to re-run: every step is skipped if already satisfied.

set -euo pipefail

# Anchor 1.1.2 wants exactly this Solana version. Installing it up front stops
# anchor from trying to switch versions underneath us — the behaviour that
# repeatedly destroyed the Solana install on the Windows side.
SOLANA_VERSION="3.1.10"
ANCHOR_VERSION="1.1.2"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

say "System packages"
# Only escalate if something is actually missing. Everything after this point is
# per-user and needs no root at all, so a fully-provisioned box runs this script
# start to finish without ever prompting for a password.
PKGS="build-essential pkg-config libssl-dev libudev-dev curl git ca-certificates protobuf-compiler"
MISSING=""
for p in $PKGS; do
  dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "ok installed" || MISSING="$MISSING $p"
done
if [ -n "$MISSING" ]; then
  echo "installing:$MISSING"
  sudo apt-get update -qq
  # shellcheck disable=SC2086
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $MISSING
else
  echo "all present, skipping apt (no sudo needed)"
fi

say "Rust"
if have rustc; then
  echo "already installed: $(rustc --version)"
else
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile default
fi
# shellcheck disable=SC1090,SC1091
source "$HOME/.cargo/env"
rustc --version
cargo --version

say "Solana CLI v${SOLANA_VERSION}"
if have solana && [ "$(solana --version | awk '{print $2}')" = "$SOLANA_VERSION" ]; then
  echo "already installed: $(solana --version)"
else
  sh -c "$(curl -sSfL https://release.anza.xyz/v${SOLANA_VERSION}/install)"
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version

say "avm + anchor ${ANCHOR_VERSION}"
if ! have avm; then
  cargo install --git https://github.com/solana-foundation/anchor avm --force
fi
avm install "$ANCHOR_VERSION"
avm use "$ANCHOR_VERSION"
anchor --version

say "Probe: does anchor build actually emit BOTH a .so and an IDL?"
# This is the pass condition. A .so without an IDL is a FAIL — the TypeScript
# client needs the IDL, and IDL generation is the step most likely to break.
PROBE="$HOME/anchor-probe"
rm -rf "$PROBE"
mkdir -p "$(dirname "$PROBE")"
cd "$(dirname "$PROBE")"
anchor init "$(basename "$PROBE")" --no-install --no-git
cd "$PROBE"
anchor build

SO_COUNT=$(find target/deploy -name '*.so' 2>/dev/null | wc -l)
IDL_COUNT=$(find target/idl -name '*.json' 2>/dev/null | wc -l)

say "Result"
echo "  .so  artifacts: $SO_COUNT"
find target/deploy -name '*.so' 2>/dev/null || true
echo "  IDL artifacts: $IDL_COUNT"
find target/idl -name '*.json' 2>/dev/null || true

if [ "$SO_COUNT" -ge 1 ] && [ "$IDL_COUNT" -ge 1 ]; then
  printf '\n\033[1;32mB0 PASS — toolchain is real. Probe left at %s; delete it whenever.\033[0m\n' "$PROBE"
  printf 'Add this to ~/.bashrc if it is not already there:\n'
  printf '  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"\n'
else
  printf '\n\033[1;31mB0 FAIL — build did not produce both artifacts. Do not proceed to the sale program.\033[0m\n'
  exit 1
fi
