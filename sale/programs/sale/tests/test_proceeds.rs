//! Phase 4 — the raise leaves, and the unsold remainder is destroyed.
//!
//! The single most important test in this file is
//! `sweeping_before_a_pool_exists_is_refused`. Without that gate the sweep empties the
//! vault, the pool never appears, `fail_on_missing_pool` flips the sale to `Failed`, and
//! every refund then fails for want of lamports — total, permanent loss of principal
//! caused by the path that exists to prevent exactly that.

mod common;

use common::*;

use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;

const SOL: u64 = 1_000_000_000;

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// A succeeded sale with no pool proven yet — the exact window the hole lived in.
fn succeeded_without_pool(amounts: &[u64]) -> (Ctx, Vec<Keypair>) {
    let mut ctx = setup(MintOpts::default(), None);
    let close_ts = ctx.now + 3_600;
    send_init(&mut ctx, default_params(close_ts)).unwrap();

    let mut bidders = Vec::new();
    for a in amounts {
        let kp = new_bidder(&mut ctx, a + SOL);
        send_bid(&mut ctx, &kp, *a).unwrap();
        bidders.push(kp);
    }
    set_clock(&mut ctx, close_ts + 1);
    let outsider = new_bidder(&mut ctx, SOL);
    send_finalize(&mut ctx, &outsider).unwrap();
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Succeeded);
    (ctx, bidders)
}

/// 🔴 **The gate that stands between a swept vault and every bidder losing everything.**
#[test]
fn sweeping_before_a_pool_exists_is_refused() {
    let (mut ctx, _bidders) = succeeded_without_pool(&[10 * SOL]);
    let outsider = new_bidder(&mut ctx, SOL);
    let err = send_sweep(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("SweepBeforePool"), "{err}");
}

/// The failure that gate prevents, played out to the end: sweep first, then let the
/// abandonment path run, and the refund has nothing left to pay with.
///
/// The vault is drained here by hand — the program refuses to do it — so this pins *why*
/// the gate exists rather than merely that it is present.
#[test]
fn a_drained_vault_makes_every_refund_impossible() {
    let (mut ctx, bidders) = succeeded_without_pool(&[10 * SOL]);
    let (vault_key, _) = sol_vault_pda(&ctx.sale_key);

    // What a sweep without the gate would have left behind: the rent reserve only.
    let reserve = ctx
        .svm
        .get_sysvar::<anchor_lang::prelude::Rent>()
        .minimum_balance(0);
    let mut vault = ctx.svm.get_account(&vault_key).unwrap();
    vault.lamports = reserve;
    ctx.svm.set_account(vault_key, vault).unwrap();

    let outsider = new_bidder(&mut ctx, SOL);
    let deadline = read_sale(&ctx).pool_deadline;
    set_clock(&mut ctx, deadline);
    send_fail_on_missing_pool(&mut ctx, &outsider).unwrap();

    let err = send_refund(&mut ctx, &outsider, &bidders[0].pubkey()).unwrap_err();
    assert!(err.contains("VaultBelowRentReserve"), "{err}");
}

#[test]
fn rejects_a_sweep_on_a_failed_sale() {
    let (mut ctx, _bidders) = succeeded_without_pool(&[10 * SOL]);
    let outsider = new_bidder(&mut ctx, SOL);
    let deadline = read_sale(&ctx).pool_deadline;
    set_clock(&mut ctx, deadline);
    send_fail_on_missing_pool(&mut ctx, &outsider).unwrap();

    let err = send_sweep(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("SaleNotSucceeded"), "{err}");
}

/// The destination was published before anyone bid. Nothing else may receive the raise.
#[test]
fn rejects_a_sweep_to_any_other_destination() {
    let mut ctx = setup(MintOpts::default(), None);
    drive_to_claimable(&mut ctx, &[10 * SOL]);
    let outsider = new_bidder(&mut ctx, SOL);

    let err = send_sweep_to(&mut ctx, &outsider, Pubkey::new_unique()).unwrap_err();
    assert!(err.contains("WrongSeedDestination"), "{err}");
}

// ---------------------------------------------------------------------------
// Undersubscribed — exact, no dust
// ---------------------------------------------------------------------------

/// Every commitment is accepted in full, so the sweepable amount is the whole raise and it
/// is knowable before a single claim has settled — which is when the sweep has to run.
#[test]
fn an_undersubscribed_raise_sweeps_in_full_before_any_claim() {
    let mut ctx = setup(MintOpts::default(), None);
    drive_to_claimable(&mut ctx, &[7 * SOL, 3 * SOL]);
    let dest = seed_destination(&ctx);
    let before = balance(&ctx, &dest);

    let outsider = new_bidder(&mut ctx, SOL);
    send_sweep(&mut ctx, &outsider).unwrap();

    assert_eq!(balance(&ctx, &dest) - before, 10 * SOL);
    let s = read_sale(&ctx);
    assert_eq!(s.total_swept_lamports, 10 * SOL);
    assert_eq!(s.claim_count, 0, "nothing was claimed first — that is the point");
}

#[test]
fn rejects_a_second_sweep_once_the_ceiling_is_reached() {
    let mut ctx = setup(MintOpts::default(), None);
    drive_to_claimable(&mut ctx, &[10 * SOL]);
    let outsider = new_bidder(&mut ctx, SOL);

    send_sweep(&mut ctx, &outsider).unwrap();
    let err = send_sweep(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("NothingToSweep"), "{err}");
}

/// Permissionless, and the caller gains nothing — the raise goes to the pre-committed
/// destination regardless of who paid the fee.
#[test]
fn anyone_can_sweep_and_the_caller_gains_nothing() {
    let mut ctx = setup(MintOpts::default(), None);
    drive_to_claimable(&mut ctx, &[10 * SOL]);
    let stranger = new_bidder(&mut ctx, SOL);
    let before = balance(&ctx, &stranger.pubkey());

    send_sweep(&mut ctx, &stranger).unwrap();
    assert!(balance(&ctx, &stranger.pubkey()) < before);
    assert_eq!(balance(&ctx, &seed_destination(&ctx)), 10 * SOL);
}

// ---------------------------------------------------------------------------
// Oversubscribed — the conservative bound, then the exact one
// ---------------------------------------------------------------------------

/// **The sweep must not touch refund money.** Oversubscribed, most of the vault belongs to
/// bidders as pro-rata excess, and the sweepable share is not computable without iterating
/// every commitment — so the bound is `cap - commitment_count`, safe by construction and
/// available immediately.
///
/// Then the re-callable sweep collects the rounding dust once claims have settled, without
/// ever having depended on them settling.
#[test]
fn an_oversubscribed_sweep_takes_the_bound_first_and_the_dust_later() {
    let mut ctx = setup(MintOpts::default(), None);
    let amounts = [13 * SOL + 7, 19 * SOL + 999, 11 * SOL + 123_456];
    let bidders = drive_to_claimable(&mut ctx, &amounts);
    let dest = seed_destination(&ctx);
    let outsider = new_bidder(&mut ctx, SOL);

    let s = read_sale(&ctx);
    assert!(s.total_committed > s.hard_cap_lamports, "must be oversubscribed");
    assert_eq!(s.commitment_count, 3);

    // Round one: the conservative bound, before anyone has claimed.
    send_sweep(&mut ctx, &outsider).unwrap();
    let first = balance(&ctx, &dest);
    assert_eq!(first, HARD_CAP - 3);

    // Enough is left for every refund, which is the property that matters.
    let owed: u64 = bidders
        .iter()
        .map(|b| read_commitment(&ctx, &b.pubkey()).amount)
        .sum::<u64>()
        - first;
    assert!(sol_vault_balance(&ctx) >= owed, "refund money was swept away");

    for b in &bidders {
        send_claim(&mut ctx, b).unwrap();
    }

    // Round two: `total_accepted_lamports` is now exact and overtakes the bound.
    let accepted = read_sale(&ctx).total_accepted_lamports;
    assert!(accepted > HARD_CAP - 3, "the bound should have been the smaller one");
    send_sweep(&mut ctx, &outsider).unwrap();
    assert_eq!(balance(&ctx, &dest), accepted);
    assert_eq!(read_sale(&ctx).total_swept_lamports, accepted);
}

/// Repeat bids from one wallet accumulate into one `Commitment`, so they must count once.
/// Counting them twice would loosen the sweep bound by a lamport per extra bid.
#[test]
fn repeat_bids_count_as_one_commitment() {
    let mut ctx = setup(MintOpts::default(), None);
    let close_ts = ctx.now + 3_600;
    send_init(&mut ctx, default_params(close_ts)).unwrap();

    let a = new_bidder(&mut ctx, 20 * SOL);
    let b = new_bidder(&mut ctx, 20 * SOL);
    send_bid(&mut ctx, &a, 2 * SOL).unwrap();
    send_bid(&mut ctx, &a, 3 * SOL).unwrap();
    send_bid(&mut ctx, &a, SOL).unwrap();
    send_bid(&mut ctx, &b, 4 * SOL).unwrap();

    assert_eq!(read_sale(&ctx).commitment_count, 2);
}

// ---------------------------------------------------------------------------
// burn_unsold
// ---------------------------------------------------------------------------

/// ⚠️ **Verifying the assumption, not restating it.** GAMEPLAN §6.5 says `Burn` is untaxed;
/// this proves it against the live program. One wrong Token-2022 belief already cost this
/// project a day, and it came from exactly this class of assumption.
#[test]
fn burning_is_untaxed() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL]);
    send_claim(&mut ctx, &bidders[0]).unwrap();

    let supply_before = mint_supply(&ctx, &ctx.mint);
    let vault_before = token_balance(&ctx, &ctx.vault);
    let vault_withheld_before = token_withheld(&ctx, &ctx.vault);

    let outsider = new_bidder(&mut ctx, SOL);
    send_burn_unsold(&mut ctx, &outsider).unwrap();

    let unsold = SUPPLY - read_sale(&ctx).total_claimed_tokens;
    assert!(unsold > 0);
    // Supply and vault both fall by exactly the burned amount: no fee anywhere.
    assert_eq!(supply_before - mint_supply(&ctx, &ctx.mint), unsold);
    assert_eq!(vault_before - token_balance(&ctx, &ctx.vault), unsold);
    assert_eq!(
        token_withheld(&ctx, &ctx.vault),
        vault_withheld_before,
        "a fee on the burn would show up here"
    );
    assert!(read_sale(&ctx).unsold_burned);
}

/// 🔴 **The vault is empty when it is all over — no residue, nothing stranded.**
///
/// This is the test whose absence let the stranding ship. Ninety tests asserted transfers
/// and recorded state; not one asserted what was *left*. The 2026-08-09 devnet rehearsal
/// finished with 500,000 ARD sitting in a vault that only the sale PDA can sign for, past
/// the point where `burn_unsold` — one-shot, and burning a recorded figure rather than the
/// balance — could ever reach it.
///
/// It holds only because `supply_for_sale` can now equal the vault's full `base.amount`.
/// Under the old `amount - withheld` formula the declared supply was one fee short, so
/// `SUPPLY - total_claimed_tokens` always left that fee behind and this assertion fails —
/// which is exactly the regression it exists to catch.
///
/// **`withheld` is deliberately asserted non-zero.** The funding fee is still parked on the
/// vault and `harvest` is the only thing that moves it. That is correct and separate; an
/// assertion of "the vault is completely empty" would encode the wrong invariant and invite
/// someone to break the harvest path trying to satisfy it.
#[test]
fn nothing_is_stranded_in_the_vault_after_the_burn() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL, 3 * SOL]);
    for b in &bidders {
        send_claim(&mut ctx, b).unwrap();
    }

    let outsider = new_bidder(&mut ctx, SOL);
    send_burn_unsold(&mut ctx, &outsider).unwrap();

    assert_eq!(
        token_balance(&ctx, &ctx.vault),
        0,
        "every sellable token must have been claimed or burned — a non-zero balance here \
         is permanently locked, because burn_unsold is one-shot and has now run",
    );
    assert_eq!(
        token_withheld(&ctx, &ctx.vault),
        WITHHELD,
        "the funding fee stays withheld and is harvestable — it was never sellable supply",
    );
}

/// Burning while someone can still claim would eat their allocation.
#[test]
fn rejects_a_burn_while_claims_are_outstanding() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL, 5 * SOL]);
    send_claim(&mut ctx, &bidders[0]).unwrap();

    let outsider = new_bidder(&mut ctx, SOL);
    let err = send_burn_unsold(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("ClaimsOutstanding"), "{err}");

    send_claim(&mut ctx, &bidders[1]).unwrap();
    send_burn_unsold(&mut ctx, &outsider).expect("now that everyone has claimed");
}

/// A failed sale needs no claim-count guard: `claim` requires `Succeeded`, so not one
/// token can ever have left the vault and the whole supply is unsold by definition.
#[test]
fn a_failed_sale_burns_the_entire_supply() {
    let mut ctx = setup(MintOpts::default(), None);
    let close_ts = ctx.now + 3_600;
    send_init(&mut ctx, default_params(close_ts)).unwrap();
    let bidder = new_bidder(&mut ctx, 5 * SOL);
    send_bid(&mut ctx, &bidder, MIN_BID).unwrap();
    set_clock(&mut ctx, close_ts + 1);
    let outsider = new_bidder(&mut ctx, SOL);
    send_finalize(&mut ctx, &outsider).unwrap();
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Failed);
    assert_eq!(read_sale(&ctx).claim_count, 0);
    assert_eq!(read_sale(&ctx).commitment_count, 1);

    let supply_before = mint_supply(&ctx, &ctx.mint);
    send_burn_unsold(&mut ctx, &outsider).expect("no claim can ever have happened");
    assert_eq!(supply_before - mint_supply(&ctx, &ctx.mint), SUPPLY);

    // And the bidder still gets their money back afterwards.
    let before = balance(&ctx, &bidder.pubkey());
    send_refund(&mut ctx, &outsider, &bidder.pubkey()).unwrap();
    assert_eq!(balance(&ctx, &bidder.pubkey()) - before, MIN_BID);
}

#[test]
fn rejects_a_second_burn() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL]);
    send_claim(&mut ctx, &bidders[0]).unwrap();
    let outsider = new_bidder(&mut ctx, SOL);

    send_burn_unsold(&mut ctx, &outsider).unwrap();
    let err = send_burn_unsold(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("AlreadyBurned"), "{err}");
}

#[test]
fn rejects_a_burn_while_bidding_is_open() {
    let mut ctx = setup(MintOpts::default(), None);
    let close_ts = ctx.now + 3_600;
    send_init(&mut ctx, default_params(close_ts)).unwrap();
    let outsider = new_bidder(&mut ctx, SOL);
    let err = send_burn_unsold(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("SaleStillOpen"), "{err}");
}

/// A fully subscribed sale allocates the entire supply, so there is nothing left to burn
/// and the instruction says so rather than sending a zero-amount CPI.
#[test]
fn rejects_a_burn_when_the_supply_sold_out_exactly() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[HARD_CAP]);
    send_claim(&mut ctx, &bidders[0]).unwrap();
    assert_eq!(read_sale(&ctx).total_claimed_tokens, SUPPLY);

    let outsider = new_bidder(&mut ctx, SOL);
    let err = send_burn_unsold(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("NothingToBurn"), "{err}");
}
