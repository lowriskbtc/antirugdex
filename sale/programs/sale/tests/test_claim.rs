//! Settlement — the highest-stakes code in the program, and the only place that moves
//! strangers' money outward.
//!
//! The design invariant every test here is ultimately about:
//!
//! > If the allocation math were completely broken, could every bidder still recover their
//! > principal?
//!
//! `refund` is the answer, which is why it is a separate instruction with no mint, no
//! token program and no allocation arithmetic in it.

mod common;

use common::*;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use solana_keypair::Keypair;

const SOL: u64 = 1_000_000_000;

// ---------------------------------------------------------------------------
// Undersubscribed — everyone fills at the fixed price
// ---------------------------------------------------------------------------

/// 5 SOL at 100 lamports per whole token, 9 decimals: 50,000,000 ARD, no refund.
#[test]
fn undersubscribed_fills_at_the_fixed_price_with_no_refund() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL]);
    let bidder = &bidders[0];

    let expected = 5 * SOL as u128 * 1_000_000_000u128 / PRICE as u128; // c * D / P
    let expected = expected as u64;

    let before = balance(&ctx, &bidder.pubkey());
    send_claim(&mut ctx, bidder).expect("claim should settle");

    let c = read_commitment(&ctx, &bidder.pubkey());
    assert!(c.claimed);
    assert_eq!(c.tokens_claimed, expected);
    assert_eq!(c.lamports_refunded, 0);

    // No lamports came back — undersubscribed means the whole commitment was accepted.
    // The balance only *fell*, by fees and the new token account's rent.
    assert!(balance(&ctx, &bidder.pubkey()) < before);

    let s = read_sale(&ctx);
    assert_eq!(s.total_claimed_tokens, expected);
    assert_eq!(s.total_accepted_lamports, 5 * SOL);
    assert_eq!(s.claim_count, 1);

    // What the bidder can actually sell is the allocation minus the transfer fee.
    let dest = ata(&bidder.pubkey(), &ctx.mint);
    assert_eq!(token_balance(&ctx, &dest), expected - fee_on(expected));
}

/// **The claimer receives less than their allocation, and every UI must say so.**
///
/// This test also pins Token-2022's actual bookkeeping, which is easy to get backwards:
/// the vault is debited the **gross**, the destination's `amount` is credited the **net**,
/// and the fee lands in the destination's `withheld_amount` *alongside* `amount` rather
/// than inside it. Measured against the live program, not read off documentation.
#[test]
fn the_transfer_fee_is_taken_out_of_the_claim_itself() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL]);

    let vault_before = token_balance(&ctx, &ctx.vault);
    send_claim(&mut ctx, &bidders[0]).unwrap();

    let dest = ata(&bidders[0].pubkey(), &ctx.mint);
    let gross = read_commitment(&ctx, &bidders[0].pubkey()).tokens_claimed;
    let received = token_balance(&ctx, &dest);
    let withheld = token_withheld(&ctx, &dest);

    assert_eq!(vault_before - token_balance(&ctx, &ctx.vault), gross);
    assert_eq!(received, gross - fee_on(gross));
    assert_eq!(withheld, fee_on(gross));
    // Conservation: nothing appears or disappears, so withheld cannot be part of `amount`.
    assert_eq!(received + withheld, gross);
    assert!(received < gross, "the fee must actually bite");
}

/// **The single most valuable arithmetic test in this slice.**
///
/// A bid at exactly the configured hard cap makes `c_i * D` equal 2e19, which is already
/// past `u64::MAX` (~1.8e19). A u64 intermediate here would truncate silently — `as u64`
/// is not caught by `overflow-checks` — and hand the bidder a wrong allocation. The u128
/// rule binds at the *configured* cap, not at some absurd input.
///
/// It also drains the vault exactly: the cap is sized at `floor(S * P / D)`, so filling it
/// at the fixed price allocates the entire supply and not one base unit more.
#[test]
fn a_bid_at_the_hard_cap_needs_u128_and_drains_the_vault_exactly() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[HARD_CAP]);

    assert!(
        HARD_CAP as u128 * 1_000_000_000u128 > u64::MAX as u128,
        "this test is pointless unless the intermediate really does exceed u64"
    );

    send_claim(&mut ctx, &bidders[0]).unwrap();
    let s = read_sale(&ctx);
    assert_eq!(s.total_claimed_tokens, SUPPLY);
    assert_eq!(s.total_claimed_tokens, s.supply_for_sale);
}

// ---------------------------------------------------------------------------
// Oversubscribed — pro-rata on both sides
// ---------------------------------------------------------------------------

#[test]
fn oversubscribed_allocates_pro_rata_and_refunds_the_excess() {
    let mut ctx = setup(MintOpts::default(), None);
    // 30 + 10 = 40 SOL against a 20 SOL cap.
    let bidders = drive_to_claimable(&mut ctx, &[30 * SOL, 10 * SOL]);
    let total = 40 * SOL as u128;

    for (bidder, c_i) in bidders.iter().zip([30 * SOL, 10 * SOL]) {
        let want_tokens = (c_i as u128 * SUPPLY as u128 / total) as u64;
        let want_accepted = (c_i as u128 * HARD_CAP as u128 / total) as u64;
        let want_refund = c_i - want_accepted;

        let before = balance(&ctx, &bidder.pubkey());
        send_claim(&mut ctx, bidder).unwrap();
        let after = balance(&ctx, &bidder.pubkey());

        let c = read_commitment(&ctx, &bidder.pubkey());
        assert_eq!(c.tokens_claimed, want_tokens);
        assert_eq!(c.lamports_refunded, want_refund);
        // The refund really moved; fees and rent make the delta slightly smaller.
        assert!(after > before, "refund should outweigh the fee");
        assert!(after - before <= want_refund);
        let dest = ata(&bidder.pubkey(), &ctx.mint);
        assert_eq!(token_balance(&ctx, &dest), want_tokens - fee_on(want_tokens));
    }

    let s = read_sale(&ctx);
    assert!(s.total_claimed_tokens <= s.supply_for_sale);
    // Sweepable proceeds are the recorded sum, which flooring leaves *below* the cap.
    assert!(s.total_accepted_lamports <= s.hard_cap_lamports);
    assert_eq!(s.claim_count, 2);
}

/// **The property the whole mechanism exists for.** One wallet with 30 SOL and three
/// wallets with 10 SOL each settle to the same tokens and the same refund. If this ever
/// fails, bundling is profitable again and the design is broken.
#[test]
fn splitting_a_bid_across_wallets_settles_identically() {
    let one = {
        let mut ctx = setup(MintOpts::default(), None);
        let bidders = drive_to_claimable(&mut ctx, &[30 * SOL, 10 * SOL]);
        send_claim(&mut ctx, &bidders[0]).unwrap();
        let c = read_commitment(&ctx, &bidders[0].pubkey());
        (c.tokens_claimed, c.lamports_refunded)
    };

    let split = {
        let mut ctx = setup(MintOpts::default(), None);
        // Same 40 SOL book, the 30 split three ways.
        let bidders = drive_to_claimable(&mut ctx, &[10 * SOL, 10 * SOL, 10 * SOL, 10 * SOL]);
        let mut tokens = 0u64;
        let mut refund = 0u64;
        for b in bidders.iter().take(3) {
            send_claim(&mut ctx, b).unwrap();
            let c = read_commitment(&ctx, &b.pubkey());
            tokens += c.tokens_claimed;
            refund += c.lamports_refunded;
        }
        (tokens, refund)
    };

    assert_eq!(one, split, "wallet-splitting must be worth exactly zero");
}

/// Repeat bids accumulate into one `Commitment`, so they settle once, on the sum.
#[test]
fn repeat_bids_settle_as_one_commitment() {
    let mut ctx = setup(MintOpts::default(), None);
    let close_ts = ctx.now + 3_600;
    send_init(&mut ctx, default_params(close_ts)).unwrap();

    let bidder = new_bidder(&mut ctx, 20 * SOL);
    send_bid(&mut ctx, &bidder, 3 * SOL).unwrap();
    send_bid(&mut ctx, &bidder, 4 * SOL).unwrap();

    set_clock(&mut ctx, close_ts + 1);
    let outsider = new_bidder(&mut ctx, SOL);
    send_finalize(&mut ctx, &outsider).unwrap();

    let open_time = (close_ts + 7_200) as u64;
    let lp = install_lp_mint(&mut ctx, 0);
    let opts = PoolOpts {
        creator: ctx.payer.pubkey(),
        lp_mint: lp,
        token_0_mint: Pubkey::new_unique(),
        token_1_mint: ctx.mint,
        open_time,
        lp_supply: 0,
    };
    let pool = install_pool(&mut ctx, &opts);
    send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap();
    set_clock(&mut ctx, open_time as i64 + 1);

    send_claim(&mut ctx, &bidder).unwrap();
    let expected = (7 * SOL as u128 * 1_000_000_000u128 / PRICE as u128) as u64;
    assert_eq!(read_commitment(&ctx, &bidder.pubkey()).tokens_claimed, expected);
    assert_eq!(read_sale(&ctx).claim_count, 1);
}

/// **The full-vault drain with ragged bid sizes** — the case where over-allocating would
/// otherwise surface only as *the last claimer's* transaction failing.
///
/// Sub-additive flooring means the sum lands at or just under the supply, with dust left
/// behind, and the final claim goes through like every other one.
#[test]
fn a_ragged_full_drain_leaves_dust_and_the_last_claim_still_lands() {
    let mut ctx = setup(MintOpts::default(), None);
    let amounts = [
        7 * SOL + 333_333_333,
        11 * SOL + 7,
        3 * SOL + 999_999_999,
        SOL + 1,
        5 * SOL + 12_345_678,
    ];
    let bidders = drive_to_claimable(&mut ctx, &amounts);
    let committed: u64 = amounts.iter().sum();
    assert!(committed > HARD_CAP, "this test needs an oversubscribed book");

    for b in &bidders {
        send_claim(&mut ctx, b).expect("every claim, including the last, must land");
    }

    let s = read_sale(&ctx);
    assert!(
        s.total_claimed_tokens <= s.supply_for_sale,
        "over-allocation: {} > {}",
        s.total_claimed_tokens,
        s.supply_for_sale
    );
    // Dust, and no more than one base unit per bidder.
    let dust = s.supply_for_sale - s.total_claimed_tokens;
    assert!(dust < amounts.len() as u64, "unexpected shortfall of {dust}");

    // Same story on the lamport side, and it is why `sweep_proceeds` must move
    // `total_accepted_lamports` rather than the cap.
    let lamport_dust = s.hard_cap_lamports - s.total_accepted_lamports;
    assert!(lamport_dust < amounts.len() as u64);
    assert!(
        lamport_dust > 0,
        "if this is ever zero the sweep-the-cap shortcut looks safe when it is not"
    );
}

// ---------------------------------------------------------------------------
// Degenerate: an allocation that floors to zero
// ---------------------------------------------------------------------------

/// A tiny bidder in a heavily oversubscribed sale can round down to zero tokens. They must
/// still settle, and they must still get their refund — the failure to avoid is a
/// commitment that can never be closed out.
#[test]
fn an_allocation_that_floors_to_zero_still_refunds() {
    // A sale with a ten-base-unit supply priced so the cap is one whole SOL. Contrived on
    // purpose: with realistic parameters the flooring case is unreachable.
    let mut ctx = setup(
        MintOpts::default(),
        Some(Box::new(|sale| VaultOpts {
            owner: sale,
            amount: 20,
            withheld: 10, // spendable = 10
            delegate: None,
            close_authority: None,
            frozen: false,
        })),
    );
    let close_ts = ctx.now + 3_600;
    let params = sale::SaleParams {
        price_lamports: 100_000_000_000_000_000, // 1e17 lamports per whole token
        supply_for_sale: 10,
        hard_cap_lamports: SOL,
        floor_lamports: 1_000,
        min_bid_lamports: 1_000,
        close_ts,
        absolute_deadline: close_ts + 3_600,
        pool_deadline: close_ts + 86_400,
    };
    let whale = SOL;
    let minnow = 1_000_000u64;
    let bidders = drive_to_claimable_with(&mut ctx, params, &[whale, minnow]);

    send_claim(&mut ctx, &bidders[1]).expect("a zero allocation must still settle");
    let c = read_commitment(&ctx, &bidders[1].pubkey());
    assert_eq!(c.tokens_claimed, 0, "allocation should floor to zero");
    assert!(c.claimed);
    assert!(c.lamports_refunded > 0, "the refund is the whole point here");

    // And the whale still gets theirs.
    send_claim(&mut ctx, &bidders[0]).unwrap();
    assert!(read_commitment(&ctx, &bidders[0].pubkey()).tokens_claimed > 0);
    assert!(read_sale(&ctx).total_claimed_tokens <= 10);
}

// ---------------------------------------------------------------------------
// refund — the principal-recovery path
// ---------------------------------------------------------------------------

/// Below the floor at close: every commitment comes back whole.
fn failed_sale(amounts: &[u64]) -> (Ctx, Vec<Keypair>) {
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
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Failed);
    (ctx, bidders)
}

#[test]
fn a_failed_sale_returns_exactly_the_principal() {
    let (mut ctx, bidders) = failed_sale(&[MIN_BID, MIN_BID * 3]);
    let outsider = new_bidder(&mut ctx, SOL);

    for (b, amount) in bidders.iter().zip([MIN_BID, MIN_BID * 3]) {
        let before = balance(&ctx, &b.pubkey());
        send_refund(&mut ctx, &outsider, &b.pubkey()).unwrap();
        // Exactly, to the lamport: the bidder did not pay the fee, so nothing erodes it.
        assert_eq!(balance(&ctx, &b.pubkey()) - before, amount);
        assert_eq!(read_commitment(&ctx, &b.pubkey()).lamports_refunded, amount);
        assert_eq!(read_commitment(&ctx, &b.pubkey()).tokens_claimed, 0);
    }

    // The vault is back to its rent reserve and nothing else.
    assert!(sol_vault_balance(&ctx) < MIN_BID);
}

/// **Permissionless on purpose.** A bidder who committed everything they had cannot afford
/// the transaction that returns it, and a signature requirement would make recovery depend
/// on them still holding a live key. Nobody can profit from pushing someone else's refund:
/// the amount is a recorded number and the destination is fixed by the PDA seeds.
#[test]
fn anyone_can_push_a_refund_and_the_bidder_receives_it() {
    let (mut ctx, bidders) = failed_sale(&[MIN_BID]);
    let stranger = new_bidder(&mut ctx, SOL);

    let bidder_before = balance(&ctx, &bidders[0].pubkey());
    let stranger_before = balance(&ctx, &stranger.pubkey());
    send_refund(&mut ctx, &stranger, &bidders[0].pubkey()).unwrap();

    assert_eq!(balance(&ctx, &bidders[0].pubkey()) - bidder_before, MIN_BID);
    assert!(
        balance(&ctx, &stranger.pubkey()) < stranger_before,
        "the caller pays and gains nothing"
    );
}

/// **The case the permissionless design exists for, proven rather than argued.**
///
/// A bidder holding *zero* lamports cannot sign or pay for anything. If `refund` required
/// their signature, committing everything they had would mean never getting it back. Their
/// balance is zeroed outright here — there is no weaker version of this test.
#[test]
fn a_bidder_with_no_lamports_left_still_gets_refunded() {
    let (mut ctx, bidders) = failed_sale(&[MIN_BID]);
    let broke = bidders[0].pubkey();

    ctx.svm
        .set_account(
            broke,
            solana_account::Account {
                lamports: 0,
                data: vec![],
                owner: anchor_lang::solana_program::system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    assert_eq!(balance(&ctx, &broke), 0);

    let stranger = new_bidder(&mut ctx, SOL);
    send_refund(&mut ctx, &stranger, &broke).expect("a broke bidder must still recover");
    assert_eq!(balance(&ctx, &broke), MIN_BID);
}

/// `refund` does not write the `Sale` account at all. That is what keeps the recovery path
/// clear of the claim bookkeeping — and it lets refunds run in parallel rather than
/// queueing behind a single write lock.
#[test]
fn refunds_never_touch_the_sale_account() {
    let (mut ctx, bidders) = failed_sale(&[MIN_BID, MIN_BID]);
    let before = ctx.svm.get_account(&ctx.sale_key).unwrap().data;
    let outsider = new_bidder(&mut ctx, SOL);

    for b in &bidders {
        send_refund(&mut ctx, &outsider, &b.pubkey()).unwrap();
    }

    assert_eq!(ctx.svm.get_account(&ctx.sale_key).unwrap().data, before);
    let s = read_sale(&ctx);
    assert_eq!(s.claim_count, 0);
    assert_eq!(s.total_claimed_tokens, 0);
}

#[test]
fn rejects_a_second_refund() {
    let (mut ctx, bidders) = failed_sale(&[MIN_BID]);
    let outsider = new_bidder(&mut ctx, SOL);
    send_refund(&mut ctx, &outsider, &bidders[0].pubkey()).unwrap();
    let err = send_refund(&mut ctx, &outsider, &bidders[0].pubkey()).unwrap_err();
    assert!(err.contains("AlreadyClaimed"), "{err}");
}

#[test]
fn rejects_a_refund_on_a_succeeded_sale() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL]);
    let outsider = new_bidder(&mut ctx, SOL);
    let err = send_refund(&mut ctx, &outsider, &bidders[0].pubkey()).unwrap_err();
    assert!(err.contains("SaleNotFailed"), "{err}");
}

/// The abandonment path end to end: the sale succeeded, no pool ever appeared, and the
/// permissionless flip turns every claim into a full refund.
#[test]
fn an_abandoned_sale_refunds_in_full_through_the_recovery_path() {
    let mut ctx = setup(MintOpts::default(), None);
    let close_ts = ctx.now + 3_600;
    send_init(&mut ctx, default_params(close_ts)).unwrap();
    let bidder = new_bidder(&mut ctx, 20 * SOL);
    send_bid(&mut ctx, &bidder, 10 * SOL).unwrap();

    set_clock(&mut ctx, close_ts + 1);
    let outsider = new_bidder(&mut ctx, SOL);
    send_finalize(&mut ctx, &outsider).unwrap();
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Succeeded);

    // Claims are blocked because no pool was ever proven.
    let err = send_claim(&mut ctx, &bidder).unwrap_err();
    assert!(err.contains("PoolNotCreated"), "{err}");

    let pool_deadline = read_sale(&ctx).pool_deadline;
    set_clock(&mut ctx, pool_deadline);
    send_fail_on_missing_pool(&mut ctx, &outsider).unwrap();

    let before = balance(&ctx, &bidder.pubkey());
    send_refund(&mut ctx, &outsider, &bidder.pubkey()).unwrap();
    assert_eq!(balance(&ctx, &bidder.pubkey()) - before, 10 * SOL);
}

// ---------------------------------------------------------------------------
// Claim guards
// ---------------------------------------------------------------------------

#[test]
fn rejects_a_second_claim() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL]);
    send_claim(&mut ctx, &bidders[0]).unwrap();
    let err = send_claim(&mut ctx, &bidders[0]).unwrap_err();
    assert!(err.contains("AlreadyClaimed"), "{err}");
}

#[test]
fn rejects_a_claim_on_a_failed_sale() {
    let (mut ctx, bidders) = failed_sale(&[MIN_BID]);
    let err = send_claim(&mut ctx, &bidders[0]).unwrap_err();
    assert!(err.contains("SaleNotSucceeded"), "{err}");
}

/// Invariant 2. Claims opening only once trading is live is what keeps the circulating
/// float at zero when the pool opens, so the only possible first trade is a buy.
#[test]
fn rejects_a_claim_before_the_pool_starts_trading() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL]);

    let open_time = read_sale(&ctx).pool_open_time;
    set_clock(&mut ctx, open_time - 1);
    let err = send_claim(&mut ctx, &bidders[0]).unwrap_err();
    assert!(err.contains("ClaimsNotOpen"), "{err}");

    // And it opens exactly on the boundary, not a second later.
    set_clock(&mut ctx, open_time);
    send_claim(&mut ctx, &bidders[0]).unwrap();
}

#[test]
fn rejects_a_claim_without_the_jito_marker() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL]);
    let ix = claim_ix(
        &ctx,
        &bidders[0].pubkey(),
        Pubkey::new_unique(),
        sale::constants::INSTRUCTIONS_SYSVAR,
    );
    let payer = bidders[0].insecure_clone();
    let err = send_many_as(&mut ctx, &[ix], &payer, &[]).unwrap_err();
    assert!(err.contains("MissingJitoMarker"), "{err}");
}

#[test]
fn rejects_a_claim_with_a_substituted_instructions_sysvar() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL]);
    // Any other account: the address constraint is what stops a forged instruction list.
    let ix = claim_ix(
        &ctx,
        &bidders[0].pubkey(),
        sale::constants::JITO_DONT_FRONT,
        ctx.sale_key,
    );
    let payer = bidders[0].insecure_clone();
    let err = send_many_as(&mut ctx, &[ix], &payer, &[]).unwrap_err();
    assert!(err.contains("MalformedInstructionsSysvar"), "{err}");
}

// ---------------------------------------------------------------------------
// The anti-bundle rule — and the honest limits of it
// ---------------------------------------------------------------------------

/// Batching claims into one transaction is refused.
#[test]
fn rejects_two_claims_in_one_transaction() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL, 5 * SOL]);

    let a = claim_ix(
        &ctx,
        &bidders[0].pubkey(),
        sale::constants::JITO_DONT_FRONT,
        sale::constants::INSTRUCTIONS_SYSVAR,
    );
    let b = claim_ix(
        &ctx,
        &bidders[1].pubkey(),
        sale::constants::JITO_DONT_FRONT,
        sale::constants::INSTRUCTIONS_SYSVAR,
    );
    let payer = bidders[0].insecure_clone();
    let signers = [&bidders[1]];
    let err = send_many_as(&mut ctx, &[a, b], &payer, &signers).unwrap_err();
    assert!(err.contains("MultipleOwnInstructions"), "{err}");
}

/// **The rule is narrow, and this test pins the limit rather than hiding it.**
///
/// A claim sitting beside an instruction that targets a *different* program is accepted —
/// the rule only counts instructions targeting this program. That means `[claim, swap]` in
/// one transaction is not blocked, so atomic claim-and-dump by the bidder themselves
/// remains possible. §6.3 chose the narrow rule deliberately; the broader one needs a
/// hardcoded bypass whitelist. What the rule does buy is that no program can CPI-wrap
/// `claim` and no transaction can batch claims.
#[test]
fn atomic_claim_and_dump_is_not_blocked_by_the_narrow_rule() {
    let mut ctx = setup(MintOpts::default(), None);
    let bidders = drive_to_claimable(&mut ctx, &[5 * SOL]);

    let claim = claim_ix(
        &ctx,
        &bidders[0].pubkey(),
        sale::constants::JITO_DONT_FRONT,
        sale::constants::INSTRUCTIONS_SYSVAR,
    );
    // Stands in for the swap an atomic dumper would append.
    let unrelated = Instruction::new_with_bytes(
        anchor_lang::solana_program::system_program::ID,
        &2u32.to_le_bytes().iter().copied().chain(1u64.to_le_bytes()).collect::<Vec<u8>>(),
        vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(bidders[0].pubkey(), true),
            anchor_lang::solana_program::instruction::AccountMeta::new(ctx.payer.pubkey(), false),
        ],
    );
    let payer = bidders[0].insecure_clone();
    send_many_as(&mut ctx, &[claim, unrelated], &payer, &[])
        .expect("the narrow rule must not block unrelated instructions");
    assert!(read_commitment(&ctx, &bidders[0].pubkey()).claimed);
}
