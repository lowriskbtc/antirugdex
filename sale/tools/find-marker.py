#!/usr/bin/env python3
"""Find a valid 32-byte Solana pubkey whose base58 begins with 'jitodontfront'."""

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
IDX = {c: i for i, c in enumerate(ALPHABET)}


def b58decode(s):
    n = 0
    for ch in s:
        if ch not in IDX:
            return None
        n = n * 58 + IDX[ch]
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + body


def b58encode(b):
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    pad = len(b) - len(b.lstrip(b"\x00"))
    return "1" * pad + out


PREFIX = "jitodontfront"
found = []
for total_len in range(len(PREFIX) + 1, 45):
    cand = PREFIX + "1" * (total_len - len(PREFIX))
    d = b58decode(cand)
    if d is not None and len(d) == 32:
        # Round-trip: canonical encoding must reproduce the string exactly.
        if b58encode(d) == cand:
            found.append((total_len, cand, d.hex()))

for ln, cand, hx in found:
    print(f"len={ln}  {cand}")
    print(f"          bytes={hx}")
print(f"\n{len(found)} valid marker(s)")
