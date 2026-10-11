//! Phase 1 tests: irrevocable deposits, and the two limits on the activity extension.

mod common;

use {anchor_lang::prelude::Pubkey, common::*};

const WINDOW: i64 = 8 * 3_600;

/// An open sale with a generous absolute deadline, so the *count cap* is what binds.
fn open_sale() -> (Ctx, i64) {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + WINDOW;
    let mut p = default_params(close);
    p.absolute_deadline = close + 7_200;
    p.pool_deadline = p.absolute_deadline + 86_400;
    send_init(&mut ctx, p).expect("sale should open");
    (ctx, close)
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

#[test]
fn records_a_bid_and_moves_the_lamports() {
    let (mut ctx, _close) = open_sale();
    let vault_before = sol_vault_balance(&ctx);
    let bidder = new_bidder(&mut ctx, 10_000_000_000);
    let bidder_before = balance(&ctx, &bidder.pubkey());

    send_bid(&mut ctx, &bidder, 1_000_000_000).expect("bid should be accepted");

    assert_eq!(read_sale(&ctx).total_committed, 1_000_000_000);
    let c = read_commitment(&ctx, &bidder.pubkey());
    assert_eq!(c.amount, 1_000_000_000);
    assert_eq!(c.bidder, bidder.pubkey());
    assert_eq!(c.sale, ctx.sale_key);
    assert!(!c.claimed);

    // Two-sided accounting. Asserting only that the vault grew would also pass if the
    // lamports arrived from somewhere else; pairing it with the bidder's debit is what
    // would catch a swapped `from`/`to`. The bidder also pays the fee and the
    // Commitment PDA's rent, hence `>=`.
    assert_eq!(sol_vault_balance(&ctx), vault_before + 1_000_000_000);
    assert!(balance(&ctx, &bidder.pubkey()) <= bidder_before - 1_000_000_000);
}

#[test]
fn accumulates_repeat_bids_into_one_commitment() {
    let (mut ctx, _close) = open_sale();
    let bidder = new_bidder(&mut ctx, 10_000_000_000);

    send_bid(&mut ctx, &bidder, 1_000_000_000).unwrap();
    send_bid(&mut ctx, &bidder, 2_000_000_000).unwrap();

    assert_eq!(read_commitment(&ctx, &bidder.pubkey()).amount, 3_000_000_000);
    assert_eq!(read_sale(&ctx).total_committed, 3_000_000_000);
}

/// The property the whole mechanism exists for: one wallet bidding 2X and two wallets
/// bidding X each produce identical state, so splitting is worth exactly nothing.
#[test]
fn splitting_across_wallets_changes_nothing() {
    let (mut ctx_a, _) = open_sale();
    let solo = new_bidder(&mut ctx_a, 10_000_000_000);
    send_bid(&mut ctx_a, &solo, 2_000_000_000).unwrap();

    let (mut ctx_b, _) = open_sale();
    let split_1 = new_bidder(&mut ctx_b, 10_000_000_000);
    let split_2 = new_bidder(&mut ctx_b, 10_000_000_000);
    send_bid(&mut ctx_b, &split_1, 1_000_000_000).unwrap();
    send_bid(&mut ctx_b, &split_2, 1_000_000_000).unwrap();

    assert_eq!(
        read_sale(&ctx_a).total_committed,
        read_sale(&ctx_b).total_committed
    );
}

/// Oversubscription is the mechanism, not a failure. Bids past the cap are accepted and
/// the excess is refunded pro-rata later; rejecting at the cap would restore a race.
#[test]
fn accepts_commitments_beyond_the_hard_cap() {
    let (mut ctx, _close) = open_sale();
    let whale = new_bidder(&mut ctx, HARD_CAP * 3);

    send_bid(&mut ctx, &whale, HARD_CAP).unwrap();
    send_bid(&mut ctx, &whale, HARD_CAP).unwrap();

    let state = read_sale(&ctx);
    assert_eq!(state.total_committed, HARD_CAP * 2);
    assert!(state.total_committed > state.hard_cap_lamports);
}

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

#[test]
fn rejects_a_bid_below_the_minimum() {
    let (mut ctx, _close) = open_sale();
    let bidder = new_bidder(&mut ctx, 10_000_000_000);
    let err = send_bid(&mut ctx, &bidder, MIN_BID - 1).unwrap_err();
    assert!(err.contains("BidBelowMinimum"), "{err}");
}

#[test]
fn rejects_a_bid_after_the_close() {
    let (mut ctx, close) = open_sale();
    let bidder = new_bidder(&mut ctx, 10_000_000_000);
    set_clock(&mut ctx, close);
    let err = send_bid(&mut ctx, &bidder, MIN_BID).unwrap_err();
    assert!(err.contains("BiddingClosed"), "{err}");
}

#[test]
fn rejects_a_bid_without_the_jito_marker() {
    let (mut ctx, _close) = open_sale();
    let bidder = new_bidder(&mut ctx, 10_000_000_000);
    let err =
        send_bid_with_marker(&mut ctx, &bidder, MIN_BID, Pubkey::new_unique()).unwrap_err();
    assert!(err.contains("MissingJitoMarker"), "{err}");
}

// ---------------------------------------------------------------------------
// The activity extension — both limits must actually bind
// ---------------------------------------------------------------------------

#[test]
fn a_late_bid_extends_the_close_by_exactly_one_window() {
    let (mut ctx, close) = open_sale();
    let bidder = new_bidder(&mut ctx, 10_000_000_000);

    // Comfortably before the trigger window: no extension.
    set_clock(&mut ctx, close - sale::constants::EXTENSION_TRIGGER_SECONDS - 60);
    send_bid(&mut ctx, &bidder, MIN_BID).unwrap();
    let state = read_sale(&ctx);
    assert_eq!(state.extension_count, 0);
    assert_eq!(state.close_ts, close);

    // Inside the window: exactly one extension, to a value we can name.
    let t = close - 1;
    set_clock(&mut ctx, t);
    send_bid(&mut ctx, &bidder, MIN_BID).unwrap();
    let state = read_sale(&ctx);
    assert_eq!(state.extension_count, 1);
    assert_eq!(state.close_ts, t + sale::constants::EXTENSION_SECONDS);
}

/// Limit 1: the count cap. Without it an attacker owns the deadline forever at
/// minimum-bid cost.
#[test]
fn extensions_stop_at_the_count_cap() {
    let (mut ctx, close) = open_sale();
    let bidder = new_bidder(&mut ctx, 100_000_000_000);

    let mut expected_close = close;
    for _ in 0..sale::constants::MAX_EXTENSIONS {
        let t = expected_close - 1;
        set_clock(&mut ctx, t);
        send_bid(&mut ctx, &bidder, MIN_BID).unwrap();
        expected_close = t + sale::constants::EXTENSION_SECONDS;
        assert_eq!(read_sale(&ctx).close_ts, expected_close);
    }
    let state = read_sale(&ctx);
    assert_eq!(state.extension_count, sale::constants::MAX_EXTENSIONS);
    // The absolute deadline is 7200s out and was never reached, so the cap is what bound.
    assert!(state.close_ts < state.absolute_deadline);

    // One more bid inside the window: accepted, but the close no longer moves.
    let t = expected_close - 1;
    set_clock(&mut ctx, t);
    send_bid(&mut ctx, &bidder, MIN_BID).unwrap();
    let after = read_sale(&ctx);
    assert_eq!(after.extension_count, sale::constants::MAX_EXTENSIONS);
    assert_eq!(after.close_ts, expected_close);
}

/// Limit 2: the absolute deadline. Configured tight, it binds long before the count cap,
/// and a clamped no-op must not burn one of the allowed extensions.
#[test]
fn the_absolute_deadline_binds_before_the_count_cap() {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + WINDOW;
    let deadline = close + sale::constants::EXTENSION_SECONDS; // exactly one window
    let mut p = default_params(close);
    p.absolute_deadline = deadline;
    p.pool_deadline = deadline + 86_400;
    send_init(&mut ctx, p).expect("sale should open");

    let bidder = new_bidder(&mut ctx, 100_000_000_000);

    // Each late bid pushes the close, but never past the absolute deadline.
    for _ in 0..4 {
        let t = read_sale(&ctx).close_ts - 1;
        set_clock(&mut ctx, t);
        send_bid(&mut ctx, &bidder, MIN_BID).unwrap();
        assert!(read_sale(&ctx).close_ts <= deadline);
    }

    let state = read_sale(&ctx);
    assert_eq!(state.close_ts, deadline, "close should pin to the absolute deadline");
    // The deadline bound, not the count cap.
    assert!(
        state.extension_count < sale::constants::MAX_EXTENSIONS,
        "count cap should not be what stopped it (was {})",
        state.extension_count
    );

    // The boundary itself: once the close has pinned to the absolute deadline, a bid at
    // exactly that instant must be refused. This is the only state in which `close_ts`
    // and `absolute_deadline` are equal, so it is the only place the single
    // `now < close_ts` check has to carry the absolute deadline on its own.
    set_clock(&mut ctx, deadline);
    let err = send_bid(&mut ctx, &bidder, MIN_BID).unwrap_err();
    assert!(err.contains("BiddingClosed"), "{err}");
}
