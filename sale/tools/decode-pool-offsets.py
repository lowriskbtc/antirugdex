#!/usr/bin/env python3
"""Print the byte offset of every PoolState field, read off the live devnet pool.

`decode-pool.py` proves the *values*; this proves the *offsets* that end up hardcoded
in `constants.rs`. A wrong offset there silently accepts a counterfeit pool, so every
constant in that file has to trace back to a run of this script, not to documentation.
"""

import base64
import json
import struct
import urllib.request

POOL = "6zKJcfzmYCFY5qnC71q4nEwqTcPEiwzKWi4qAcTrXRCs"
ARD = "8bSRoK9tkafJEhyiNR6yrcYvm4TrnaezDroyc4VnfaT3"
# The devnet deployer/treasury: whoever sent the create-pool transaction.
DEVNET_DEPLOYER = "A9h5uLS658uH5x2Nfk9F8LiSGEz89HozCpuHpnCCxrAb"
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
d = base64.b64decode(info["data"][0])

print(f"pool owner   : {info['owner']}")
print(f"data length  : {len(d)}")
print(f"discriminator: {d[:8].hex()}")
print()

off = 8
for n in [
    "amm_config", "pool_creator", "token_0_vault", "token_1_vault", "lp_mint",
    "token_0_mint", "token_1_mint", "token_0_program", "token_1_program", "observation_key",
]:
    print(f"  {off:4}  {n:22} = {b58encode(d[off:off + 32])}")
    off += 32

for n in ["auth_bump", "status", "lp_mint_decimals", "mint_0_decimals", "mint_1_decimals"]:
    print(f"  {off:4}  {n:22} = {d[off]}")
    off += 1

for n in ["lp_supply", "protocol_fees_token_0", "protocol_fees_token_1",
          "fund_fees_token_0", "fund_fees_token_1", "open_time", "recent_epoch"]:
    print(f"  {off:4}  {n:22} = {struct.unpack_from('<Q', d, off)[0]}")
    off += 8

creator = b58encode(d[40:72])
print()
print("--- checks ---")
print(f"pool_creator at offset 40 : {creator}")
print(f"  == devnet deployer      : {creator == DEVNET_DEPLOYER}")
print(f"lp_mint at offset 136     : {b58encode(d[136:168])}")
print(f"open_time at offset 373   : {struct.unpack_from('<Q', d, 373)[0]}")
print(f"ARD is token_1_mint       : {b58encode(d[200:232]) == ARD}")
