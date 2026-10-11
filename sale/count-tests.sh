#!/usr/bin/env bash
# `run-tests.sh` pipes through `tail`, which hides the earlier test binaries. This prints
# every binary's result line and the total, so a claimed test count is checkable.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")" || exit 1

# `cargo build-sbf` FIRST, and not only because the tests `include_bytes!` the .so.
#
# The feature set has to match too. `anchor-build-devnet.sh` leaves a `--features devnet`
# artifact in target/deploy, and the test crate compiles `sale::constants::*` with DEFAULT
# features — so the embedded program checks the devnet Raydium id while the tests build
# pools owned by the mainnet one. That surfaces as 15 mystery failures in test_claim and
# test_mark_pool_created, not as anything mentioning features. Rebuilding with default
# features here makes the binary and the constants agree.
#
# ⚠️ The converse also holds: running the tests CLOBBERS the devnet artifact. Re-run
# `anchor-build-devnet.sh` before any devnet deploy.
cargo build-sbf >/dev/null 2>&1 || { echo "SBF BUILD FAILED"; exit 1; }
OUT=$(cargo test 2>&1)
echo "$OUT" | grep -E '^(running|test result)' | paste - - 2>/dev/null || echo "$OUT" | grep -E '^test result'
echo "---"
echo "$OUT" | grep -oP '^test result: ok\. \K[0-9]+' | paste -sd+ | bc | xargs -I{} echo "TOTAL PASSED: {}"
# `grep -c` exits 1 on zero matches, which would make a fully green run look like a failure.
FAILED=$(echo "$OUT" | grep -cE '^test result: FAILED' || true)
echo "FAILED BINARIES: $FAILED"
[ "$FAILED" -eq 0 ]
