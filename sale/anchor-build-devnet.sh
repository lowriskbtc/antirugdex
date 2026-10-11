#!/usr/bin/env bash
# `cargo build-sbf` (what run-tests.sh uses) does NOT emit an IDL. `anchor build` does, and
# the TypeScript client has nothing to build against without it.
#
# Built WITH --features devnet, because that is what a devnet dress rehearsal has to run:
# the feature swaps the hardcoded Raydium CPMM program id to the devnet deployment. A plain
# build is the mainnet artifact.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")" || exit 1

echo "=== solana before (anchor has been known to eat this) ==="
solana --version

anchor build -- --features devnet 2>&1 \
  | grep -vE '^\s*(Compiling|Downloaded|Downloading|Adding|Updating|Locking)' | tail -40
echo "ANCHOR_EXIT=${PIPESTATUS[0]}"

echo
echo "=== solana after ==="
solana --version

echo
echo "=== artifacts ==="
ls -la target/deploy/sale.so target/idl/sale.json 2>&1

echo
echo "=== IDL instructions ==="
python3 -c "
import json
d = json.load(open('target/idl/sale.json'))
print('spec     :', d.get('metadata', {}).get('spec', d.get('spec')))
print('address  :', d.get('address'))
print('ixs      :', [i['name'] for i in d['instructions']])
print('accounts :', [a['name'] for a in d.get('accounts', [])])
for t in d.get('types', []):
    if t['name'] == 'Sale':
        print('Sale fields:', [f['name'] for f in t['type']['fields']])
"
