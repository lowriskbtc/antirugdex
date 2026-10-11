# Devnet rehearsal at the proposed LAUNCH numbers — 2026-08-11

Validates the A2 numbers before any mainnet SOL moves. Everything here uses the values
actually proposed for launch, not rehearsal placeholders.

Mint `HyWfpEipbqMVPWFME2NzabMn87NTk5Sbf2jn6UUoin76` (fee authority revoked),
sale `ApVeUty3w1paeA12Tciimu3AF5HWjoqCtKp7eaCy65RB`.

## The numbers under test

| parameter | value |
|---|---|
| price | 5 lamports per whole ARD |
| hard cap | 1.99 SOL |
| floor | 0.8 SOL |
| min bid | 0.02 SOL |
| sale vault funded with | 400,000,000 ARD |
| pool seed | 2 SOL + 400,000,000 ARD |

Window/grace values are compressed for the rehearsal (420s / 300s / 600s). **The real window
is 8h**, and `SALE_GRACE` / `SALE_POOL_GRACE` must never be passed on mainnet.

## Deliberately oversubscribed

Two fresh bidders, **2.4 SOL against a 1.99 SOL cap — 120.6% subscribed**, so the pro-rata
path is the one under test. That is the mechanism the whole anti-bundle design rests on, and
the two previous devnet rehearsals were both *under*subscribed, so it had never run on chain
at any numbers.

| bidder | committed |
|---|---|
| `AfLtjYc4qp7pD9kEtYGapiW4f7uvvEMJRK7CxV8NymL9` | 1.4 SOL |
| `43Zr7nMvjzEFMpqkosoLLD898NjBtvxeEZQwRw7981zR` | 1.0 SOL |

## Predictions — computed from `claim`'s formulas BEFORE settlement

`C = 2,400,000,000` lamports, `S = 399,000,000` whole tokens, `cap = 1,990,000,000`,
`P = 5`, oversubscribed branch: `tokens_i = floor(c_i·S/C)`, `accepted_i = floor(c_i·cap/C)`,
`refund_i = c_i − accepted_i`.

| # | prediction |
|---|---|
| Q1 | Vault holds **399,000,000 spendable + 1,000,000 withheld** ✅ *(already confirmed at init)* |
| Q2 | `extension_count` = **0** — both bids landed >300s from close |
| Q3 | Status after finalize = **Succeeded** (2.4 SOL ≥ 0.8 floor) |
| Q4 | tokens_A = **232,750,000** whole ARD gross |
| Q5 | tokens_B = **166,250,000** whole ARD gross |
| Q6 | Q4 + Q5 = **399,000,000 = S exactly** — no flooring dust on the token side at these numbers |
| Q7 | accepted_A = **1,160,833,333** lamports → refund_A = **239,166,667** |
| Q8 | accepted_B = **829,166,666** lamports → refund_B = **170,833,334** |
| Q9 | Total swept = **1,989,999,999** lamports — **1 lamport under the cap**, from double flooring. Expected, not a bug |
| Q10 | Refunds total **410,000,001**; accepted + refunded = **2,400,000,000** exactly |
| Q11 | Claimers receive **net of the 0.25% fee**: A gets **232,168,125**, B gets **165,834,375** whole ARD |
| Q12 | `burn_unsold` burns **0** (S − total_claimed = 0) and the token vault ends at **exactly zero** |
| Q13 | Pool receives **399,000,000** ARD from a 400,000,000 send; pool price **5.0125** lamports/token vs the 5 nominal — the seeding haircut, expected |
| Q14 | Float held by buyers = **398,002,500** vs pool depth **399,000,000** → **≈1:1**, against the earlier rehearsal's 1:199 |
| Q15 | Deployer retains **200,000,000 ARD = 20% of supply** — the overhang that still needs a burn/lock decision |

Q14 is the whole point of choosing 5 lamports as the price. Q15 is the open question these
numbers do not answer.

## Result

Sale `ApVeUty3w1paeA12Tciimu3AF5HWjoqCtKp7eaCy65RB`, pool
`zzxU6e86uU2Nzf8jSydTP3MU4sEbejAg8uYK1P7dNZM` (LP burned to zero supply).

### Confirmed exactly

| # | prediction | result |
|---|---|---|
| Q1 | 399,000,000 spendable + 1,000,000 withheld | ✅ |
| Q2 | `extension_count` = 0 | ✅ `extended 0 time(s)` |
| Q3 | Succeeded | ✅ |
| Q4 | tokens_A = 232,750,000 | ✅ `232750000000000000` base units |
| Q5 | tokens_B = 166,250,000 | ✅ `166250000000000000` |
| Q6 | sum = 399,000,000 = S exactly | ✅ |
| Q7 | accepted_A 1,160,833,333 → refund 239,166,667 | ✅ both exact |
| Q8 | accepted_B 829,166,666 → refund 170,833,334 | ✅ both exact |
| Q11 | net A 232,168,125 / net B 165,834,375 | ✅ both exact |
| Q13 | pool price 5.0125 vs 5 nominal | ✅ seeding haircut as expected |

Subscription read **120.6% — OVERSUBSCRIBED**, so the pro-rata branch is now exercised on
chain for the first time, at the real launch numbers.

### Q9 — right total, wrong number of calls. **Sweeping is a TWO-step operation.**

Predicted swept = **1,989,999,999** (the sum of `accepted_i`). The **first** sweep moved
**1,989,999,998**; a **second** sweep after both claims settled moved the last **1 lamport**,
landing on exactly 1,989,999,999. So the prediction was right about the end state and wrong
about how to get there.

`sweep_proceeds` cannot know the per-bidder split until each claim runs, so before claims
settle it uses a **conservative ceiling of `cap − commitment_count`** — here
`1,990,000,000 − 2` — rather than risk taking a lamport that belongs to a refund. The
shortfall is recoverable, but **only by calling `sweep_proceeds` again after the last claim.**

The residue is bounded by `commitment_count` lamports, so this is not a money problem. It is
a **runbook** problem: sweep once to get the proceeds, and once more at the end to close out.
Skip the second call and the remainder sits in the vault indefinitely.

**Economically the second sweep is not worth making at small scale.** It moved 1 lamport and
cost a 5,000-lamport transaction fee — the deployer's balance went *down* by 4,999. Do it for
completeness on a real launch only if `commitment_count` is in the thousands.

### 🔴 Claims are gated on the pool's `open_time`, not on `mark_pool_created`

### 🔴 Claims are gated on the pool's `open_time`, not on `mark_pool_created`

The first pass ran claims immediately after marking the pool and both were refused with
**`ClaimsNotOpen`** — claims wait for `pool_open_time` (07:29:26Z), which `06-create-pool.ts`
sets via `POOL_OPEN_IN`, default **2 hours**.

Operationally this matters for the real launch: **there is a mandatory gap between proving
the pool and the first claim**, equal to whatever `POOL_OPEN_IN` was set to. Plan the launch
runbook around it — bidders cannot claim the moment the pool is marked. It is a deliberate
anti-snipe property, but unannounced it reads as something broken.

### Settlement — the rest, all confirmed

| # | prediction | result |
|---|---|---|
| Q10 | accepted + refunded = 2,400,000,000 exactly | ✅ `total_accepted` closed at **1,989,999,999**, refunds 239,166,667 + 170,833,334 = 410,000,001 |
| Q12 | token vault ends at exactly **zero** | ✅ `vault holds 0 base units` |
| Q14 | float ≈ pool depth | ✅ **398,002,500 held vs 399,000,000 in the pool — 1:1.0025** |

**SOL vault ended at 890,880 lamports — exactly its rent reserve. No bidder principal
stranded, no proceeds stranded.** That is the assertion the 2026-08-09 session added to the
checklist, and it passes here.

Graded pool state, read from the live vaults rather than the seeded amounts:

```
pool reserves   399,000,000 graded / 2 quote
price           5.012531e-9 quote per token   (5.0125 lamports, vs 5 nominal)
LP supply       0 — burned
trading opens   2026-08-11T07:29:26Z
```

### `burn_unsold` is a no-op at these numbers, by construction

`tokens_i = floor(c_i·S/C)` summed to **exactly S** with two bidders, so there was nothing
left to burn (`NothingToBurn`, vault already at zero). `unsold_burned` therefore stays
`false` forever on this sale, which is correct and not a stuck flag.

This is a property of **oversubscription**: the pro-rata branch distributes the whole supply
by construction, so unsold tokens only exist in the undersubscribed case. Worth knowing
before someone reads `unsold burned: false` on a mainnet sale and assumes a step was missed.
