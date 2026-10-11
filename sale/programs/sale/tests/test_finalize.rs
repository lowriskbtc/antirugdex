//! Phase 2 tests: settlement against the floor, and the abandonment recovery path.
//!
//! Both instructions are permissionless. Every test here settles from a wallet that is
//! neither the sale authority nor a bidder, because "anyone can settle" is the property
//! that keeps principal from being trapped.

mod common;

use common::*;

const WINDOW: i64 = 8 * 3_600;

fn open_sale() -> (Ctx, i64) {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + WINDOW;
    let mut p = default_params(close);
    p.absolute_deadline = close + 7_200;
    p.pool_deadline = p.absolute_deadline + 86_400;
    send_init(&mut ctx, p).expect("sale should open");
    (ctx, close)
}

/// A wallet with no role in the sale at all.
fn stranger(ctx: &mut Ctx) -> solana_keypair::Keypair {
    new_bidder(ctx, 1_000_000_000)
}

// ---------------------------------------------------------------------------
// Settling against the floor
// ---------------------------------------------------------------------------

#[test]
fn a_stranger_can_finalize_a_sale_that_met_the_floor() {
    let (mut ctx, close) = open_sale();
    let bidder = new_bidder(&mut ctx, 100_000_000_000);
    send_bid(&mut ctx, &bidder, FLOOR).unwrap();

    set_clock(&mut ctx, close);
    let outsider = stranger(&mut ctx);
    send_finalize(&mut ctx, &outsider).expect("anyone should be able to finalize");

    let state = read_sale(&ctx);
    assert_eq!(state.status, sale::SaleStatus::Succeeded);
    assert_eq!(state.total_committed, FLOOR);
}

#[test]
fn fails_a_sale_one_lamport_below_the_floor() {
    let (mut ctx, close) = open_sale();
    let bidder = new_bidder(&mut ctx, 100_000_000_000);
    send_bid(&mut ctx, &bidder, FLOOR - 1).unwrap();

    set_clock(&mut ctx, close);
    let outsider = stranger(&mut ctx);
    send_finalize(&mut ctx, &outsider).unwrap();

    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Failed);
}

/// The degenerate case §6.5 calls out. It needs no special branch: `floor > 0` is
/// enforced at initialize, so a zero raise is necessarily below the floor.
#[test]
fn fails_a_sale_with_no_bids_at_all() {
    let (mut ctx, close) = open_sale();
    set_clock(&mut ctx, close);
    let outsider = stranger(&mut ctx);
    send_finalize(&mut ctx, &outsider).unwrap();

    let state = read_sale(&ctx);
    assert_eq!(state.status, sale::SaleStatus::Failed);
    assert_eq!(state.total_committed, 0);
}

/// That commitments can exceed the cap is already pinned in the bid suite. The fact worth
/// having here is the settlement outcome: oversubscription reaches `Succeeded`, it is not
/// an error state. The excess becomes pro-rata refunds at claim time.
#[test]
fn succeeds_when_oversubscribed_past_the_cap() {
    let (mut ctx, close) = open_sale();
    let whale = new_bidder(&mut ctx, HARD_CAP * 3);
    send_bid(&mut ctx, &whale, HARD_CAP).unwrap();
    send_bid(&mut ctx, &whale, HARD_CAP).unwrap();

    set_clock(&mut ctx, close);
    let outsider = stranger(&mut ctx);
    send_finalize(&mut ctx, &outsider).unwrap();

    let state = read_sale(&ctx);
    assert_eq!(state.status, sale::SaleStatus::Succeeded);
    assert!(state.total_committed > state.hard_cap_lamports);
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

#[test]
fn rejects_finalize_while_bidding_is_open() {
    let (mut ctx, close) = open_sale();
    set_clock(&mut ctx, close - 1);
    let outsider = stranger(&mut ctx);
    let err = send_finalize(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("SaleStillOpen"), "{err}");
}

/// `finalize` must read the *current* `close_ts`, not the one set at initialize. A late
/// bid that extends the close has to postpone settlement too, or the extension would be
/// cosmetic.
#[test]
fn an_extended_close_postpones_finalize() {
    let (mut ctx, close) = open_sale();
    let bidder = new_bidder(&mut ctx, 100_000_000_000);

    // Bid inside the trigger window so the close moves.
    let t = close - 1;
    set_clock(&mut ctx, t);
    send_bid(&mut ctx, &bidder, FLOOR).unwrap();
    let extended = read_sale(&ctx).close_ts;
    assert_eq!(extended, t + sale::constants::EXTENSION_SECONDS);

    // At the *original* close, settlement is now premature.
    set_clock(&mut ctx, close);
    let outsider = stranger(&mut ctx);
    let err = send_finalize(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("SaleStillOpen"), "{err}");

    // At the extended close it goes through.
    set_clock(&mut ctx, extended);
    send_finalize(&mut ctx, &outsider).expect("should settle at the extended close");
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Succeeded);
}

#[test]
fn rejects_a_second_finalize() {
    let (mut ctx, close) = open_sale();
    let bidder = new_bidder(&mut ctx, 100_000_000_000);
    send_bid(&mut ctx, &bidder, FLOOR).unwrap();

    set_clock(&mut ctx, close);
    let outsider = stranger(&mut ctx);
    send_finalize(&mut ctx, &outsider).unwrap();
    let err = send_finalize(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("SaleAlreadyFinalized"), "{err}");
}

/// After settlement no bid is accepted, and this pins *which* check refuses it.
///
/// Both guards are true at this point — the clock is at `close_ts` and the status is no
/// longer `Bidding` — so the assertion depends on order, and in `bid` the status check
/// comes first. That makes `SaleNotBidding` the observed error and this test real
/// coverage of the status guard; `BiddingClosed` is covered separately by
/// `rejects_a_bid_after_the_close`.
///
/// Asserting `SaleNotBidding || BiddingClosed` would pass whichever guard fired, and so
/// would pass even if one were deleted. Name the one that actually fires.
#[test]
fn no_bids_are_accepted_after_finalize() {
    let (mut ctx, close) = open_sale();
    let bidder = new_bidder(&mut ctx, 100_000_000_000);
    send_bid(&mut ctx, &bidder, FLOOR).unwrap();

    set_clock(&mut ctx, close);
    let outsider = stranger(&mut ctx);
    send_finalize(&mut ctx, &outsider).unwrap();

    let err = send_bid(&mut ctx, &bidder, MIN_BID).unwrap_err();
    assert!(err.contains("SaleNotBidding"), "{err}");
}

// ---------------------------------------------------------------------------
// Abandonment recovery
// ---------------------------------------------------------------------------

#[test]
fn rejects_pool_failure_before_the_deadline() {
    let (mut ctx, close) = open_sale();
    let bidder = new_bidder(&mut ctx, 100_000_000_000);
    send_bid(&mut ctx, &bidder, FLOOR).unwrap();
    set_clock(&mut ctx, close);
    let outsider = stranger(&mut ctx);
    send_finalize(&mut ctx, &outsider).unwrap();

    let deadline = read_sale(&ctx).pool_deadline;
    set_clock(&mut ctx, deadline - 1);
    let err = send_fail_on_missing_pool(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("PoolDeadlineNotReached"), "{err}");
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Succeeded);
}

#[test]
fn a_stranger_can_fail_a_succeeded_sale_with_no_pool() {
    let (mut ctx, close) = open_sale();
    let bidder = new_bidder(&mut ctx, 100_000_000_000);
    send_bid(&mut ctx, &bidder, FLOOR).unwrap();
    set_clock(&mut ctx, close);
    let outsider = stranger(&mut ctx);
    send_finalize(&mut ctx, &outsider).unwrap();
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Succeeded);

    let deadline = read_sale(&ctx).pool_deadline;
    set_clock(&mut ctx, deadline);
    send_fail_on_missing_pool(&mut ctx, &outsider).expect("recovery should be permissionless");
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Failed);
}

/// The abandonment case this exists for: the builder vanishes *before* finalizing, so the
/// sale is still `Bidding` when the pool deadline passes. One call from anyone must land
/// in `Failed` — requiring `finalize` first would make recovery order-dependent, which is
/// the opposite of self-executing.
#[test]
fn recovers_straight_from_bidding_without_finalize_ever_running() {
    let (mut ctx, _close) = open_sale();
    let bidder = new_bidder(&mut ctx, 100_000_000_000);
    send_bid(&mut ctx, &bidder, FLOOR).unwrap();
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Bidding);

    let deadline = read_sale(&ctx).pool_deadline;
    set_clock(&mut ctx, deadline);
    let outsider = stranger(&mut ctx);
    send_fail_on_missing_pool(&mut ctx, &outsider)
        .expect("recovery must not depend on finalize having run");
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Failed);
}

#[test]
fn rejects_pool_failure_on_an_already_failed_sale() {
    let (mut ctx, close) = open_sale();
    set_clock(&mut ctx, close);
    let outsider = stranger(&mut ctx);
    send_finalize(&mut ctx, &outsider).unwrap(); // no bids -> Failed

    let deadline = read_sale(&ctx).pool_deadline;
    set_clock(&mut ctx, deadline);
    let err = send_fail_on_missing_pool(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("SaleAlreadyFinalized"), "{err}");
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Failed);
}
