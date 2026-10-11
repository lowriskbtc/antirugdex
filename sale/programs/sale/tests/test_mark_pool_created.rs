//! Proving the pool on-chain: it exists, it trades our token, and its LP is burned.
//!
//! The `PoolState` images here are built from the byte layout read off the live devnet
//! pool `6zKJcfz…`, so a Raydium layout change breaks these tests rather than production.

mod common;

use common::*;

const WINDOW: i64 = 8 * 3_600;

/// A sale that reached `Succeeded`, ready for a pool.
fn succeeded_sale() -> Ctx {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + WINDOW;
    let mut p = default_params(close);
    p.absolute_deadline = close + 7_200;
    p.pool_deadline = p.absolute_deadline + 86_400;
    send_init(&mut ctx, p).expect("sale should open");

    let bidder = new_bidder(&mut ctx, 100_000_000_000);
    send_bid(&mut ctx, &bidder, FLOOR).unwrap();
    set_clock(&mut ctx, close);
    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    send_finalize(&mut ctx, &outsider).unwrap();
    ctx
}

fn pool_for(ctx: &Ctx, lp_mint: Pubkey, lp_supply: u64, open_time: u64) -> PoolOpts {
    PoolOpts {
        // `send_init` opens the sale with `ctx.payer` as authority, so this is the pool
        // the builder created rather than one a stranger created for the same mint pair.
        creator: ctx.payer.pubkey(),
        lp_mint,
        // Our own devnet pool sorts the sale token into token_1, with WSOL as token_0.
        token_0_mint: Pubkey::new_unique(),
        token_1_mint: ctx.mint,
        open_time,
        lp_supply,
    }
}

use anchor_lang::prelude::Pubkey;

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

#[test]
fn a_stranger_can_prove_a_burned_pool() {
    let mut ctx = succeeded_sale();
    let open_time = (ctx.now + 20_000) as u64;
    let lp = install_lp_mint(&mut ctx, 0);
    // `lp_supply` in pool state is deliberately non-zero and stale — exactly what our
    // real devnet pool looks like after the burn. The program must ignore it.
    let opts = pool_for(&ctx, lp, 315_832_233_947, open_time);
    let pool = install_pool(&mut ctx, &opts);

    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    send_mark_pool_created(&mut ctx, &outsider, pool, lp)
        .expect("anyone should be able to prove the pool");

    let state = read_sale(&ctx);
    assert!(state.pool_created);
    assert_eq!(state.pool, pool);
    assert_eq!(state.pool_open_time, open_time as i64);
}

/// The sale token may be on either side of the canonically sorted pair. Assuming a
/// position inverted a price by nine orders of magnitude during devnet testing.
#[test]
fn accepts_the_sale_token_as_either_side_of_the_pair() {
    for sale_is_token_0 in [true, false] {
        let mut ctx = succeeded_sale();
        let lp = install_lp_mint(&mut ctx, 0);
        let opts = PoolOpts {
            creator: ctx.payer.pubkey(),
            lp_mint: lp,
            token_0_mint: if sale_is_token_0 { ctx.mint } else { Pubkey::new_unique() },
            token_1_mint: if sale_is_token_0 { Pubkey::new_unique() } else { ctx.mint },
            open_time: (ctx.now + 20_000) as u64,
            lp_supply: 1,
        };
        let pool = install_pool(&mut ctx, &opts);
        let outsider = new_bidder(&mut ctx, 1_000_000_000);
        send_mark_pool_created(&mut ctx, &outsider, pool, lp)
            .unwrap_or_else(|e| panic!("token_0={sale_is_token_0}: {e}"));
        assert!(read_sale(&ctx).pool_created);
    }
}

// ---------------------------------------------------------------------------
// Counterfeit pools
// ---------------------------------------------------------------------------

#[test]
fn rejects_a_pool_not_owned_by_raydium() {
    let mut ctx = succeeded_sale();
    let lp = install_lp_mint(&mut ctx, 0);
    let opts = pool_for(&ctx, lp, 0, (ctx.now + 20_000) as u64);

    // Same bytes, wrong owner.
    let impostor = Pubkey::new_unique();
    let data = build_pool(&opts);
    ctx.svm
        .set_account(
            impostor,
            solana_account::Account {
                lamports: 10_000_000,
                data,
                owner: Pubkey::new_unique(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    let err = send_mark_pool_created(&mut ctx, &outsider, impostor, lp).unwrap_err();
    // Names the one error that should fire. A `PoolWrongOwner || ConstraintOwner`
    // disjunction would pass even if the custom error mapping were never applied.
    assert!(err.contains("PoolWrongOwner"), "{err}");
}

#[test]
fn rejects_an_account_that_is_not_pool_state() {
    let mut ctx = succeeded_sale();
    let lp = install_lp_mint(&mut ctx, 0);
    let opts = pool_for(&ctx, lp, 0, (ctx.now + 20_000) as u64);

    // Right owner and length, wrong discriminator.
    let mut data = build_pool(&opts);
    data[0] ^= 0xff;
    let fake = Pubkey::new_unique();
    ctx.svm
        .set_account(
            fake,
            solana_account::Account {
                lamports: 10_000_000,
                data,
                owner: sale::constants::RAYDIUM_CPMM_PROGRAM,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    let err = send_mark_pool_created(&mut ctx, &outsider, fake, lp).unwrap_err();
    assert!(err.contains("PoolNotPoolState"), "{err}");
}

#[test]
fn rejects_a_pool_that_does_not_trade_our_token() {
    let mut ctx = succeeded_sale();
    let lp = install_lp_mint(&mut ctx, 0);
    let opts = PoolOpts {
        creator: ctx.payer.pubkey(),
        lp_mint: lp,
        token_0_mint: Pubkey::new_unique(),
        token_1_mint: Pubkey::new_unique(),
        open_time: (ctx.now + 20_000) as u64,
        lp_supply: 0,
    };
    let pool = install_pool(&mut ctx, &opts);
    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    let err = send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap_err();
    assert!(err.contains("PoolMintMismatch"), "{err}");
}

#[test]
fn rejects_an_lp_mint_that_is_not_the_pools() {
    let mut ctx = succeeded_sale();
    let real_lp = install_lp_mint(&mut ctx, 12_345); // pool's LP, not burned
    let decoy_lp = install_lp_mint(&mut ctx, 0); // a different, empty mint
    let opts = pool_for(&ctx, real_lp, 0, (ctx.now + 20_000) as u64);
    let pool = install_pool(&mut ctx, &opts);

    // Passing an unrelated zero-supply mint must not satisfy the burn check.
    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    let err = send_mark_pool_created(&mut ctx, &outsider, pool, decoy_lp).unwrap_err();
    assert!(err.contains("PoolLpMintMismatch"), "{err}");
}

/// The burn check reads the LP **mint's** supply. `PoolState.lp_supply` is stale after a
/// burn — our live pool reports 315,832,233,947 with an actual supply of 0 — so the two
/// must never be confused in either direction.
#[test]
fn rejects_a_pool_whose_lp_is_still_live() {
    let mut ctx = succeeded_sale();
    let lp = install_lp_mint(&mut ctx, 1); // one unburned LP token
    // Pool state claims zero, which would pass a naive check.
    let opts = pool_for(&ctx, lp, 0, (ctx.now + 20_000) as u64);
    let pool = install_pool(&mut ctx, &opts);

    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    let err = send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap_err();
    assert!(err.contains("LpNotBurned"), "{err}");
}

/// **The hostile-pool hole, closed from the creator side.**
///
/// CPMM pools are keyed per `amm_config`, so anyone may create a second, unrelated pool
/// for the same mint pair. Every other check here passes on such a pool: right owner,
/// right discriminator, trades our token, LP burned. Only `pool_creator` distinguishes the
/// launch pool from a stranger's.
#[test]
fn rejects_a_pool_created_by_a_stranger() {
    let mut ctx = succeeded_sale();
    let lp = install_lp_mint(&mut ctx, 0);
    let mut opts = pool_for(&ctx, lp, 0, (ctx.now + 20_000) as u64);
    opts.creator = Pubkey::new_unique();
    let pool = install_pool(&mut ctx, &opts);

    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    let err = send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap_err();
    assert!(err.contains("PoolWrongCreator"), "{err}");
}

/// **The same hole, closed from the `open_time` side.**
///
/// `claim` waits for `pool_open_time`, and `pool_created` permanently blocks
/// `fail_on_missing_pool`. A pool that opens after the pool deadline would therefore
/// freeze every bidder's principal with no recovery path at all — the abandonment escape
/// hatch disabled by the very fact that a pool exists. Bounding `open_time` at
/// `pool_deadline` guarantees claims open no later than the point the refund path would
/// otherwise have taken over.
#[test]
fn rejects_a_pool_that_opens_after_the_pool_deadline() {
    let mut ctx = succeeded_sale();
    let deadline = read_sale(&ctx).pool_deadline;
    let lp = install_lp_mint(&mut ctx, 0);
    let opts = pool_for(&ctx, lp, 0, (deadline + 1) as u64);
    let pool = install_pool(&mut ctx, &opts);

    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    let err = send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap_err();
    assert!(err.contains("PoolOpensTooLate"), "{err}");

    // The recovery path is still live precisely because the mark was refused.
    set_clock(&mut ctx, deadline + 1);
    send_fail_on_missing_pool(&mut ctx, &outsider).unwrap();
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Failed);
}

/// The bound is `<=`, not `<`: a pool opening exactly on the deadline is legitimate.
#[test]
fn accepts_a_pool_that_opens_exactly_on_the_pool_deadline() {
    let mut ctx = succeeded_sale();
    let deadline = read_sale(&ctx).pool_deadline;
    let lp = install_lp_mint(&mut ctx, 0);
    let opts = pool_for(&ctx, lp, 0, deadline as u64);
    let pool = install_pool(&mut ctx, &opts);

    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap();
    assert_eq!(read_sale(&ctx).pool_open_time, deadline);
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

#[test]
fn rejects_proving_a_pool_twice() {
    let mut ctx = succeeded_sale();
    let lp = install_lp_mint(&mut ctx, 0);
    let opts = pool_for(&ctx, lp, 0, (ctx.now + 20_000) as u64);
    let pool = install_pool(&mut ctx, &opts);
    let outsider = new_bidder(&mut ctx, 1_000_000_000);

    send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap();
    let err = send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap_err();
    assert!(err.contains("PoolAlreadyCreated"), "{err}");
}

#[test]
fn rejects_a_pool_on_a_sale_that_has_not_succeeded() {
    // Never finalized: still Bidding.
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + WINDOW;
    let mut p = default_params(close);
    p.absolute_deadline = close + 7_200;
    p.pool_deadline = p.absolute_deadline + 86_400;
    send_init(&mut ctx, p).unwrap();

    let lp = install_lp_mint(&mut ctx, 0);
    let opts = pool_for(&ctx, lp, 0, (ctx.now + 20_000) as u64);
    let pool = install_pool(&mut ctx, &opts);
    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    let err = send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap_err();
    assert!(err.contains("SaleNotSucceeded"), "{err}");
}

/// Past `pool_deadline` the refund path owns the outcome. Without this the two paths would
/// race and the winner would depend on transaction ordering.
#[test]
fn rejects_a_pool_proven_after_the_deadline() {
    let mut ctx = succeeded_sale();
    let lp = install_lp_mint(&mut ctx, 0);
    let opts = pool_for(&ctx, lp, 0, (ctx.now + 20_000) as u64);
    let pool = install_pool(&mut ctx, &opts);

    let deadline = read_sale(&ctx).pool_deadline;
    set_clock(&mut ctx, deadline);
    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    let err = send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap_err();
    assert!(err.contains("PoolDeadlinePassed"), "{err}");
}

/// The two halves of the `pool_created` invariant, from the other side: once a pool is
/// proven, the abandonment path can no longer flip the sale to `Failed`. Otherwise early
/// claimers could keep tokens while everyone else refunded.
#[test]
fn a_proven_pool_blocks_the_abandonment_path_forever() {
    let mut ctx = succeeded_sale();
    let lp = install_lp_mint(&mut ctx, 0);
    let opts = pool_for(&ctx, lp, 0, (ctx.now + 20_000) as u64);
    let pool = install_pool(&mut ctx, &opts);
    let outsider = new_bidder(&mut ctx, 1_000_000_000);
    send_mark_pool_created(&mut ctx, &outsider, pool, lp).unwrap();

    let deadline = read_sale(&ctx).pool_deadline;
    set_clock(&mut ctx, deadline + 1);
    let err = send_fail_on_missing_pool(&mut ctx, &outsider).unwrap_err();
    assert!(err.contains("PoolAlreadyCreated"), "{err}");
    assert_eq!(read_sale(&ctx).status, sale::SaleStatus::Succeeded);
}
