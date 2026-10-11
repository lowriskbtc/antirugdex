#!/usr/bin/env bash
# The property harness on its own, with output shown.
#
# Kept separate from run-tests.sh so a property failure is read as "a seed reproduces this",
# not as a flaky suite. The seed and step index are printed in every assertion message.
set -uo pipefail
# Same PATH line as run-tests.sh: a non-login shell does not source the profile, so
# ~/.cargo/bin has to be added explicitly or cargo is not found.
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")" || exit 1

echo "=== cargo build-sbf ==="
cargo build-sbf 2>&1 | grep -vE '^\s*(Compiling|Downloaded|Downloading|Adding|Updating|Locking)' | tail -5
SBF=${PIPESTATUS[0]}
[ "$SBF" -ne 0 ] && { echo "SBF_EXIT=$SBF"; exit 1; }

echo "=== property run ==="
cargo test --test test_invariants -- --nocapture 2>&1 | grep -vE '^\s*(Compiling|Downloaded|Downloading|Adding|Updating|Locking)' | tail -60
echo "INVARIANTS_EXIT=${PIPESTATUS[0]}"
