#!/usr/bin/env python3
"""Verify the MAINNET Raydium CPMM program id against a live mainnet pool.

The devnet id in `constants.rs` is ground truth — it was read off the `owner` field of our
own pool. The mainnet id came from Raydium's docs and has never been checked. A wrong
program id there is the easiest possible way for `mark_pool_created` to accept a
counterfeit pool.

Method, so the result is evidence rather than a restatement of the docs:
  1. the claimed program id must be an executable account
  2. pull a recent transaction that touched it
  3. among that transaction's accounts, find one that is 637 bytes with the PoolState
     discriminator — i.e. a real pool
  4. that pool's `owner` is the answer

Reads RPC_URL_MAINNET out of the project .env and never prints it.
"""

import base64
import json
import os
import re
import sys
import urllib.request

CLAIMED = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
POOL_STATE_LEN = 637
DISCRIMINATOR = bytes.fromhex("f7ede3f5d7c3de46")
ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")


def rpc_url():
    with open(ENV, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s*RPC_URL_MAINNET\s*=\s*(.+?)\s*$", line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    sys.exit("RPC_URL_MAINNET not found in .env")


URL = rpc_url()


def rpc(method, params):
    req = urllib.request.Request(
        URL,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
    )
    body = json.load(urllib.request.urlopen(req))
    if "error" in body:
        sys.exit(f"RPC error on {method}: {body['error']}")
    return body["result"]


print(f"claimed mainnet CPMM : {CLAIMED}")

info = rpc("getAccountInfo", [CLAIMED, {"encoding": "base64"}])["value"]
if info is None:
    sys.exit("FAIL: that address does not exist on mainnet")
print(f"  exists, executable : {info['executable']}")
print(f"  owned by (loader)  : {info['owner']}")
if not info["executable"]:
    sys.exit("FAIL: not an executable program")

sigs = rpc("getSignaturesForAddress", [CLAIMED, {"limit": 3}])
if not sigs:
    sys.exit("FAIL: no recent transactions touched it — cannot confirm it is the live AMM")
print(f"  recent txs found   : {len(sigs)}")

pool = None
for s in sigs:
    tx = rpc(
        "getTransaction",
        [s["signature"], {"encoding": "json", "maxSupportedTransactionVersion": 0}],
    )
    if tx is None:
        continue
    keys = list(tx["transaction"]["message"]["accountKeys"])
    loaded = tx.get("meta", {}).get("loadedAddresses") or {}
    keys += loaded.get("writable", []) + loaded.get("readonly", [])

    for chunk in [keys[i : i + 100] for i in range(0, len(keys), 100)]:
        accounts = rpc("getMultipleAccounts", [chunk, {"encoding": "base64"}])["value"]
        for key, acct in zip(chunk, accounts):
            if not acct:
                continue
            raw = base64.b64decode(acct["data"][0])
            if len(raw) == POOL_STATE_LEN and raw[:8] == DISCRIMINATOR:
                pool = (key, acct["owner"])
                break
        if pool:
            break
    if pool:
        break

print()
if not pool:
    sys.exit(
        "INCONCLUSIVE: no 637-byte PoolState found in the sampled transactions.\n"
        "Raise the signature limit, or paste a known mainnet CPMM pool address instead."
    )

pool_key, pool_owner = pool
print(f"live mainnet pool    : {pool_key}")
print(f"  data length        : {POOL_STATE_LEN}  (matches devnet layout)")
print(f"  owner              : {pool_owner}")
print()
if pool_owner == CLAIMED:
    print("VERIFIED: the mainnet id in constants.rs is the owner of a real mainnet pool.")
else:
    print(f"MISMATCH: constants.rs says {CLAIMED}")
    print(f"          the live pool says {pool_owner}")
    sys.exit(1)
