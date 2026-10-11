#!/usr/bin/env bash
# Read-only. Confirm the keypairs a deploy would use are the ones we think they are.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

DEPLOYER_KEY="$(cd "$(dirname "$0")/.." && pwd)/deployer-devnet.json"
PROGRAM_KEY="$(dirname "$0")/target/deploy/sale-keypair.json"

echo "=== payer / upgrade authority ==="
if [ -f "$DEPLOYER_KEY" ]; then
  echo "file    : $DEPLOYER_KEY"
  echo "pubkey  : $(solana-keygen pubkey "$DEPLOYER_KEY")"
  echo "expected: A9h5uLS658uH5x2Nfk9F8LiSGEz89HozCpuHpnCCxrAb  (devnet deployer/treasury)"
else
  echo "MISSING: $DEPLOYER_KEY"
fi

echo
echo "=== program identity ==="
echo "file    : $PROGRAM_KEY"
echo "pubkey  : $(solana-keygen pubkey "$PROGRAM_KEY")"
echo "expected: 51zNMfwD1ExHuWBPgT94jQfThaqBnnFbGMecH4AzfjWz  (declare_id! in lib.rs)"
