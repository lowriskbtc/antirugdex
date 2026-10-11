//! Phase 0 tests: the vault must be provably safe before anyone may bid.

mod common;

use {anchor_lang::prelude::Pubkey, common::*};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

#[test]
fn accepts_a_clean_vault_and_records_the_terms() {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + 8 * 3_600;
    send_init(&mut ctx, default_params(close)).expect("clean vault should initialize");

    let state = read_sale(&ctx);
    assert_eq!(state.supply_for_sale, SUPPLY);
    assert_eq!(state.hard_cap_lamports, HARD_CAP);
    assert_eq!(state.total_committed, 0);
    assert_eq!(state.status, sale::SaleStatus::Bidding);
    assert_eq!(state.decimals, DECIMALS);
    assert_eq!(state.extension_count, 0);
    assert!(!state.pool_created);

    // The SOL vault must exist and be *exactly* rent-exempt before the first bid.
    // `> 0` would pass whether or not the top-up ran; if it silently did not, the first
    // bid is where you would discover the vault does not exist.
    let expected = ctx.svm.get_sysvar::<anchor_lang::prelude::Rent>().minimum_balance(0);
    assert_eq!(sol_vault_balance(&ctx), expected);
}

// ---------------------------------------------------------------------------
// The one that matters: withheld fees are not sellable supply
// ---------------------------------------------------------------------------

/// Withheld fees are **not part of `base.amount`**, so they neither add to sellable supply
/// nor subtract from it.
///
/// Rewritten 2026-08-09, together with the `vault_spendable_amount` fix. The old version
/// (`withheld_fees_do_not_count_as_supply`) injected `amount = SUPPLY + WITHHELD` — withheld
/// held *inside* `amount` — which the live token program never produces. It passed for the
/// wrong reason, exactly the trap `common/mod.rs`'s own header warns about, and the formula
/// it pinned silently stranded one transfer fee's worth of tokens on every launch.
///
/// The fixture is now the realistic shape: `amount = SUPPLY`, `withheld = WITHHELD` beside
/// it. The name changed with the meaning — under the corrected formula withheld genuinely
/// does not affect spendable supply, which is the opposite of what the old name asserted.
#[test]
fn withheld_fees_are_not_part_of_amount() {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + 8 * 3_600;

    // Declaring `amount + withheld` must fail. Those withheld tokens are real but belong to
    // the mint's withdraw-withheld authority, not to bidders — selling them would surface as
    // *the last claimer's* transaction reverting, invisible unless you drain a full vault.
    let mut greedy = default_params(close);
    greedy.supply_for_sale = VAULT_AMOUNT;
    let err = send_init(&mut ctx, greedy).unwrap_err();
    assert!(err.contains("VaultUnderfunded"), "{err}");

    // One base unit past `amount` must also fail — the boundary, not just the gross.
    let mut over_by_one = default_params(close);
    over_by_one.supply_for_sale = SUPPLY + 1;
    let err = send_init(&mut ctx, over_by_one).unwrap_err();
    assert!(err.contains("VaultUnderfunded"), "{err}");

    // Declaring exactly `amount` succeeds even though `withheld > 0`. This is the assertion
    // the old test could not make: nothing is held back for the fee, so nothing is stranded.
    let mut exact = default_params(close);
    exact.supply_for_sale = SUPPLY;
    send_init(&mut ctx, exact).expect("the full spendable balance must be sellable");
}

// ---------------------------------------------------------------------------
// Hostile vault shapes
// ---------------------------------------------------------------------------

fn vault_with(f: impl Fn(Pubkey) -> VaultOpts + 'static) -> Option<Box<dyn Fn(Pubkey) -> VaultOpts>> {
    Some(Box::new(f))
}

fn clean_vault(owner: Pubkey) -> VaultOpts {
    VaultOpts {
        owner,
        // Matches `setup`'s default: `amount` already net, `withheld` beside it.
        amount: SUPPLY,
        withheld: WITHHELD,
        delegate: None,
        close_authority: None,
        frozen: false,
    }
}

#[test]
fn rejects_vault_not_owned_by_the_sale_pda() {
    let stranger = Pubkey::new_unique();
    let mut ctx = setup(
        MintOpts::default(),
        vault_with(move |_sale| clean_vault(stranger)),
    );
    let close = ctx.now + 8 * 3_600;
    let err = send_init(&mut ctx, default_params(close)).unwrap_err();
    assert!(err.contains("VaultNotProgramOwned"), "{err}");
}

#[test]
fn rejects_vault_with_a_delegate() {
    let d = Pubkey::new_unique();
    let mut ctx = setup(
        MintOpts::default(),
        vault_with(move |sale| VaultOpts { delegate: Some(d), ..clean_vault(sale) }),
    );
    let close = ctx.now + 8 * 3_600;
    let err = send_init(&mut ctx, default_params(close)).unwrap_err();
    assert!(err.contains("VaultHasDelegate"), "{err}");
}

#[test]
fn rejects_vault_with_a_close_authority() {
    let c = Pubkey::new_unique();
    let mut ctx = setup(
        MintOpts::default(),
        vault_with(move |sale| VaultOpts { close_authority: Some(c), ..clean_vault(sale) }),
    );
    let close = ctx.now + 8 * 3_600;
    let err = send_init(&mut ctx, default_params(close)).unwrap_err();
    assert!(err.contains("VaultHasCloseAuthority"), "{err}");
}

#[test]
fn rejects_a_frozen_vault() {
    let mut ctx = setup(
        MintOpts::default(),
        vault_with(move |sale| VaultOpts { frozen: true, ..clean_vault(sale) }),
    );
    let close = ctx.now + 8 * 3_600;
    let err = send_init(&mut ctx, default_params(close)).unwrap_err();
    assert!(err.contains("VaultFrozen"), "{err}");
}

#[test]
fn rejects_an_underfunded_vault() {
    let mut ctx = setup(
        MintOpts::default(),
        vault_with(move |sale| VaultOpts {
            amount: SUPPLY - 1,
            withheld: 0,
            ..clean_vault(sale)
        }),
    );
    let close = ctx.now + 8 * 3_600;
    let err = send_init(&mut ctx, default_params(close)).unwrap_err();
    assert!(err.contains("VaultUnderfunded"), "{err}");
}

// ---------------------------------------------------------------------------
// Mint-level authorities that would make every vault check vacuous
// ---------------------------------------------------------------------------

#[test]
fn rejects_a_mint_with_a_permanent_delegate() {
    let mut ctx = setup(
        MintOpts { permanent_delegate: Some(Pubkey::new_unique()), ..Default::default() },
        None,
    );
    let close = ctx.now + 8 * 3_600;
    let err = send_init(&mut ctx, default_params(close)).unwrap_err();
    assert!(err.contains("MintHasPermanentDelegate"), "{err}");
}

#[test]
fn rejects_a_mint_with_a_transfer_hook() {
    let mut ctx = setup(
        MintOpts { transfer_hook: Some(Pubkey::new_unique()), ..Default::default() },
        None,
    );
    let close = ctx.now + 8 * 3_600;
    let err = send_init(&mut ctx, default_params(close)).unwrap_err();
    assert!(err.contains("MintHasTransferHook"), "{err}");
}

#[test]
fn rejects_a_mint_with_a_close_authority() {
    let mut ctx = setup(
        MintOpts { close_authority: Some(Pubkey::new_unique()), ..Default::default() },
        None,
    );
    let close = ctx.now + 8 * 3_600;
    let err = send_init(&mut ctx, default_params(close)).unwrap_err();
    assert!(err.contains("MintHasCloseAuthority"), "{err}");
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[test]
fn rejects_a_cap_the_supply_cannot_cover() {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + 8 * 3_600;
    let mut p = default_params(close);
    // One lamport more than SUPPLY tokens are worth at PRICE.
    p.hard_cap_lamports = HARD_CAP + 1;
    let err = send_init(&mut ctx, p).unwrap_err();
    assert!(err.contains("CapExceedsSupplyValue"), "{err}");
}

#[test]
fn rejects_a_floor_above_the_cap() {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + 8 * 3_600;
    let mut p = default_params(close);
    p.floor_lamports = HARD_CAP + 1;
    let err = send_init(&mut ctx, p).unwrap_err();
    assert!(err.contains("FloorAboveCap"), "{err}");
}

/// A zero floor can never bind — `total_committed < 0` is unreachable — so "below the
/// floor the sale cancels and refunds everyone" would be dead, and a zero-raise sale
/// would Succeed. `finalize` relies on this being rejected here rather than carrying a
/// special case for it.
#[test]
fn rejects_a_zero_floor() {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + 8 * 3_600;
    let mut p = default_params(close);
    p.floor_lamports = 0;
    let err = send_init(&mut ctx, p).unwrap_err();
    assert!(err.contains("ZeroFloor"), "{err}");
}

#[test]
fn rejects_a_close_in_the_past() {
    let mut ctx = setup(MintOpts::default(), None);
    let past = ctx.now - 1;
    let mut p = default_params(past);
    p.absolute_deadline = ctx.now + 3_600;
    p.pool_deadline = ctx.now + 86_400;
    let err = send_init(&mut ctx, p).unwrap_err();
    assert!(err.contains("CloseInPast"), "{err}");
}

#[test]
fn rejects_a_pool_deadline_before_the_absolute_deadline() {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + 8 * 3_600;
    let mut p = default_params(close);
    p.pool_deadline = p.absolute_deadline;
    let err = send_init(&mut ctx, p).unwrap_err();
    assert!(err.contains("PoolDeadlineTooEarly"), "{err}");
}

/// The extension mechanism must not be arithmetically inert. With
/// `absolute_deadline == close_ts`, `min(now + EXTENSION_SECONDS, absolute_deadline)`
/// can never exceed `close_ts`, so no bid could ever move the close and a locked design
/// decision would quietly be dead code.
#[test]
fn rejects_a_deadline_that_leaves_no_room_to_extend() {
    let mut ctx = setup(MintOpts::default(), None);
    let close = ctx.now + 8 * 3_600;

    let mut p = default_params(close);
    p.absolute_deadline = close;
    p.pool_deadline = close + 86_400;
    let err = send_init(&mut ctx, p).unwrap_err();
    assert!(err.contains("ExtensionWindowTooTight"), "{err}");

    // Exactly one extension's headroom is the boundary, and it is allowed.
    let mut p = default_params(close);
    p.absolute_deadline = close + sale::constants::EXTENSION_SECONDS;
    p.pool_deadline = p.absolute_deadline + 86_400;
    send_init(&mut ctx, p).expect("one extension of headroom should be accepted");
}
