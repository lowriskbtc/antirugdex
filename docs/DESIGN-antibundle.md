# Anti-bundle launch design

Started 2026-08-06. **Rewritten 2026-08-06** after two adversarial reviews (23 agents) and a bundle-detection study.

This document explains **why** the design is what it is. [GAMEPLAN.md](GAMEPLAN.md) is what to build. Evidence is in [FINDINGS-2026-08-06.md](FINDINGS-2026-08-06.md) and [FINDINGS-bundles.md](FINDINGS-bundles.md).

> **An earlier version of this file specified two incompatible auctions** — a fixed price with refunds in one section, a uniform clearing price in another. That is resolved. **The mechanism is a fixed-price, capped, pro-rata sale.** Nothing here describes a clearing-price auction.

---

## What bundling actually is

Three different things get called "bundling," and they need separating because only one of them can be blocked:

1. **Several buys in one transaction.** Blockable on-chain, cheaply.
2. **A Jito bundle** — several *separate* transactions, executed atomically in one slot. **Cannot be detected from inside a program.** Proven below.
3. **Many wallets buying in the same slot with no bundle at all.** This is what "40% bundled" tools actually measure, and it is inference after the fact.

At a launch, the attacker's goal is to acquire a large share of supply before the public, at the lowest price.

**Per-wallet caps do not work.** Fresh wallets are free. The problem is not "too many transactions in one slot" — it is Sybil resistance, and you cannot distinguish 50 wallets owned by one person from 50 independent buyers. Every launchpad advertising "max buy per wallet" is selling a speed bump.

---

## The boundary that governs everything

> **Your rules only work where your code runs.**

**During the sale**, your program is the only path to tokens. Any rule is enforceable.

**After the sale**, tokens move peer-to-peer and through any DEX, and your program is not in the transaction. **Your rules cease to exist.**

There is exactly one mechanism that follows a token everywhere — `TransferHook` — and it is closed to us for two independent reasons: DEXs reject active hooks (Raydium CPMM has no support; Meteora accepts hook mints *only when the hook is inert*), and more decisively, **a hook that can reject a transfer is indistinguishable from freeze authority to a buyer.** That would falsify the one claim the project exists to make.

So: constrain the launch, then make the post-launch state **structurally safe** (LP burned, authorities revoked) rather than actively policed.

---

## The two properties that do the work

### Property 1 — allocation is computed at settlement, pro-rata

Nothing fills while the sale is open. At close:

```
allocation = floor(your commitment / total commitments × supply_for_sale)
```

- **Ordering is worth exactly zero.** Arriving first, or in the same slot as anyone else, changes nothing.
- **Sybil is worth exactly zero.** 100 SOL from one wallet and 100 SOL across 50 wallets produce the identical allocation.

> **Test every change against this:** if allocation depends on *when* a bid arrived or *how many wallets* it came from, the mechanism is broken.

**This held under adversarial attack.** A dedicated red team could not beat it: *"Splitting c across k wallets contributes the identical c — Sybil gain is exactly 1.0, not approximately. A Jito bundle buys atomicity and same-slot ordering, and in this window BOTH are worthless."*

### Property 2 — no AMM pool exists during the sale

There is nothing to snipe. The pool is created after settlement.

---

## Why fixed price, and not a clearing price

Both were live options. Fixed price won on cold start.

| | **Fixed price + cap + refunds** (chosen) | Uniform clearing price |
|---|---|---|
| Bidder knows their price | Yes | No — unbounded |
| Refund path | Required (more code) | None needed |
| Pool opens at fair value | No — price must be chosen | Yes, by construction |
| **An extra bidder dilutes you** | **Only above the cap** | **Always** |
| One-bidder case | Small | Catastrophic — one wallet takes everything |

The deciding argument is the dilution row. **Under a clearing price, every new bidder dilutes everyone already in — so your most motivated supporters are financially punished for recruiting.** A bonding curve has the opposite property, which is *why* bonding-curve launches spread themselves and batch sales do not.

Under a fixed price below the cap, an extra bidder dilutes nobody. Dilution begins only once the sale is already succeeding.

The clearing price is genuinely tempting — materially less code, no refund path, and the pool opens at fair value for free. It loses because cold start is the binding constraint and an unquotable price is unsellable.

---

## Settled: this cannot live in the token

Beyond `TransferHook`: **a decaying sniper tax cannot be built from Token-2022 fees.** `setTransferFee` is epoch-scoped — roughly two days before a new rate activates. Second-scale decay only exists inside a program that prices the buy, and that program is an AMM, not a mint.

---

## Settled: a Jito bundle cannot be blocked

Not "hard." Not "expensive." **The capability does not exist**, proven by three complete enumerations:

- **All 43 syscalls** registered in `create_program_runtime_environment()`. None mentions a bundle, block engine, slot position, transaction count, leader, or tip.
- **All 12 sysvars.** None carries bundle membership or intra-slot ordering.
- **All 123 accepted SIMDs.** Zero propose exposing it. Nothing is coming.

The reason is architectural: the function building the instructions sysvar takes **one transaction** as input. A bundle is N separate transactions; each gets its own sysvar, blind to the other N−1. There is no `BlockContext` or `BundleContext` in the runtime.

**And you cannot block Jito by proxy either.** A block-engine transaction is on-chain identical to an RPC one. The only signal is the tip — which can sit in a *different transaction of the bundle*, and which modern wallets attach to ordinary user swaps as standard landing behaviour. Blocking on tips rejects honest mobile users while a bundler moves the tip one transaction over.

**What *is* blockable:** several buys in one transaction, via the instructions sysvar plus `get_stack_height() == 1`. About twenty lines. See below for where to point them.

---

## Where the threat actually is

The reviews moved the target. Ranked by profit available:

**1. Pool open, the sell side.** Every participant's tokens become liquid at the same instant and the first seller gets the best price on a thin pool. The attacker bought their allocation **legitimately** and simply exits first. Every deposit-side defence is irrelevant here — your program is not in the swap transaction.

**2. Pool open, the buy side.** Pool creation is public and *predictable* (the address is derivable from the mint pair). A sniper lands a buy in the same or next slot.

**3. Claim open.** Hundreds of holders, known cost basis, a thin pool — the profitable move is **claim and dump atomically in one transaction.** This is exactly what the twenty-line check blocks, which is why it belongs on `claim()` and not on `bid()`.

> *"Same twenty lines of Rust, pointed at the wrong instruction."*

Severity at claim-open is a function of **concentration**, which links it to Property 1's residual: under pro-rata, concentration is the sole remaining amplifier of first-mover value.

---

## The answer: sequencing, not detection

```
settle (permissionless)
  → create + seed pool, open_time set hours ahead
  → burn LP
  → publish pool address, LP burn tx, verification report
  → open_time passes; trading live, ZERO circulating float
  → claims open
```

Raydium CPMM's `open_time` is enforced in `swap_base_input.rs`, and LP tokens mint at `initialize` — so the pool can be seeded, burned, and fully published **while trading is provably impossible.**

**Claims come last on purpose.** With zero circulating ARD, a third party cannot create a competing pool at all, and the only possible first trade is a buy.

> *"For a project whose thesis is 'LIBRA happened because nobody checked the configuration before people bought,' a mandatory window in which the configuration is final, immutable, on-chain, and untradeable is not a mitigation. It is the product."*

**The opening price is a free variable, not a constraint.** `P_pool = SOL in pool ÷ tokens in pool`, and you choose the tokens. The snipe was *a discount being handed out*.

The venue is **Raydium CPMM**, chosen because its LP burn is trivially verifiable — fungible LP tokens to the incinerator, supply reads zero — whereas a Meteora position is an NFT whose "permanent lock" still pays claimable fees to an assignable address. For a project whose pitch is *verify it yourself*, pick the venue that needs no explanation.

The cost of that choice is real: **Raydium has no launch fee decay** (tiers fixed at creation), so the opening price is the only remaining lever against the buy-side snipe. Therefore:

- **Open above sale price, and burn the residual tokens.** Fewer tokens in the pool means a higher opening price; the leftover must not sit in a deployer wallet, which would be a supply overhang the grader itself would flag. Burning converts "we priced the open high" into a verifiable permanent supply reduction.
- **Never derive the price from the oversubscription ratio** — reflexive, no valuation content, and the deployer can inflate it for free with refundable bids.

**This is only safe because of the sequencing.** Claims open after trading, so at pool-open there is zero circulating float and nobody holds inventory to dump into an overpriced pool. Reverse the order and opening high *builds* a sell-side snipe.

**Named honestly:** you cannot make both the first buy and the first sell worthless without a custom AMM. Opening above sale price routes the residual to a sale participant selling — someone who took sale risk, bounded by pool depth — rather than to an outside sniper buying. A choice about *who* gets the residual, not an elimination of it.

---

## The risk that gates everything: escrow

A bonding curve never custodies user funds beyond the instant of a swap. A pro-rata sale **holds every bidder's SOL for the whole window**, in an unaudited program written by someone learning Rust, as the flagship of a project whose brand is *not losing people's money*.

Non-negotiable guardrails:

- **Hard cap** on total raise, small enough that total loss is survivable
- **Hard cap per bid**, and a minimum bid
- **A withdraw-only emergency path** independent of all settlement logic
- **An absolute on-chain deadline**, so funds can never be held indefinitely
- **A `pool_deadline`** — if the pool is not created in time, claims flip permissionlessly to full refund
- **Permissionless settlement** — nothing time-critical may require the builder to be awake
- **A timelocked upgrade authority.** A solo multisig is theatre; a solo timelock is not, because the value is *delay* — a queued upgrade is visible long enough for bidders to exit
- **First sale uses only the builder's own SOL**, end to end, on mainnet

> **The design invariant to test against:** *if the allocation computation were completely broken, can every bidder still recover their principal?* If not, keep redesigning.

**This is also why launch #1 does not vest.** The SOL leg can always be made safe — refund the recorded amount, zero dependency on the calculator. **A vesting leg cannot**: there is no principal to return, only an entitlement that *is* the settlement output, so any emergency unlock depends on exactly the accounting that broke.

---

## Cold start — the risk that is easy to ignore

A pro-rata sale needs **simultaneous** bidders. A bonding curve works with exactly one buyer; a batch sale with three participants is a public failure.

The mechanism-level handicap is dilution above the cap, which fixed pricing minimises. The remaining answer is to **reframe the failure case**: set a published minimum floor, and below it the sale auto-cancels and refunds permissionlessly.

> A first sale that misses its floor and refunds every participant perfectly, on-chain, in public, is a **better** advertisement for an anti-rug brand than a mediocre successful sale. It is a live, adversarial demonstration that the exit path works.

Also: the grader is not only a de-risked first product — it is **the only free distribution channel available**, because it gives you something specific and shareable to publish about other people's live launches every day.

---

## What survives pro-rata: multi-wallet, not bundling

The fee — even at 0.25% — makes redistributing an allocation *after* settlement cost 0.25% per hop, while arriving already split across 100 wallets costs about $0.40 in unrecoverable fees. That is still a large incentive to bid from many wallets.

**It is harmless to allocation** (pro-rata guarantees that) but it matters for two things: the published transcript will show distribution that is not real, and any *future* per-wallet benefit would retroactively reward it.

**So: commit publicly, now, that no future benefit will ever be distributed per-wallet rather than per-token-held.** Free to promise today.

And any published "bundled supply %" **must state what it cannot see.** A whale splitting across 300 exchange-funded wallets would otherwise be certified clean by your own tool — *"you are the laundering mechanism."*

---

## Nothing built so far is wasted

The mint is independent of the launch mechanism. Surviving every path: `config.ts`, `01-create-mint.ts`, `02-verify.ts`, `04-harvest.ts`, `05-lock-down.ts`, the deployed metadata, and the full devnet verification.

Two token changes remain before mainnet: **`feeBasisPoints` 100 → 25**, and **the metadata URI moved to content-addressed storage.**

---

## Decisions log

| Date | Decision |
|---|---|
| 2026-08-06 | Anti-bundle lives in the distribution mechanism, not the token. `TransferHook` rejected permanently |
| 2026-08-06 | Per-wallet caps rejected — they re-create the Sybil incentive pro-rata removes |
| 2026-08-06 | **Fixed-price capped pro-rata sale.** Clearing price rejected on cold-start grounds |
| 2026-08-06 | **Transfer fee 1% → 0.25%.** Does not fix account-closing or the integration ceiling — only a zero fee would |
| 2026-08-06 | **Bids irrevocable.** Withdrawal would let someone suppress the book and re-enter |
| 2026-08-06 | **Running total public, with a capped activity extension** |
| 2026-08-06 | **No vesting on launch #1** — the emergency-refund guarantee has no token-side equivalent |
| 2026-08-06 | Anti-bundle check goes on `claim()`, not `bid()` |
| 2026-08-06 | Pool created, seeded, burned and published **before** claims open |
| 2026-08-06 | Opening price pre-committed at 1.00×; never derived from oversubscription |
| 2026-08-06 | Jito blocking rejected — undetectable at execution, and the tip signal marks honest users |
| 2026-08-06 | Registration / slot-age gates rejected — cheap to evade, expensive to honest late bidders |

## Still open

- **Pool venue** (Raydium CPMM vs Meteora DAMM v2) — decides the grader's initial scope
- Whether the grader ships before, alongside, or instead of the sale program
