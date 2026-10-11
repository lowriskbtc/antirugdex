#!/usr/bin/env bash
# Read-only. What actually landed on devnet, and is any SOL stranded in a buffer?
#
# PATH is stripped of Windows entries: WSL inherits them, and `anchor` resolved a child
# process to the WINDOWS solana.exe during deploy, which then failed on /mnt/c paths.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:/usr/local/bin:/usr/bin:/bin"

PROGRAM=51zNMfwD1ExHuWBPgT94jQfThaqBnnFbGMecH4AzfjWz
KEY="$(cd "$(dirname "$0")/.." && pwd)/deployer-devnet.json"

echo "=== which solana ==="
which solana
solana --version

echo
echo "=== program account ==="
solana program show "$PROGRAM" --url devnet --keypair "$KEY" 2>&1 | head -15

echo
echo "=== is it executable and does it have code? ==="
solana account "$PROGRAM" --url devnet --keypair "$KEY" 2>&1 | head -8

echo
echo "=== buffers owned by the deployer (stranded SOL if any) ==="
solana program show --buffers --url devnet --keypair "$KEY" 2>&1 | head -15

echo
echo "=== on-chain IDL account (anchor derives it from the program id) ==="
solana address --keypair "$KEY" >/dev/null 2>&1
anchor idl fetch "$PROGRAM" --provider.cluster devnet 2>&1 | head -5
