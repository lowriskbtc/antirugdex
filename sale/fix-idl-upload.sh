#!/usr/bin/env bash
# ⚠️ STILL FAILS — kept as the reproduction, not as a working fix. See the ruled-out list
# at the bottom. The on-chain IDL is optional: the TypeScript client reads
# `target/idl/sale.json` directly, and only block explorers need the on-chain copy.
#
# The program deployed fine; only the on-chain IDL upload failed. Two causes were found and
# fixed, and neither was sufficient:
#
#  1. `~/.config/solana/id.json` did not exist. Anchor resolves its DEFAULT provider wallet
#     before running any subcommand — even `idl fetch`, which needs no signer at all — so
#     every `anchor idl` call died with a bare "No such file or directory (os error 2)".
#     A throwaway keypair at that path is enough; it never signs anything here.
#
#  2. WSL inherits the Windows PATH, and `anchor` rewrites PATH for the processes it spawns
#     (TOOLCHAIN-2026-08-07.md, trap 2). A child resolved to the WINDOWS solana.exe, which
#     ran under CMD.EXE, could not cd to a UNC path, and could not read /mnt/c keypairs.
#     Stripping every Windows entry means there is no .exe to find.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")" || exit 1

PROGRAM=51zNMfwD1ExHuWBPgT94jQfThaqBnnFbGMecH4AzfjWz
KEY=../deployer-devnet.json

# A placeholder so anchor's default-wallet resolution succeeds. NOT the deploy authority,
# never funded, never signs — the real wallet is passed explicitly below.
if [ ! -f "$HOME/.config/solana/id.json" ]; then
  echo "=== creating throwaway default wallet (anchor requires one to exist) ==="
  solana-keygen new -o "$HOME/.config/solana/id.json" --no-bip39-passphrase --silent
  echo "placeholder pubkey: $(solana-keygen pubkey "$HOME/.config/solana/id.json")"
fi

echo
echo "=== anchor idl init ==="
anchor idl init "$PROGRAM" \
  --filepath target/idl/sale.json \
  --provider.cluster devnet \
  --provider.wallet "$KEY" 2>&1 | tail -15
echo "IDL_EXIT=${PIPESTATUS[0]}"

echo
echo "=== fetch it back from chain and diff against local ==="
anchor idl fetch "$PROGRAM" --provider.cluster devnet -o /tmp/onchain-idl.json 2>&1 | head -3
if [ -f /tmp/onchain-idl.json ]; then
  python3 -c "
import json
a = json.load(open('/tmp/onchain-idl.json'))
b = json.load(open('target/idl/sale.json'))
print('on-chain ixs :', len(a['instructions']))
print('local ixs    :', len(b['instructions']))
print('identical    :', a == b)
"
fi

# ---------------------------------------------------------------------------
# Ruled out, so the next attempt does not repeat them
# ---------------------------------------------------------------------------
#  - NOT the missing default wallet. Creating ~/.config/solana/id.json did not change it.
#  - NOT the Windows solana.exe. With every /mnt/c entry stripped from PATH it still fails.
#  - NOT missing solana CLI config. `solana config set` succeeded; still fails.
#  - NOT a workspace-relative path. `anchor idl fetch` fails identically from /tmp, and
#    `fetch` takes no local file and needs no signer.
#  - NOT a subprocess. RUST_BACKTRACE=full puts the error inside `anchor_cli::idl` itself,
#    with no exec in the stack — so it is a file open in anchor's own IDL code.
#
# Leading hypothesis: anchor-cli 1.x moved IDLs to the "program metadata" standard — note
# the `--non-canonical` flag on `idl fetch` — so `idl init` may simply be the wrong verb
# now. Check the anchor 1.x IDL docs before debugging further.
