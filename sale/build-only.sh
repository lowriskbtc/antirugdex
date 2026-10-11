#!/usr/bin/env bash
# Compile only — `run-tests.sh` without the test run. Useful while iterating on the
# program, where the SBF build is the slow part and the first thing to break.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")" || exit 1

cargo build-sbf 2>&1 | grep -vE '^\s*(Compiling|Downloaded|Downloading|Adding|Updating|Locking)' | tail -60
echo "SBF_EXIT=${PIPESTATUS[0]}"
