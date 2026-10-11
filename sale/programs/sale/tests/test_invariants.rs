//! Property testing — random instruction sequences, invariants checked after **every** step.
//!
//! # Why this file exists
//!
//! On 2026-08-09 a bug reached devnet through 90 passing tests. Not one of them was wrong;
//! they asserted transfers and recorded state, and the bug was in neither. It was in what
//! was *left over* — one transfer fee's worth of tokens stranded in a vault nothing could
//! reach. No single-purpose test looked, because looking at the leftovers is nobody's job
//! until you name it as an invariant.
//!
//! GAMEPLAN §6 specced Trident for this. Trident requires `solana-sdk ^2.3`; this workspace
//! is Anchor 1.1.2 on Solana 3.x and contains no `solana-sdk` at all, so it cannot be added
//! without dragging in a parallel, incompatible crate tree. The *technique* does not need
//! the tool: drive random legal-and-illegal instruction sequences through LiteSVM and assert
//! the invariants after each one. Errors are expected and ignored — a rejected instruction
//! is a valid outcome, and the point is that the state is sound either way.
//!
//! # Determinism is the whole design
//!
//! Every sequence is driven by a seeded SplitMix64 written inline — no `rand` dependency in
//! custody-adjacent test code, and more importantly, a failure prints a seed and a step
//! index that reproduce it exactly. An unreproducible property failure is worse than no
//! test: it trains you to re-run until green.
//!
//! # What this cannot do
//!
//! It is random, not coverage-guided. It will not find a bug behind a needle-in-a-haystack
//! input the way a real fuzzer would, and passing here is not proof. It is a wide, cheap net
//! over the state machine, and it is the net that would have caught this morning's bug on
//! the first run.

mod common;

use common::*;

use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;

// ---------------------------------------------------------------------------
// Deterministic PRNG — SplitMix64
// ---------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform-ish in `[0, n)`. The modulo bias is irrelevant at these magnitudes.
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next_u64() % n }
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo { lo } else { lo + self.below(hi - lo) }
    }
}

const SOL: u64 = 1_000_000_000;
const SEQUENCES: u64 = 120;
const STEPS: usize = 24;
const BIDDERS: usize = 4;

// ---------------------------------------------------------------------------
// The invariants
// ---------------------------------------------------------------------------

/// Everything that must hold after every instruction, legal or rejected.
///
/// `rent_reserve` and `vault_tokens_at_init` are captured once, immediately after
/// `initialize_sale`, so the assertions compare against measured starting state rather than
/// against constants that could drift.
struct World {
    rent_reserve: u64,
    vault_tokens_at_init: u64,
    withheld_at_init: u64,
    bidders: Vec<Keypair>,
    /// Status is not allowed to walk backwards. `Succeeded -> Failed` IS legal —
    /// `fail_on_missing_pool` accepts `Bidding || Succeeded` — so the rule is narrower than
    /// "never changes after settling": never back to `Bidding`, and `Failed` is terminal.
    saw_failed: bool,
    saw_settled: bool,
}

fn check(ctx: &Ctx, w: &mut World, seed: u64, step: usize) {
    let s = read_sale(ctx);
    let ctxt = format!("seed {seed}, step {step}");

    // --- status monotonicity ------------------------------------------------
    let status = format!("{:?}", s.status);
    if status == "Bidding" {
        assert!(!w.saw_settled, "{ctxt}: status returned to Bidding after settling");
    } else {
        w.saw_settled = true;
    }
    if w.saw_failed {
        assert_eq!(status, "Failed", "{ctxt}: Failed must be terminal");
    }
    if status == "Failed" {
        w.saw_failed = true;
        // The documented invariant that makes `refund` safe without a pool check, and makes
        // `fail_on_missing_pool` incapable of double-paying: a Failed sale can never have
        // had a pool proven, so no token can ever have been claimed on it.
        assert!(!s.pool_created, "{ctxt}: Failed sale has pool_created set");
        assert_eq!(s.total_claimed_tokens, 0, "{ctxt}: Failed sale claimed tokens");
        // The safety argument stated as a theorem rather than a hope. `sweep_proceeds`
        // requires `pool_created`; `mark_pool_created` requires `Succeeded`; and a sale
        // becomes `Failed` only via a below-floor finalize or `fail_on_missing_pool`, which
        // itself requires `!pool_created`. Therefore no `Failed` sale can ever have had
        // lamports swept out of it — and if that ever becomes false, every unsettled bidder's
        // principal is at risk. Deleting the sweep gate makes this fire.
        assert_eq!(
            s.total_swept_lamports, 0,
            "{ctxt}: a Failed sale has had {} lamports swept — bidder principal is now \
             unrecoverable",
            s.total_swept_lamports,
        );
    }

    // --- I1: SOL conservation ----------------------------------------------
    // Every lamport in the vault came from a bid or the rent seed, and leaves only by a
    // sweep or a settlement. Cross-checks RECORDED state against the ACTUAL balance, which
    // is the direction that catches bookkeeping drift.
    let refunded: u64 = w
        .bidders
        .iter()
        .map(|b| commitment_refunded(ctx, &b.pubkey()))
        .sum();
    let expected_vault = w.rent_reserve + s.total_committed - s.total_swept_lamports - refunded;
    assert_eq!(
        sol_vault_balance(ctx),
        expected_vault,
        "{ctxt}: SOL conservation — vault {} but rent {} + committed {} - swept {} - refunded {} = {}",
        sol_vault_balance(ctx),
        w.rent_reserve,
        s.total_committed,
        s.total_swept_lamports,
        refunded,
        expected_vault,
    );

    // --- I2: refund solvency — THE design invariant -------------------------
    // "If the allocation math were completely broken, could every bidder still recover their
    // principal?" On a Failed sale every unsettled bidder must still be payable in full,
    // simultaneously, without touching the rent reserve. This is the property the
    // `pool_created` gate on `sweep_proceeds` exists to protect.
    if status == "Failed" {
        let owed: u64 = w
            .bidders
            .iter()
            .filter(|b| !commitment_settled(ctx, &b.pubkey()))
            .map(|b| commitment_amount(ctx, &b.pubkey()))
            .sum();
        assert!(
            sol_vault_balance(ctx) >= owed + w.rent_reserve,
            "{ctxt}: INSOLVENT — vault {} but {} owed to unsettled bidders plus {} rent",
            sol_vault_balance(ctx),
            owed,
            w.rent_reserve,
        );
    }

    // --- I3: token conservation, including the leftovers --------------------
    // The invariant this file was written for. Stated generally: `supply_for_sale` may be
    // declared BELOW the vault's balance (`initialize_sale` requires `>=`, not `==`), and
    // then the difference is stranded by construction. This harness always declares the full
    // amount — the only sane operator choice — so post-burn the vault must reach exactly 0.
    let vault_now = token_balance(ctx, &ctx.vault);
    let expected_tokens = if s.unsold_burned {
        w.vault_tokens_at_init - s.supply_for_sale
    } else {
        w.vault_tokens_at_init - s.total_claimed_tokens
    };
    assert_eq!(
        vault_now, expected_tokens,
        "{ctxt}: token conservation — vault {vault_now}, expected {expected_tokens} \
         (init {}, claimed {}, burned {})",
        w.vault_tokens_at_init, s.total_claimed_tokens, s.unsold_burned,
    );

    // No instruction may touch withheld fees: they are owed to the mint's
    // withdraw-withheld authority and only `harvest` moves them.
    assert_eq!(
        token_withheld(ctx, &ctx.vault),
        w.withheld_at_init,
        "{ctxt}: withheld fees changed",
    );

    // --- I4: the bounds that keep payouts fundable --------------------------
    assert!(
        s.total_accepted_lamports <= s.hard_cap_lamports,
        "{ctxt}: accepted {} exceeds cap {}",
        s.total_accepted_lamports,
        s.hard_cap_lamports,
    );
    assert!(
        s.total_claimed_tokens <= s.supply_for_sale,
        "{ctxt}: claimed {} exceeds supply {}",
        s.total_claimed_tokens,
        s.supply_for_sale,
    );
    assert!(
        s.claim_count <= s.commitment_count,
        "{ctxt}: claim_count {} exceeds commitment_count {}",
        s.claim_count,
        s.commitment_count,
    );

    // --- I5: the sweep never exceeds its own ceiling ------------------------
    let ceiling = if s.total_committed <= s.hard_cap_lamports {
        s.total_committed
    } else {
        s.hard_cap_lamports
            .saturating_sub(s.commitment_count)
            .max(s.total_accepted_lamports)
    };
    assert!(
        s.total_swept_lamports <= ceiling,
        "{ctxt}: swept {} above ceiling {}",
        s.total_swept_lamports,
        ceiling,
    );

    // --- I6: the pro-rata split adds up ------------------------------------
    // `accepted_i` is only ever aggregated into `total_accepted_lamports`, never stored per
    // commitment, so this is the one place the split is checked against its own inputs:
    // for every settled commitment on a Succeeded sale, accepted + refunded == committed.
    if status == "Succeeded" {
        let settled: Vec<_> = w
            .bidders
            .iter()
            .filter(|b| commitment_settled(ctx, &b.pubkey()))
            .collect();
        let committed_by_settled: u64 = settled
            .iter()
            .map(|b| commitment_amount(ctx, &b.pubkey()))
            .sum();
        let refunded_by_settled: u64 = settled
            .iter()
            .map(|b| commitment_refunded(ctx, &b.pubkey()))
            .sum();
        assert_eq!(
            s.total_accepted_lamports + refunded_by_settled,
            committed_by_settled,
            "{ctxt}: accepted {} + refunded {} != committed {} across settled commitments",
            s.total_accepted_lamports,
            refunded_by_settled,
            committed_by_settled,
        );
    }
}

// --- small readers that tolerate a commitment not existing yet --------------

fn commitment_exists(ctx: &Ctx, bidder: &Pubkey) -> bool {
    let (pda, _) = commit_pda(&ctx.sale_key, bidder);
    ctx.svm.get_account(&pda).map(|a| !a.data.is_empty()).unwrap_or(false)
}
fn commitment_amount(ctx: &Ctx, bidder: &Pubkey) -> u64 {
    if commitment_exists(ctx, bidder) { read_commitment(ctx, bidder).amount } else { 0 }
}
fn commitment_refunded(ctx: &Ctx, bidder: &Pubkey) -> u64 {
    if commitment_exists(ctx, bidder) { read_commitment(ctx, bidder).lamports_refunded } else { 0 }
}
fn commitment_settled(ctx: &Ctx, bidder: &Pubkey) -> bool {
    commitment_exists(ctx, bidder) && read_commitment(ctx, bidder).claimed
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/// Random *legal-looking* parameters. Only the shapes `initialize_sale` accepts, so the
/// sequence gets past step one — the interesting randomness is in what happens after.
fn random_params(rng: &mut Rng, now: i64) -> sale::SaleParams {
    // `supply_for_sale` is pinned to the vault's full balance deliberately: see I3.
    let supply = SUPPLY;
    // The cap may not exceed what the supply covers at the price, or init rejects it.
    let max_raise = (supply as u128 * PRICE as u128 / 1_000_000_000u128) as u64;
    let cap = rng.range(2 * SOL, max_raise + 1);
    // Kept in the lower quarter of the cap on purpose. A floor drawn uniformly up to the cap
    // makes most sequences fail below it, and `Succeeded` — the half of the state machine
    // with claims, sweeps and burns in it — becomes rare. Both outcomes still occur; this
    // only stops the generator from spending its budget on the shallower branch.
    let floor = rng.range(SOL / 10, cap / 4 + 1);
    // The whole timeline is deliberately short. With a close 600–7,200s out and clock hops
    // mostly under 1,500s, most sequences ran out of steps before the sale even closed —
    // 82 of 120 were still `Bidding` at the end. Compressing it puts every deadline within
    // reach of a few hops without changing any rule being tested.
    let close_ts = now + rng.range(60, 1_200) as i64;
    // `absolute_deadline - close_ts >= EXTENSION_SECONDS` or init rejects it.
    let absolute = close_ts + rng.range(300, 1_200) as i64;
    sale::SaleParams {
        price_lamports: PRICE,
        supply_for_sale: supply,
        hard_cap_lamports: cap,
        floor_lamports: floor,
        min_bid_lamports: MIN_BID.min(cap),
        close_ts,
        absolute_deadline: absolute,
        // Two deliberate regimes, coin-flipped, because one setting cannot reach both
        // halves of the state machine:
        //
        //   generous — `mark_pool_created` (which needs `now < pool_deadline`) stays
        //              reachable, and with it claims, sweeps and the burn.
        //   tight    — the clock outruns the deadline, so `fail_on_missing_pool` fires and
        //              the abandonment/refund half gets exercised.
        //
        // A single generous value made the insolvency window unreachable, which is how a
        // mutation with the sweep gate deleted survived a full run.
        pool_deadline: absolute
            + if rng.below(2) == 0 {
                rng.range(120, 900) as i64
            } else {
                rng.range(3_600, 14_400) as i64
            },
    }
}

/// How many sequences reached each interesting state.
///
/// **Printed, and assert-floored at the bottom.** A green property run proves nothing if the
/// sequences never got past `Bidding` — the failure mode of random testing is silent
/// vacuity, and the only defence is to measure reach and fail when it collapses. If a change
/// to the program or the generator makes a state unreachable, this test goes red for that
/// reason rather than quietly testing nothing.
#[derive(Default)]
struct Reach {
    succeeded: u32,
    failed: u32,
    pool_proven: u32,
    any_claim: u32,
    any_refund: u32,
    any_sweep: u32,
    burned: u32,
    oversubscribed: u32,
    /// The other allocation formula entirely — `c_i * 10^decimals / price` rather than
    /// pro-rata. Tracked separately because a book that is always oversubscribed leaves it
    /// untested.
    undersubscribed_settled: u32,
    /// 🔴 **Must stay 0 — this is an anti-metric, not coverage.**
    ///
    /// A sale that ended `Failed` after lamports had been swept out of it is the insolvency
    /// window, and with the `pool_created` gate on `sweep_proceeds` in place it is
    /// unreachable by construction. Reported rather than merely asserted because the number
    /// is the evidence: deleting that gate takes it from 0 to non-zero, and the solvency
    /// assertion in `check` fires at the same moment.
    failed_after_sweep: u32,
}

#[test]
fn random_sequences_preserve_every_invariant() {
    let mut reach = Reach::default();
    for seq in 0..SEQUENCES {
        let seed = 0xA57_1234_0000 + seq;
        let mut rng = Rng(seed);

        let mut ctx = setup(MintOpts::default(), None);
        let params = random_params(&mut rng, ctx.now);
        let close_ts = params.close_ts;

        if send_init(&mut ctx, params).is_err() {
            // A parameter combination the program refuses is a valid outcome, not a test
            // failure — but there is no sale to drive, so move to the next sequence.
            continue;
        }

        // Measured, not assumed: these are the baselines every invariant compares against.
        let mut w = World {
            rent_reserve: sol_vault_balance(&ctx),
            vault_tokens_at_init: token_balance(&ctx, &ctx.vault),
            withheld_at_init: token_withheld(&ctx, &ctx.vault),
            bidders: (0..BIDDERS).map(|_| new_bidder(&mut ctx, 50 * SOL)).collect(),
            saw_failed: false,
            saw_settled: false,
        };

        // A provable pool, ready for whenever the sequence decides to mark it. `open_time`
        // is bounded by `pool_deadline` and the creator is the sale authority, both of which
        // `mark_pool_created` enforces.
        let lp_mint = install_lp_mint(&mut ctx, 0);
        // Hoisted out of the call: `install_pool` takes `&mut ctx`, so these cannot be read
        // from `ctx` inside its argument list.
        let authority = ctx.payer.pubkey();
        let sale_mint = ctx.mint;
        let pool = install_pool(
            &mut ctx,
            &PoolOpts {
                creator: authority,
                lp_mint,
                token_0_mint: sale_mint,
                token_1_mint: sale_mint,
                // Just after the close, NOT at the pool deadline. `mark_pool_created`
                // requires `now < pool_deadline` while `claim` requires
                // `now >= pool_open_time` — so an `open_time` of `pool_deadline` leaves a
                // window of zero and claims are unreachable in practice. The first coverage
                // run proved it: 0 claims in 120 sequences. A real launch opens trading
                // shortly after settling, which is what this models.
                open_time: (close_ts + 60) as u64,
                // Deliberately non-zero: the program must read the LP *mint's* supply, not
                // this stale field.
                lp_supply: 315_832_233_847,
            },
        );

        let outsider = new_bidder(&mut ctx, 10 * SOL);
        check(&ctx, &mut w, seed, 0);

        for step in 1..=STEPS {
            let bidder = w.bidders[rng.below(BIDDERS as u64) as usize].insecure_clone();

            // Errors are ignored on purpose. Roughly half of these are illegal at the moment
            // they fire, and "the program said no" is exactly as valid an outcome as "the
            // program did it" — the assertion is that state is sound either way.
            // Bids are weighted toward the first third of the sequence. Uniform choice means
            // `finalize` usually lands before enough has been committed to clear the floor,
            // so the sale settles Failed and the Succeeded branch — claims, sweeps, burns —
            // is barely explored. This biases WHICH states get reached, never what is
            // asserted once they are.
            // ...and claims toward the last third, because a claim is only legal once the
            // sale has succeeded AND a pool is proven AND the clock has passed `open_time`.
            // Reaching that at all takes most of a sequence; leaving the claim itself to a
            // 1-in-9 draw afterwards meant 2 claims in 120 sequences.
            //
            // The three phases mirror the launch sequence a real sale walks: take bids,
            // settle and prove, then let everyone out. Each phase only makes its own actions
            // MORE likely — every action stays reachable at every step, so out-of-order and
            // illegal calls are still generated constantly. That is the point of the harness.
            let early = step <= STEPS / 3;
            let late = step > (2 * STEPS) / 3;
            let roll = rng.below(100);
            let action = if early && roll < 55 {
                0 // bid
            } else if !early && !late && roll < 40 {
                if roll % 2 == 0 { 1 } else { 2 } // finalize / mark_pool_created
            } else if late && roll < 30 {
                3 // claim
            } else if late && roll < 45 {
                5 // sweep — needs a proven pool, so it can only land here
            } else if late && roll < 55 {
                7 // fail_on_missing_pool — the abandonment path, only live past the deadline
            } else {
                rng.below(9)
            };
            let _ = match action {
                0 => {
                    // Sized so the book lands on both sides of the cap across sequences.
                    // With bids up to 12 SOL against a 2–20 SOL cap, 113 of 120 runs were
                    // oversubscribed and the undersubscribed allocation branch — which uses
                    // a completely different formula — was barely reached.
                    let amount = rng.range(MIN_BID, 5 * SOL);
                    send_bid(&mut ctx, &bidder, amount)
                }
                1 => send_finalize(&mut ctx, &outsider),
                2 => send_mark_pool_created(&mut ctx, &outsider, pool, lp_mint),
                3 => send_claim(&mut ctx, &bidder),
                4 => send_refund(&mut ctx, &outsider, &bidder.pubkey()),
                5 => send_sweep(&mut ctx, &outsider),
                6 => send_burn_unsold(&mut ctx, &outsider),
                7 => send_fail_on_missing_pool(&mut ctx, &outsider),
                _ => {
                    // Time is an action. Without it almost every guard in the program is
                    // unreachable and the sequence never leaves `Bidding` — the interesting
                    // interleavings are the ones where a jump lands between two calls.
                    // Forward only: a real chain's clock cannot run backwards.
                    // Mostly small hops, occasionally a long one. Uniform jumps up to 40,000s
                    // rocket past every deadline in two steps, which lands nearly every
                    // sequence in the same terminal state.
                    ctx.now += if rng.below(100) < 75 {
                        rng.range(1, 1_500) as i64
                    } else {
                        rng.range(1_500, 9_000) as i64
                    };
                    let t = ctx.now;
                    set_clock(&mut ctx, t);
                    Ok(())
                }
            };

            check(&ctx, &mut w, seed, step);
        }

        // What this sequence actually managed to reach.
        let s = read_sale(&ctx);
        match format!("{:?}", s.status).as_str() {
            "Succeeded" => reach.succeeded += 1,
            "Failed" => reach.failed += 1,
            _ => {}
        }
        if s.pool_created { reach.pool_proven += 1 }
        if format!("{:?}", s.status) == "Failed" && s.total_swept_lamports > 0 {
            reach.failed_after_sweep += 1
        }
        if s.claim_count > 0 { reach.any_claim += 1 }
        if s.total_swept_lamports > 0 { reach.any_sweep += 1 }
        if s.unsold_burned { reach.burned += 1 }
        if s.total_committed > s.hard_cap_lamports {
            reach.oversubscribed += 1
        } else if s.total_committed > 0 && format!("{:?}", s.status) != "Bidding" {
            reach.undersubscribed_settled += 1
        }
        if w.bidders.iter().any(|b| commitment_refunded(&ctx, &b.pubkey()) > 0) {
            reach.any_refund += 1
        }
    }

    println!(
        "\nreached, out of {SEQUENCES} sequences:\n  \
         Succeeded {}\n  Failed {}\n  pool proven {}\n  >=1 claim {}\n  \
         >=1 refund {}\n  >=1 sweep {}\n  unsold burned {}\n  oversubscribed {}\n  \
         undersubscribed+settled {}\n  Failed AFTER a sweep {}  <- must be 0\n",
        reach.succeeded, reach.failed, reach.pool_proven, reach.any_claim,
        reach.any_refund, reach.any_sweep, reach.burned, reach.oversubscribed,
        reach.undersubscribed_settled, reach.failed_after_sweep,
    );

    // Floors, not targets. These are set well below what the generator currently achieves,
    // so they catch "the harness stopped reaching this state at all" without turning a
    // tuning change into a red build.
    assert!(reach.succeeded >= 5, "almost no sequence reached Succeeded — harness is vacuous");
    assert!(reach.failed >= 5, "almost no sequence reached Failed — harness is vacuous");
    assert!(reach.pool_proven >= 3, "pool proving is effectively unreachable");
    assert!(reach.any_claim >= 3, "claims are effectively unreachable");
    assert!(reach.any_refund >= 3, "refunds are effectively unreachable");
    assert!(reach.any_sweep >= 3, "sweeps are effectively unreachable");
    assert!(reach.burned >= 3, "burn_unsold is effectively unreachable");
    assert!(reach.oversubscribed >= 3, "the pro-rata branch is effectively unreachable");
    assert!(
        reach.undersubscribed_settled >= 3,
        "the undersubscribed allocation branch is effectively unreachable",
    );
}
