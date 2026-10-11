#!/usr/bin/env bash
# Reports the versions Trident would have to coexist with. Read-only.
set -u
cd "$(dirname "$0")" || exit 1

echo "=== versions in Cargo.lock ==="
for c in solana-sdk solana-program litesvm anchor-lang spl-token-2022-interface; do
  v=$(awk -v want="$c" '
    /^name = / { n=$3; gsub(/"/,"",n) }
    /^version = / { if (n==want) { v=$3; gsub(/"/,"",v); print v } }
  ' Cargo.lock | sort -u | tr '\n' ' ')
  printf '  %-28s %s\n' "$c" "${v:-(absent)}"
done

echo
echo "=== is a solana-sdk 2.x anywhere in the tree? ==="
grep -c '^name = "solana-sdk"' Cargo.lock | sed 's/^/  solana-sdk entries: /'
