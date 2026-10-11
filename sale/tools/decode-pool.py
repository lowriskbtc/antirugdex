#!/usr/bin/env python3
"""Decode the real devnet CPMM pool we created, to validate the PoolState layout
and learn the actual owning program id. Ground truth beats documentation."""

import base64
import json
import struct
import urllib.request

POOL = "6zKJcfzmYCFY5qnC71q4nEwqTcPEiwzKWi4qAcTrXRCs"
ARD = "8bSRoK9tkafJEhyiNR6yrcYvm4TrnaezDroyc4VnfaT3"
RPC = "https://api.devnet.solana.com"

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b):
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    pad = len(b) - len(b.lstrip(b"\x00"))
    return "1" * pad + out


def rpc(method, params):
    req = urllib.request.Request(
        RPC,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req))["result"]


info = rpc("getAccountInfo", [POOL, {"encoding": "base64"}])["value"]
print(f"pool owner (program id) : {info['owner']}")
print(f"data length             : {len(base64.b64decode(info['data'][0]))}")

d = base64.b64decode(info["data"][0])
print(f"discriminator           : {d[:8].hex()}")

off = 8
names = [
    "amm_config", "pool_creator", "token_0_vault", "token_1_vault", "lp_mint",
    "token_0_mint", "token_1_mint", "token_0_program", "token_1_program", "observation_key",
]
fields = {}
for n in names:
    fields[n] = b58encode(d[off:off + 32])
    off += 32

for n in ["auth_bump", "status", "lp_mint_decimals", "mint_0_decimals", "mint_1_decimals"]:
    fields[n] = d[off]
    off += 1

for n in ["lp_supply", "protocol_fees_token_0", "protocol_fees_token_1",
          "fund_fees_token_0", "fund_fees_token_1", "open_time", "recent_epoch"]:
    fields[n] = struct.unpack_from("<Q", d, off)[0]
    off += 8

print()
for k, v in fields.items():
    print(f"  {k:22} = {v}")

print()
print(f"offset after recent_epoch: {off}  (PoolState::LEN = {8 + 10*32 + 5 + 8*7 + 2 + 6 + 2*8 + 8*28})")
print()
print("--- checks ---")
print(f"ARD is token_0_mint     : {fields['token_0_mint'] == ARD}")
print(f"ARD is token_1_mint     : {fields['token_1_mint'] == ARD}")
print(f"lp_supply == 0          : {fields['lp_supply'] == 0}")

lp = rpc("getTokenSupply", [fields["lp_mint"]])["value"]
print(f"lp mint actual supply   : {lp['amount']} (decimals {lp['decimals']})")
