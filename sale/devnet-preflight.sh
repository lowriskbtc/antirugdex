#!/usr/bin/env bash
# Read-only. What a devnet deploy would need, before anything is spent.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")" || exit 1

DEPLOYER=A9h5uLS658uH5x2Nfk9F8LiSGEz89HozCpuHpnCCxrAb
SO=target/deploy/sale.so

echo "=== versions ==="
solana --version
anchor --version

echo
echo "=== program binary ==="
BYTES=$(stat -c%s "$SO")
echo "sale.so: $BYTES bytes"
# A BPF upgradeable deploy reserves 2x the program length, plus the ProgramData header.
NEEDED=$(solana rent $((2 * BYTES + 45)) --url devnet 2>/dev/null | grep -i 'rent-exempt minimum' || echo "?")
echo "deploy reserves ~2x: $NEEDED"

echo
echo "=== devnet deployer $DEPLOYER ==="
solana balance "$DEPLOYER" --url devnet

echo
echo "=== program id on devnet (already deployed?) ==="
solana account 51zNMfwD1ExHuWBPgT94jQfThaqBnnFbGMecH4AzfjWz --url devnet 2>&1 | head -5

echo
echo "=== IDL present? (cargo build-sbf does NOT emit one; anchor build does) ==="
ls -la target/idl/ 2>/dev/null || echo "NO target/idl/ — the TypeScript client has nothing to build against"
