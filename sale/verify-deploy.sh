#!/usr/bin/env bash
# Is the binary ON CHAIN the one we just built?
#
# `anchor deploy` exits non-zero when its IDL-upload step fails — which it always does here,
# because anchor spawns a child under CMD.EXE, which cannot handle the UNC path or read the
# /mnt/c keypair. The upgrade itself has already succeeded by that point. So the exit code
# cannot answer "did the deploy land", and neither can the log. The bytes can.
#
# `solana program dump` writes the whole ProgramData buffer, which is padded with zeros out
# to the allocated size, so the local .so is compared against an equal-length prefix and the
# remainder is checked to be zeros.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")" || exit 1

PROGRAM=51zNMfwD1ExHuWBPgT94jQfThaqBnnFbGMecH4AzfjWz
LOCAL=target/deploy/sale.so

solana program dump "$PROGRAM" /tmp/onchain.so --url devnet >/dev/null 2>&1 || {
  echo "DUMP FAILED"; exit 1;
}

SZ=$(stat -c%s "$LOCAL")
head -c "$SZ" /tmp/onchain.so > /tmp/onchain-trim.so

L=$(sha256sum "$LOCAL" | cut -d' ' -f1)
C=$(sha256sum /tmp/onchain-trim.so | cut -d' ' -f1)

echo "local sha256 : $L  ($SZ bytes)"
echo "chain sha256 : $C"

PAD=$(tail -c "+$((SZ+1))" /tmp/onchain.so | tr -d '\0' | wc -c)
echo "non-zero bytes past the local length: $PAD  (expect 0)"

if [ "$L" = "$C" ] && [ "$PAD" -eq 0 ]; then
  echo "MATCH — the deployed program IS the locally built artifact."
else
  echo "MISMATCH — the deploy did NOT land. Do not trust the program on chain."
  exit 1
fi
