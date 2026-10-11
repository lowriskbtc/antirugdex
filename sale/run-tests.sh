#!/usr/bin/env bash
# Build the SBF program, then run every test. Run from anywhere:
#   bash ~/antirugdex/sale/run-tests.sh
#
# `cargo build-sbf` must run first: the integration tests `include_bytes!` the built
# .so out of target/deploy, so a stale binary means you are testing old code.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")" || exit 1

echo "=== cargo build-sbf ==="
cargo build-sbf 2>&1 | grep -vE '^\s*(Compiling|Downloaded|Downloading|Adding|Updating|Locking)' | tail -30
SBF=${PIPESTATUS[0]}
echo "SBF_EXIT=$SBF"
[ "$SBF" -ne 0 ] && exit 1

echo "=== cargo test ==="
cargo test 2>&1 | grep -vE '^\s*(Compiling|Downloaded|Downloading|Adding|Updating|Locking)' | tail -70
echo "TEST_EXIT=${PIPESTATUS[0]}"
