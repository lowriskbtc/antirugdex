#!/usr/bin/env bash
# Deploy the sale program to DEVNET. Costs ~4.99 SOL of devnet rent, recoverable by
# closing the program later.
#
# Assumes `anchor-build-devnet.sh` has run: the artifact must carry --features devnet or it
# has the mainnet Raydium CPMM id compiled in and will reject every devnet pool.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")" || exit 1

PROGRAM=51zNMfwD1ExHuWBPgT94jQfThaqBnnFbGMecH4AzfjWz
DEPLOYER=A9h5uLS658uH5x2Nfk9F8LiSGEz89HozCpuHpnCCxrAb

echo "=== balance before ==="
solana balance "$DEPLOYER" --url devnet

echo
echo "=== deploying ==="
anchor deploy --provider.cluster devnet 2>&1 | tail -20
echo "DEPLOY_EXIT=${PIPESTATUS[0]}"

echo
echo "=== balance after ==="
solana balance "$DEPLOYER" --url devnet

echo
echo "=== program account on devnet ==="
solana program show "$PROGRAM" --url devnet 2>&1 | head -12
