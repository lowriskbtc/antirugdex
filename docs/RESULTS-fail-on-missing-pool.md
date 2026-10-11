# `fail_on_missing_pool` — devnet rehearsal, 2026-08-10

The last sale instruction never run against a validator. This is the **abandonment recovery
path**: the sale succeeded, the builder never created the pool, and bidders get everything
back without needing the builder's cooperation.

Mint `7wPiht7Nee1BMKvd7YcpP19564acz6TGxXeMGsLRkAdZ` — the same fresh mint created earlier
today to prove the Arweave grader row. One Sale PDA per mint, forever, so this mint is spent
on this rehearsal.

## Predictions — written BEFORE the run

The 2026-08-09 rehearsal was worth doing because every figure was predicted first and then
compared. Same discipline here. Anything that does not match is a finding.

| # | prediction |
|---|---|
| P1 | Vault funded with 200,000,000 ARD; 0.25% fee takes 500,000; vault holds **199,500,000 spendable + 500,000 withheld** |
| P2 | `supply_for_sale` = **199,500,000,000,000,000** base units — the vault's full `base.amount`, nothing held back |
| P3 | `close_ts` = T+400, `absolute_deadline` = T+700, `pool_deadline` = T+760 |
| P4 | One bid of 1 SOL from a **fresh** wallet → `total_committed` = **1,000,000,000** lamports, `commitment_count` = 1 |
| P5 | `extension_count` = **0** — the bid lands with ~380s remaining, above the 300s `EXTENSION_TRIGGER_SECONDS`, so no extension fires |
| P6 | `finalize` at T≥400 → **Succeeded** (1,000,000,000 ≥ floor 500,000,000) |
| P7 | `fail_on_missing_pool` before T+760 → **rejected**, `PoolDeadlineNotReached` |
| P8 | `fail_on_missing_pool` at T≥760 → status **Succeeded → Failed**, and the SOL vault balance is **unchanged** (this instruction moves no money) |
| P9 | `refund` → bidder gains **exactly 1,000,000,000** lamports, paid by the deployer |
| P10 | After the refund the SOL vault holds only its **rent-exempt reserve** — no bidder principal left behind |

P10 is the one the 08-09 rehearsal taught us to write down: 90 passing tests missed the
stranded vault residue because **not one asserted what was left at the end**.

## The run

Started 2026-08-11 05:08:05Z. Sale PDA `4jhR7AaWPsLazCSMLM769PcEg7s6UxNeMK1wWBAQ7bZi`,
token vault `Bh3hftgo…`, SOL vault `7SMzj755…`, bidder
`5nHpYYWsFeYR6T7vHky91w9QEJLVedJrCGYEFkfu9qVm` (fresh throwaway — deliberately not the
deployer, so the refund delta is not muddied by the fee payer being the same wallet).

| # | prediction | result |
|---|---|---|
| P1 | 199,500,000 spendable + 500,000 withheld | ✅ exact |
| P2 | `supply_for_sale` = 199,500,000 (full `base.amount`) | ✅ exact |
| P3 | close T+400, absolute +300, pool +60 | ✅ `05:14:48Z` / `05:19:48Z` / `05:20:48Z` |
| P4 | 1 SOL from 1 bidder | ✅ `1 SOL from 1 wallet(s)` |
| P5 | `extension_count` = 0 | ✅ bid landed with 386s remaining (>300 trigger); `close_ts` did not move |
| P7 | rejected before the deadline | ✅ `PoolDeadlineNotReached`, 731s remaining |
| P6, P8, P9, P10 | — | see below |

Also recorded before the settlement steps: the SOL vault held **1,000,890,880 lamports** —
the 1 SOL bid plus an **890,880 lamport** rent-exempt reserve. That reserve is the figure
P10 is measured against.

## Result — all ten predictions matched, to the lamport

| # | prediction | result |
|---|---|---|
| P6 | `finalize` → Succeeded | ✅ `Bidding -> Succeeded` at 05:15:32Z |
| P8 | Succeeded → Failed, vault **unchanged** | ✅ `1000890880` lamports before and after — the instruction moves no money |
| P9 | bidder gains exactly 1,000,000,000 lamports | ✅ `0.04842204 -> 1.04842204 SOL`, `lamports_refunded: 1000000000` |
| P10 | vault left holding only its rent reserve | ✅ **890,880 lamports** — exactly the reserve measured before settlement. No bidder principal stranded. |

`extension_count` printed as `extended 0 time(s)`, confirming P5 independently.

### Transactions

| step | tx |
|---|---|
| `initialize_sale` | `2mPbxgQ6XJEMSjbLHSgwvk45fHLJvW6XuhxdcTYwKmwuSdycPjEaWNy3ai5nRyYQFsmXuZnwJ5Wykg7hYmoaho13` |
| `bid` (1 SOL) | `hfrHP2nTrfvYkyvitDM2coeiaVZqjZQyAZdavSv81YtRkQjpvXCwUkNuJPTY9vhhgTdyenfojMiU51Amu8NkzWF` |
| `finalize` | `5zA6ApCTwHM5xYZYxBGDXW5TjzevtXwL6sttbRCWZY9Uy1rnMuVuQj95cAQYGzVMAj1nLsjAhNuSgupaAiF99aEk` |
| **`fail_on_missing_pool`** | `4ucyMooBUMUM8JKeLHwxFAXNdnX7mo9DZ9uSQkKvp3ifR4kSPGpR3WiKEmi2zPuNgE7PKVgaPs7F9XDM36mDtBhP` |
| `refund` | `4Egrw2TefhGmCLwW4HA8dztY47wWjJu4cYok8X6aKXpBzkJQq9Zc9xuozkpjTq2nMZqh2Lf9yNYC8WJ1nERHEmvH` |

### Expected oddity, not a finding

`10-sale-status.ts` reports `claims settled: 0 of 1` *after* the refund landed. That is
deliberate: `refund` does not write the `Sale` account at all, so it never increments
`claim_count`. Documented in SALE-PROGRAM.md's open items, and it is the reason the refund
path stays the plainest instruction in the program — if the allocation math were completely
broken, principal recovery would still work, because the recovery path does not contain
that math.

### What this closes

**Every instruction in the sale program has now run against a real validator.**
`fail_on_missing_pool` was the last one. Both routes into `Failed` are now proven on chain:
`finalize` below the floor (2026-08-09, mint `4wY2cFxa…`) and this one.

The property that matters: a bidder recovered 100% of principal on a sale where the builder
took the money and never created the pool — **without the builder's cooperation, and without
the bidder signing anything.** The deployer paid the fee here only because it was convenient;
the instruction has no signer account at all, so any funded wallet could have done it.

### What it does NOT prove

- Nothing here tests pool *depth*, only pool *existence*. `10-sale-status.ts` prints that
  caveat on every run and it remains true.
- `SALE_GRACE=300` / `SALE_POOL_GRACE=60` were used to compress a two-hour wait into twelve
  minutes. Both default to 3600 and **must not be passed on mainnet** — no guard checks them,
  because they are sale parameters rather than configuration.
