# The sale program — state of play

> ✅ **Feature-complete as of 2026-08-11. There is no "next slice."** Every instruction has
> run against a real validator and both the undersubscribed and oversubscribed pro-rata
> paths are proven on chain. Sections below that read as forward-looking briefs are
> **running history** — the live open items are under "Open decisions and known-imperfect
> items" at the end.

Updated 2026-08-08 (second session). Assumes zero context. Read this before touching the Rust.

---

## Where it lives and how to run it

The program is **in WSL**, not on the Windows side. Anchor on native Windows is a dead end
— it deletes your Solana install on every invocation. See
[TOOLCHAIN-2026-08-07.md](TOOLCHAIN-2026-08-07.md).

| | |
|---|---|
| Workspace | `~/antirugdex/sale` in distro `Ubuntu-24.04` |
| From Windows | `\\wsl$\Ubuntu-24.04\home\<user>\antirugdex\sale` — Read/Write/Edit work on this path |
| Toolchain | rustc 1.97.1 · solana-cli 3.1.10 · anchor-cli 1.1.2 · anchor-spl 1.1.2 (`token_2022`) |
| Program id | `51zNMfwD1ExHuWBPgT94jQfThaqBnnFbGMecH4AzfjWz` |

**Build and test — one command.** `cargo build-sbf` must run before `cargo test`, because the
integration tests `include_bytes!` the built `.so`; skip it and you test stale code.

```bash
wsl.exe -d Ubuntu-24.04 -- bash ~/antirugdex/sale/run-tests.sh
```

Call `wsl.exe` from **PowerShell**, not the Bash tool — Git Bash mangles `/home/...` into a
Windows path and rewrites arguments. Long shell one-liners also get corrupted through
`wsl.exe`; write a script with the Write tool and execute the file instead.

**The Rust half is under git as of 2026-08-08** — `git init` was run *in place* inside
`~/antirugdex/sale`, deliberately rather than copying the tree to Windows, so there is no
second copy to drift out of date. Initial commit `ee8e0eb`, 29 files. `git-bootstrap.sh` is
how it was made and is idempotent.

> ⚠️ **`target/` is gitignored, so `target/deploy/sale-keypair.json` is NOT protected by
> the repo.** That file is the program's on-chain identity and exists in exactly one place.
> Losing it means the deployed program can never be upgraded and the id in `declare_id!`
> becomes unusable. It needs a backup somewhere a secret belongs — not this repo.

Nothing syncs the Rust (WSL) and the TypeScript (Windows) halves; the Windows side is still
not under version control.

---

## What is built — 90 tests, all passing

**The program is feature-complete.** Every instruction the sale needs exists and is tested.
What remains is not more instructions: it is a TypeScript client, a devnet dress rehearsal
of the full sequence, and the four numbers.

| Instruction | Gate | Tests |
|---|---|---|
| `initialize_sale` | authority signs | 16 |
| `bid` | bidder signs | 10 |
| `finalize` | **permissionless** | 12 (shared file) |
| `fail_on_missing_pool` | **permissionless** | ↑ |
| `mark_pool_created` | **permissionless** | 14 |
| `claim` | bidder signs | 22 (shared file) |
| `refund` | **permissionless** | ↑ |
| `sweep_proceeds` | **permissionless** | 15 (shared file) |
| `burn_unsold` | **permissionless** | ↑ |

Source: `programs/sale/src/{constants,error,state}.rs` and `src/instructions/*.rs`.
Tests: `programs/sale/tests/`, with shared scaffolding in `tests/common/mod.rs`.

`--features devnet` swaps the hardcoded Raydium CPMM program id. Default is mainnet.

`build-only.sh` compiles without running tests — the SBF build is the slow part and the
first thing to break.

### Everything permissionless that can be

An authority-gated settle traps principal: if the only key that can act disappears, nobody
claims and nobody refunds. `finalize`, `fail_on_missing_pool`, `mark_pool_created` and
**`refund`** take no signer that gates the outcome — every fact they record is verified
from account data.

`refund` is permissionless for a sharper reason than the rest: **a bidder who committed
everything they had cannot afford the transaction that returns it.** Any wallet may push
someone else's refund; the lamports go to the bidder regardless of who paid the fee, and
the amount is a recorded number with a destination fixed by the PDA seeds, so there is
nothing to gain by pushing it.

`claim` is the one settlement instruction that requires the bidder's signature. Nothing
about that can strand anyone — an unclaimed `Commitment` stays claimable forever — and the
anti-bundle rules on it are about the bidder's own transaction.

### ✅ `claim` + `refund` — built and tested 2026-08-08

**Split into two instructions on purpose.** The design invariant is *"if the allocation
math were completely broken, could every bidder still recover their principal?"*, and the
cheapest way to make the answer yes is for the recovery path not to contain the allocation
math at all. `refund` has no mint, no token account, no token program, no CPI but a system
transfer, and no arithmetic beyond copying a recorded number. **It does not even write the
`Sale` account** — which also lets refunds run in parallel instead of queueing on one write
lock. A single `commitment.claimed` flag covers both, so a commitment settles exactly once
by exactly one route.

`refund` needs no `pool_created` check, and the trace is written into its docstring: a sale
reaches `Failed` only via a below-floor `finalize` or via `fail_on_missing_pool` (which
requires `!pool_created`), and `mark_pool_created` requires `Succeeded` — so `Failed`
implies `!pool_created`, and `claim` requires `pool_created`. No token can ever have been
claimed on a sale `refund` will act on.

Tests worth knowing about:

- **`a_bid_at_the_hard_cap_needs_u128_and_drains_the_vault_exactly`** — the u128 rule binds
  at the *configured* cap, not at absurd inputs: `c_i * D` at the 20 SOL cap with 9
  decimals is `2e19`, already past `u64::MAX`. It also drains the vault to the exact base
  unit, because the cap is sized at `floor(S * P / D)`.
- **`splitting_a_bid_across_wallets_settles_identically`** — the property the whole
  mechanism exists for. If it ever fails, bundling is profitable again.
- **`a_ragged_full_drain_leaves_dust_and_the_last_claim_still_lands`** — the failure mode
  that otherwise shows up only as *the last claimer's* transaction reverting. It asserts
  lamport dust is non-zero too, so the sweep-the-cap shortcut can never look safe.
- **`atomic_claim_and_dump_is_not_blocked_by_the_narrow_rule`** — named for what it proves,
  see below.

### 🔴 The anti-bundle rule is weaker than §6.3 implies — say so

`stack_height == TRANSACTION_LEVEL_STACK_HEIGHT` plus "no second top-level instruction
targeting this program" **does not stop `[claim, raydium_swap]` in one transaction.** Both
instructions sit at stack height 1 and the swap targets Raydium, not us. Atomic
claim-and-dump by the bidder themselves is not preventable here.

What the narrow rule does buy: no program can CPI-wrap `claim`, and no transaction can
batch claims. §6.3 chose narrow deliberately — the broader rule needs a hardcoded bypass
whitelist (Meteora's shape). The gap is in the docstring and in a test name, not hidden.

The instructions sysvar is parsed **by hand**, not through `load_instruction_at_checked`
(which anchor-lang 1.1.2 does not re-export anyway): that function allocates a full
`Instruction` per call, and the BPF bump allocator never frees, so a transaction with many
instructions could exhaust the 32 KB heap inside the loop. The manual walk allocates
nothing and reads only program ids. Layout is documented at the call site.

### `Claim`'s accounts are `Box`ed — do not un-box them

Unboxed, the generated `try_accounts` overflows the 4 KB SBF stack frame by 8 bytes. The
toolchain reports that as a **warning while still emitting a binary**, and the consequence
is undefined behaviour at runtime rather than a failed build.

---

## 🔴 Invariants a new slice can silently break

**1. `pool_created` — both halves required.**
`fail_on_missing_pool` flips to `Failed` only while `!pool_created`; **`claim` MUST
`require!(sale.pool_created)`**. Mutually exclusive, so a sale can never flip to `Failed`
after anyone claimed tokens. Drop half two and the abandonment path becomes a way for early
claimers to keep tokens while everyone else refunds. Documented on the field in `state.rs`.

**2. `claim` MUST `require!(now >= sale.pool_open_time)`.**
Claims opening only after trading is live is what keeps circulating float at zero when the
pool goes live — nobody holds tokens to dump into a deliberately-high opening price.
Reverse the order and opening high builds a sell-side snipe instead of preventing a
buy-side one. `mark_pool_created` **copies** `open_time` without sanity-checking it, so a
pool already trading would pass; enforcing sanity is `claim`'s job.

**3. Every limit must be able to bind.** Two near-misses so far: `absolute_deadline ==
close_ts` made the activity extension arithmetically inert, and `floor == 0` made
cancel-and-refund dead *and* let a zero-raise sale succeed. Both are now rejected at
initialize with their own tests. Before adding any cap, derive whether it can ever bind.

**4. Arithmetic, no exceptions.** Floor division always. u128 intermediates.
`u64::try_from(..)?` — never `as u64`, which truncates silently and is *not* caught by
`overflow-checks`. Invariants read **recorded state**, never lamport balances, because
outsiders can donate to any address.

**5. The sweep moves a recorded bound, never `hard_cap_lamports` and never the vault's
balance.** Oversubscribed, `accepted_i = floor(c_i * cap / C)` and flooring loses up to one
lamport per bidder, so the retained sum lands *below* the cap. Sweeping the cap leaves the
last refunder's transaction short — the documented token failure mode transposed onto
principal.

*Amended after building it:* the amount is **not** `total_accepted_lamports`, because that
is zero at the moment the sweep first has to run. It is
`max(cap - commitment_count, total_accepted_lamports)` — see `sweepable_ceiling`. The rule
"move recorded amounts, never a balance" is unchanged; only the identity of the amount was
wrong.

**6. 🔴 `sweep_proceeds` must `require!(sale.pool_created)`.** Without it: sweep empties the
vault, the pool never appears, `fail_on_missing_pool` flips the sale to `Failed`, and every
refund fails on `VaultBelowRentReserve`. Total, permanent loss of principal, caused by the
recovery path. This is invariant 1 applied to a third instruction — `Failed` implies
`!pool_created`, so the gate keeps the vault solvent for as long as refunds are possible.
**Consequence: the pool seed cannot come from the raise.** The builder fronts it and sweeps
to reimburse.

---

## ✅ Deployed to devnet — 2026-08-08

| | |
|---|---|
| Program | `51zNMfwD1ExHuWBPgT94jQfThaqBnnFbGMecH4AzfjWz` |
| ProgramData | `DjYTxKCbFdxdmrJFZAW76Z959D4g5vn8mCPGX1ysT6jG` |
| Upgrade authority | `A9h5uLS658uH5x2Nfk9F8LiSGEz89HozCpuHpnCCxrAb` (devnet deployer) |
| Size | 357,992 bytes, `Executable: true` |
| Cost | 2.49 SOL of 9.67; **no stranded buffers** |
| Built with | **`--features devnet`** via `anchor-build-devnet.sh` |

Deploy with `deploy-devnet.sh`. `check-deploy-keys.sh` and `devnet-preflight.sh` are
read-only and answer "would this work" before anything is spent.

**The IDL was stale and nobody would have noticed.** `cargo build-sbf` — which `run-tests.sh`
uses — does **not** emit an IDL. `target/idl/sale.json` was still the 2,841-byte Anchor
counter-template scaffold from 2026-08-07, describing an `initialize` instruction that does
not exist. Only `anchor build` regenerates it. It is now 41,266 bytes with all nine
instructions and a `Sale` layout matching the code. **Re-run `anchor-build-devnet.sh` after
any state or instruction change, or the client silently builds against a fiction.**

That also closes B0's open question: `anchor build` does emit an IDL, spec `0.1.0` — the
Anchor 0.30+ format `trident-idl-spec` reads.

### ⚠️ On-chain IDL upload does not work — parked, not solved

`anchor idl init` and even `anchor idl fetch` fail with a bare
`No such file or directory (os error 2)`. Optional: the TypeScript client reads
`target/idl/sale.json` directly, and only block explorers want the on-chain copy.
`fix-idl-upload.sh` is the reproduction and lists everything ruled out — a missing default
wallet, the Windows `solana.exe`, missing CLI config, workspace-relative paths, and any
subprocess at all (the backtrace lands inside `anchor_cli::idl`). Leading hypothesis:
anchor 1.x moved to the "program metadata" standard and `idl init` is the wrong verb.

### 🔴 Two WSL traps this exposed, both of which cost a deploy attempt

**Anchor's child processes can resolve to the WINDOWS `solana.exe`.** WSL inherits the
Windows PATH and `anchor` rewrites PATH for what it spawns (TOOLCHAIN trap 2). A child ran
under `CMD.EXE`, which cannot `cd` to a UNC path and cannot read `/mnt/c` keypairs —
surfacing as `UNC paths are not supported` and `Keypair file not found` **for a file that
demonstrably exists**. Every script here now exports a PATH with no `/mnt/c` entries.

**There was no solana CLI config or default keypair in WSL at all.** `solana program show`
fails without one even though it only reads. Both now exist; the default keypair is a
throwaway placeholder that never signs.

---

## The next slice: a TypeScript client and a devnet dress rehearsal

No instructions remain, and the program is on devnet. The gap between "90 tests pass" and
"a stranger's SOL is safe" is that every test drives the program through LiteSVM with
hand-injected accounts — no client exists, and nothing has been driven end to end.

1. **A TypeScript client** in the Windows tree, reusing the existing `.env` cluster
   switching. It needs `target/idl/sale.json`, reachable from Windows at
   `\\wsl$\Ubuntu-24.04\home\<user>\antirugdex\sale\target\idl\sale.json`. Note `claim` needs
   the instructions sysvar **and** the `jitodontfront` marker in its account list, and a
   tight `SetComputeUnitLimit` is expected client-side.
2. **The full sequence on devnet against the real ARD mint** — initialize, several bids from
   several wallets, finalize, create + seed + burn a real CPMM pool, mark it, sweep, wait
   for `open_time`, claim, burn the remainder. **Remember the pool seed comes from the
   builder, not the raise** (invariant 6). Then a second run that deliberately misses the
   floor and refunds everyone, which GAMEPLAN §5 calls the product demo.
3. **Sec3 X-Ray and Trident**, per §6.6. Trident's parser question is now answerable — point
   `trident init` at the real generated IDL.

---

## Reference — `claim`'s arithmetic, as built

`C = total_committed`, `S = supply_for_sale`, `P = price_lamports` (per **whole** token),
`D = 10^decimals`, `cap = hard_cap_lamports`, `c_i = commitment.amount`.

**Undersubscribed — `C <= cap`:** everyone fills at the fixed price, no refunds.
```
tokens_i  = floor(c_i * D / P)
refund_i  = 0
```

**Oversubscribed — `C > cap`:** pro-rata on both sides.
```
tokens_i   = floor(c_i * S / C)          <- GAMEPLAN §6.4, the canonical formula
accepted_i = floor(c_i * cap / C)
refund_i   = c_i - accepted_i
```

**Failed:** `tokens_i = 0`, `refund_i = c_i`.

Then, the one with no backstop but Token-2022 itself:
```
assert sale.total_claimed_tokens + tokens_i <= S
```
Sub-additive flooring already proves this whenever `total_committed` really is the sum of
the commitments, so the assert **cannot fire on the allocation formula alone** — it
backstops the other bug class, a `total_committed` that has drifted from what it summarises.
Without it, the only remaining backstop is Token-2022, which surfaces as **the last
claimer's transaction failing**. `a_ragged_full_drain_leaves_dust_and_the_last_claim_still_lands`
is the test; what it actually proves is that the sum lands at or just under `S` with dust
left behind and the final claim still goes through.

`initialize_sale` already guarantees `cap <= floor(S * P / D)`, so the undersubscribed
branch can never pay out more than the vault holds.

### Token movement

The vault's owner is the **sale PDA**, so the transfer out is a `transfer_checked` CPI
(`anchor_spl::token_2022::transfer_checked`) signed with the sale's seeds. Refunds move
lamports out of the system-owned `sol_vault` PDA, signed with `SOL_VAULT_SEED` +
`sale.sol_vault_bump`, with an explicit floor check against the rent reserve.

**The claimer receives less than `tokens_i`, and every UI must quote the net number.** The
0.25% fee applies to the claim transfer like any other. Exact bookkeeping below.

Any non-zero transfer fee blocks `CloseAccount` forever for every holder
(`AccountHasWithheldTransferFees`). Ship a harvest-then-close flow; harvest is
permissionless so holders self-serve.

### 🔴 Token-2022 fee bookkeeping — measured, and the old note here was wrong

Measured against the live program on 2026-08-08 by transferring 5e16 base units out of the
vault at 25 bps:

| | |
|---|---|
| source `base.amount` | debited the full **5e16** (the gross) |
| destination `base.amount` | credited **4.9875e16** (the net) |
| destination `withheld_amount` | **1.25e14** (the fee) |

The last two sum to the gross, so **withheld sits alongside `amount`, not inside it.**
`base.amount` is already net of the fee, and the spendable balance is `base.amount` on its
own — nothing should be subtracted from it. Pinned by
`the_transfer_fee_is_taken_out_of_the_claim_itself`, which asserts the conservation
identity directly.

Every earlier statement of the form *"spendable = amount minus withheld"* in this repo was
wrong, including the one in `vault_spendable_amount`. See the open items below for why the
code was deliberately left alone.

### The design invariant to test against

> **If the allocation math were completely broken, could every bidder still recover their
> principal?**

Yes — `refund` is a separate instruction containing none of it.

### Degenerate cases (§6.5) — all covered

Allocation flooring to **zero** (a contrived ten-base-unit supply; unreachable at realistic
parameters); a **full vault drain with ragged bid sizes**; exactly **one** bidder; **repeat**
bids from one wallet; a `Failed` sale returning **exactly** `c_i` to the lamport; double
claim and double refund both rejected. CEX-address bidders can never claim — a disclosure
problem, not a code one.

---

## Property testing — `test_invariants.rs`, added 2026-08-09

Random instruction sequences with **every invariant re-checked after every step**. 120
sequences × 24 steps ≈ 2,900 transactions, ~45s. Run it alone with
`bash sale/run-invariants.sh`; `run-tests.sh` picks it up too.

**Why it exists.** The stranded-fee bug reached devnet through 90 passing tests. None was
wrong — they asserted transfers and recorded state, and the bug was in what was *left over*.
Nobody looks at leftovers until it is named as an invariant.

**Why not Trident**, as GAMEPLAN §6 specced: it requires `solana-sdk ^2.3`, and this
workspace is Anchor 1.1.2 on Solana 3.x with **no `solana-sdk` at all** — the granular
`solana-*-interface` crates replaced it. Adding Trident means a parallel, incompatible crate
tree. Its last non-RC release is 0.12.0 (2025-11-27) and no release notes mention Anchor 1.x.
The technique does not need the tool.

**Sec3 X-Ray was assessed and skipped.** Latest release v0.0.6 is from 2024-09-18; its
detectors target Anchor 0.2x/0.3x patterns — missing signer/owner checks, unvalidated
accounts — which Anchor 1.x's types and this program's explicit constraints already cover.
Its documented installer is `sh -c "$(curl -k …)"`, piping a remote script into a shell with
**TLS verification off**; the GitHub release is the same tool from a verifiable source if it
is ever revisited.

### The invariants

| | |
|---|---|
| **SOL conservation** | `vault == rent + committed − swept − refunded`, checking *recorded* state against the *actual* balance |
| **Refund solvency** | on `Failed`, the vault covers every unsettled bidder in full, simultaneously, without touching rent |
| **`Failed ⟹ swept == 0`** | the safety argument as a theorem — see below |
| **Token conservation** | vault equals init minus claimed, or minus `supply_for_sale` once burned |
| **Withheld never moves** | no instruction may touch fees owed to the withdraw-withheld authority |
| **Bounds** | `accepted ≤ cap`, `claimed ≤ supply`, `claim_count ≤ commitment_count`, `swept ≤ ceiling` |
| **Pro-rata adds up** | `accepted + refunded == committed` across settled commitments — the only place the split is checked against its inputs, since `accepted_i` is never stored per commitment |
| **Status monotonicity** | never back to `Bidding`; `Failed` is terminal. `Succeeded → Failed` **is** legal (`fail_on_missing_pool` accepts both) |

### 🔴 Two findings about testing itself

**1. A green property run proved nothing at first.** The first version reached **0 claims in
120 sequences** — `pool_open_time` was set to `pool_deadline`, but `mark_pool_created`
requires `now < pool_deadline` while `claim` requires `now >= pool_open_time`, leaving a
window of zero. The suite was green and hollow. **Coverage counters are now printed and
assert-floored**, so vacuity fails the build instead of passing it quietly.

**2. Deleting the `pool_created` gate on `sweep_proceeds` did not fail the suite.** That is
the hole documented above as destroying every bidder's principal. It survived because no
sequence reached the one state that exposes it — `Failed` *after* a sweep — since a single
generous `pool_deadline` made `fail_on_missing_pool` unreachable. Fixed by coin-flipping the
deadline between a **tight** regime (abandonment path live) and a **generous** one (pool,
claims, sweeps live). The same mutation now fails in seconds:

```
seed 11369083830282, step 18: INSOLVENT — vault 7775261366
but 13288298457 owed to unsettled bidders plus 890880 rent
```

**Both mutations were run deliberately and reverted.** A property test nobody has ever seen
fail is a property test nobody should trust.

`Failed AFTER a sweep` is reported as an **anti-metric and must read 0** — with the gate in
place that state is unreachable by construction, and non-zero is the alarm.

---

## Test-harness traps that cost real time

**An empty log array (`[]`) means the transaction never executed** — a pre-execution
rejection, not a program error. Seen twice: an unset `recent_blockhash`, and two identical
transactions (same payer, same amount, same blockhash) colliding on signature and being
dropped as duplicates. `common/mod.rs` calls `expire_blockhash()` before every send.

**`warp_to_slot` does not move `unix_timestamp`.** Use `set_clock` (writes the Clock sysvar).

**Never assert a disjunction of two possible errors.** It passes whichever fires and would
keep passing if one guard were deleted. Assert the exact error; if it is wrong, the log
tells you. Corrected twice already — including a case where the predicted error was wrong
and the log was right.

**Prefer `set_account` injection over arranging state through CPIs**, and build Token-2022
images through `PodStateWithExtensionsMut`, not hand-written byte offsets.

**`anchor deploy` exits 1 on a SUCCESSFUL upgrade.** Its IDL-upload step runs a child under
CMD.EXE, which cannot handle the UNC path and reports `Keypair file not found` for a file
that demonstrably exists — *after* the upgrade transaction has already confirmed. The exit
code and the log therefore cannot answer "did the deploy land". The bytes can:
**`verify-deploy.sh`** dumps the on-chain program and compares its sha256 against
`target/deploy/sale.so` (trimming the zero padding `solana program dump` adds). Run it after
every deploy instead of reading the exit code. Confirmed matching on 2026-08-09.

**`npm run sync-idl` was silently broken under PowerShell.** It was an inline `node -e` with
a quadruple-escaped UNC path that collapsed to `C:\wsl$\...` — ENOENT for a path nobody
wrote, on the one step whose job is to stop the client running against a stale IDL. It is
now `src/_sync-idl.ts`: a file has no escaping layers to rot, and it prints the instruction
list plus a scaffold check after copying.

**🔴 The embedded `.so` and the test crate must agree on FEATURES, not just be fresh.** The
tests `include_bytes!` `target/deploy/sale.so` while compiling `sale::constants::*`
themselves. Run `anchor-build-devnet.sh`, then run tests without rebuilding, and the
embedded program checks the **devnet** Raydium id while the tests construct pools owned by
the **mainnet** one. It surfaces as ~15 failures across `test_claim` and
`test_mark_pool_created` that mention nothing about features and look like a real
regression. Both `run-tests.sh` and `count-tests.sh` now `cargo build-sbf` first.
**The converse bites too: running the tests clobbers the devnet artifact — re-run
`anchor-build-devnet.sh` before any devnet deploy.**

---

## Raydium facts, read off the live devnet pool — not from docs

Pool `6zKJcfzmYCFY5qnC71q4nEwqTcPEiwzKWi4qAcTrXRCs`, decoded 2026-08-08.

**`PoolState.lp_supply` is STALE after a burn.** It reads `315832233947` while the LP
mint's actual supply is **0**. `require!(pool.lp_supply == 0)` would reject our own
correctly-burned pool. Read the **LP mint's** `supply`, cross-checked against
`PoolState.lp_mint`.

**Devnet CPMM program: `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb`** (the pool's `owner`
field — ground truth). **Mainnet `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` is now
VERIFIED the same way** — read off live mainnet pool
`H1Kvn7XW1qh9BP9kKo2KZqz8Q6ZcppsJCsUDxJEvntav` on 2026-08-08 with
`tools/verify-mainnet-cpmm.py`, which finds a pool by sampling recent transactions of the
claimed program rather than trusting the docs. That pool is 637 bytes with the same
discriminator, so the wire format below holds on mainnet too.

**To verify the mainnet id — the outstanding pre-launch task:** point
`sale/tools/decode-pool.py` at a live mainnet CPMM pool (change `RPC` and `POOL`) and read
back the `owner` field. That script is how every fact in this section was established.
`sale/tools/decode-pool-offsets.py` prints the byte offset of every field, which is what
the constants in `constants.rs` have to trace back to. `sale/tools/find-marker.py` derives
the `jitodontfront` marker key.

**Anyone can create a CPMM pool for your mint pair** — pools are keyed per `amm_config`, so
more than one can exist. Owner, discriminator, mint match and a zero LP supply are all
satisfied by a stranger's dust pool. `mark_pool_created` therefore also requires
`pool_creator == sale.authority` (offset **40**, confirmed against the live pool with
`tools/decode-pool-offsets.py`) and `open_time <= pool_deadline`.

Without those two, a third party could point a dust pool with `open_time` ten years out at
the sale, set `pool_created` permanently — which blocks `fail_on_missing_pool` forever —
and freeze every bidder's principal for the price of a pool. The milder variant is a shill
pool with `open_time` in the past, which opens claims before the real pool exists. Both are
tested.

**Wire format:** discriminator `f7ede3f5d7c3de46`, length **637**. Ten `Pubkey`
(`amm_config`, `pool_creator`, `token_0_vault`, `token_1_vault`, `lp_mint`, `token_0_mint`,
`token_1_mint`, `token_0_program`, `token_1_program`, `observation_key`), five `u8`
(`auth_bump`, `status`, `lp_mint_decimals`, `mint_0_decimals`, `mint_1_decimals`), seven
`u64` (`lp_supply`, four fee fields, `open_time`, `recent_epoch`). Offsets in `constants.rs`.

**Our pool sorts ARD as `token_1_mint`, WSOL as `token_0_mint`.** Compare both fields;
never assume a position. Assuming it inverted a price by nine orders of magnitude.

---

## Open decisions and known-imperfect items

- **✅ A2, the four numbers — chosen and validated on devnet 2026-08-11.** 5 lamports /
  1.99 SOL cap / 0.8 SOL floor / 0.02 SOL min bid, proven oversubscribed at 120.6%. See
  [RESULTS-launch-numbers.md](RESULTS-launch-numbers.md). This entry used to say the numbers
  were "the only thing between here and a mainnet sale". They were not — see the next item.
- **🔴 THE PROGRAM IS NOT ON MAINNET, AND NO DOCUMENT SAID TO PUT IT THERE.** Confirmed
  2026-08-11 by `getAccountInfo` for `51zNMfwD…` against mainnet: no account. The launch
  runbook went preflight → mint → lock → `11-sale-init.ts`, which calls it. Two constraints
  make this more than running the deploy script:
  - **Build WITHOUT `--features devnet`.** That feature swaps in the *devnet* Raydium CPMM
    id, so a devnet binary on mainnet rejects the real pool in `mark_pool_created` — failing
    at launch step 9, after the seed is committed and with bidders' SOL in the vault.
    `anchor-build-devnet.sh` is the devnet path; the default build is the mainnet one.
  - **Deploy with the same `target/deploy/sale-keypair.json`**, or `declare_id!` and the id
    the TypeScript client reads out of the IDL stop matching. That file is gitignored and
    exists in exactly one place — the backup warning at the top of this document is not
    theoretical, it is now load-bearing for a mainnet launch.

  It costs **~2.5 SOL of rent** (357,992 bytes; the devnet deploy cost 2.49), which was
  missing from every funding figure written down for this project.
  `CLUSTER=mainnet npx tsx src/00-preflight.ts` now fails if the program is absent.
- **✅ `fail_on_missing_pool` — run against a validator 2026-08-11.** It was the last
  instruction never driven on chain, and the reason was simply that **no client script
  existed**; `src/19-fail-pool.ts` now does. Mint `7wPiht7N…`, sale `4jhR7AaW…`: bid →
  finalize → Succeeded → deadline lapsed → Failed → full refund, ten predictions registered
  in advance and all matched to the lamport. The vault finished at 890,880 lamports, exactly
  its rent reserve. See [RESULTS-fail-on-missing-pool.md](RESULTS-fail-on-missing-pool.md).
- **Three Phase 0 checks beyond §6.1** stay unless vetoed: the mint is rejected for a
  permanent delegate, a transfer hook, or a mint close authority. A permanent delegate can
  move tokens out of any account for that mint, the vault included, which would make the
  vault checks vacuous.
- **✅ `vault_spendable_amount` stranded one fee per launch — FIXED 2026-08-09, in source.**
  It computed `amount - withheld`, and `amount` is already net, so the fee came off twice.
  Safe for *principal* — it could only demand a better-funded vault — but the over-funding
  never came back. The devnet rehearsal funded 200,000,000 ARD, declared
  `supply_for_sale = 199,000,000`, and finished with **500,000 ARD in the token vault that
  nothing can move**: `burn_unsold` burns `supply_for_sale - total_claimed_tokens` (a
  recorded figure, not the balance), it burned 1 base unit, and `unsold_burned` is one-shot.
  Structural — always one transfer fee of whatever is funded, 0.25% at the current rate.
  The funding script was never at fault: line 101 requires
  `vault_spendable_amount(vault) >= supply_for_sale`, so declaring the true `amount` was
  rejected with `VaultUnderfunded`.
  **What changed:** the helper now returns `state.base.amount`. The extension is still
  unpacked — that is what proves the account is well-formed Token-2022 — but nothing is
  subtracted. `withheld_fees_do_not_count_as_supply` was renamed
  **`withheld_fees_are_not_part_of_amount`** and now runs on the realistic fixture
  (`amount = SUPPLY`, `withheld` beside it), asserting the boundary at `SUPPLY + 1` as well
  as the gross. The fixture default in `common/mod.rs` changed from `VAULT_AMOUNT` to
  `SUPPLY` for the same reason: the old shape put withheld *inside* `amount`, which the live
  token program cannot produce.
  **New test `nothing_is_stranded_in_the_vault_after_the_burn`** asserts `token_balance == 0`
  and `token_withheld == WITHHELD` once every bidder has claimed and the burn has run.
  Verified to be a real regression catch, not a tautology: restoring the old formula *and*
  the old fixture makes it fail with `left: 500000000000000` — the exact figure stranded on
  devnet. **91 tests passing, 0 failed.**
  Option (b) from the original write-up — have `burn_unsold` burn the vault's actual balance
  — was **not** taken. It is a backstop for accidental over-funding rather than a fix for
  this cause, and the new test pins the invariant it would enforce. Still available if
  over-funding turns out to happen for other reasons.
  > ✅ **Deployed to devnet 2026-08-09** and verified end to end on a second mint
  > (`4wY2cFxa…`, sale `8ykdmsH2…`). `initialize_sale` accepted
  > `supply_for_sale = 24,937,500` — the vault's full `base.amount` — which the old binary
  > would have rejected with `VaultUnderfunded`. `11-sale-init.ts` was corrected in the same
  > pass; it mirrored the same double subtraction.

  See [RESULTS-2026-08-09.md](RESULTS-2026-08-09.md).
- **`sale.claim_count` counts claims only.** `refund` deliberately does not write the
  `Sale` account, so it does not appear there.
- **`burn_unsold` may never become callable.** It needs `claim_count == commitment_count`,
  and one lost-key or CEX-address bidder blocks it forever. Accepted: unsold tokens are
  nobody's principal, so the cost is cosmetic circulating supply, not funds.
- **Oversubscribed sweeps leave up to `commitment_count` lamports in the vault** if not
  every bidder claims — a few hundred lamports, unreachable. Accepted.
- **~~Nothing has run against a real validator.~~ Closed 2026-08-09.** A full sale ran end
  to end on devnet — `initialize_sale`, `bid` ×2, `finalize`, `mark_pool_created`,
  `sweep_proceeds` ×2, `claim` ×2, `burn_unsold` — and every settlement figure predicted
  before the run matched chain to the base unit and the lamport.
  [RESULTS-2026-08-09.md](RESULTS-2026-08-09.md) has the numbers and the transactions.
  ~~`refund` is now the only instruction never exercised against a validator.~~
  **Closed too — `refund` ran 2026-08-09** on a second mint (`4wY2cFxa…`) taken below its
  floor, and `fail_on_missing_pool` ran 2026-08-11 on a third (`7wPiht7N…`).
  **As of 2026-08-11 every instruction in the program has run against a real validator, and
  both the undersubscribed and oversubscribed pro-rata paths are proven on chain.**
  One Sale PDA per mint, forever, which is why each needed its own mint.
