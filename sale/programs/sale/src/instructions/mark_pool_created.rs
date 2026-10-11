use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{constants::*, error::SaleError, state::*};

/// Proves on-chain that the pool exists and that its LP is fully burned.
///
/// **Permissionless**, and that is the point. Every fact it records is verified from
/// account data, so there is nothing for an authority to attest — and an authority-gated
/// version would let the builder block every claim forever simply by never calling it.
///
/// ## What this verifies
/// - the pool account is owned by the Raydium CPMM program
/// - it really is a `PoolState` (discriminator **and** length)
/// - the pool trades this sale's token, resolved by comparing **both** mint fields
/// - the LP mint matches the pool's `lp_mint` and its **supply is zero**
/// - **`pool_creator` is the sale authority**, and **`open_time <= pool_deadline`**
///
/// ## Why those last two exist — a stranger could otherwise strand every bidder
///
/// CPMM pools are keyed per `amm_config`, so more than one pool can exist for the same
/// mint pair and none of the checks above says *which* pool this is. Without the creator
/// and `open_time` bounds, anyone could point a dust pool with `open_time` ten years out
/// at this sale and mark it. `pool_created` would then be permanently true, which blocks
/// `fail_on_missing_pool` forever (it requires `!pool_created`) while `claim` waits on an
/// `open_time` that never arrives: **every bidder's principal frozen by a third party for
/// the price of a dust pool.** The milder variant is a shill pool with `open_time` in the
/// past, which opens claims before the real pool exists and hands back the sell-side snipe
/// the launch ordering exists to prevent.
///
/// Neither check re-introduces an authority trap. If the authority never creates a pool at
/// all, `fail_on_missing_pool` still fires on `!pool_created` and everyone refunds. The
/// call stays permissionless — only the facts it will accept get stricter.
///
/// ## What this does NOT verify — say so out loud
/// - **Pool depth.** How much liquidity was seeded is not checked; "a pool exists" is not
///   "the pool is deep enough."
/// - **The opening price.** Pre-committed and grader-checked, never enforced here.
/// - **That `open_time` is in the future.** Only that it is not later than `pool_deadline`.
///   A pool already trading is still accepted, and that is deliberate: `mark_pool_created`
///   has to stay callable after `open_time` or a launch where nobody marks in time would
///   block claims forever. Zero float at the pool opening is preserved regardless, because
///   `claim` requires `pool_created`, which cannot have been set before the pool existed.
/// - **That the CPMM program will not be upgraded.** It is upgradeable. The honest claim
///   is "liquidity cannot be pulled under the deployed program."
#[derive(Accounts)]
pub struct MarkPoolCreated<'info> {
    #[account(
        mut,
        seeds = [SALE_SEED, sale.token_mint.as_ref()],
        bump = sale.bump,
    )]
    pub sale: Account<'info, Sale>,

    /// CHECK: owner, discriminator, length and contents are all verified in the handler.
    #[account(owner = RAYDIUM_CPMM_PROGRAM @ SaleError::PoolWrongOwner)]
    pub pool: UncheckedAccount<'info>,

    /// The pool's LP mint. Its `supply` is the only trustworthy evidence of a burn.
    pub lp_mint: InterfaceAccount<'info, Mint>,
}

pub fn handle_mark_pool_created(ctx: Context<MarkPoolCreated>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(!ctx.accounts.sale.pool_created, SaleError::PoolAlreadyCreated);
    require!(
        ctx.accounts.sale.status == SaleStatus::Succeeded,
        SaleError::SaleNotSucceeded
    );
    // Past the deadline the refund path owns the outcome. Without this, a pool created
    // late would race `fail_on_missing_pool` and which one won would depend on ordering.
    require!(
        now < ctx.accounts.sale.pool_deadline,
        SaleError::PoolDeadlinePassed
    );

    let data = ctx.accounts.pool.try_borrow_data()?;
    require!(
        data.len() == POOL_STATE_LEN && data[..8] == POOL_STATE_DISCRIMINATOR,
        SaleError::PoolNotPoolState
    );

    let pool_creator = read_pubkey(&data, POOL_OFF_POOL_CREATOR);
    let token_0_mint = read_pubkey(&data, POOL_OFF_TOKEN_0_MINT);
    let token_1_mint = read_pubkey(&data, POOL_OFF_TOKEN_1_MINT);
    let lp_mint = read_pubkey(&data, POOL_OFF_LP_MINT);
    let open_time = read_u64(&data, POOL_OFF_OPEN_TIME);

    // Binds the pool to this launch. Every other check here is satisfied by *any*
    // correctly-shaped pool for this mint, and anyone may create one.
    require_keys_eq!(
        pool_creator,
        ctx.accounts.sale.authority,
        SaleError::PoolWrongCreator
    );

    // Raydium sorts the mint pair canonically, so the sale token may be either side.
    // Assuming a position inverted a price by nine orders of magnitude during devnet
    // testing; our own pool has the sale token as `token_1`.
    let sale_mint = ctx.accounts.sale.token_mint;
    require!(
        token_0_mint == sale_mint || token_1_mint == sale_mint,
        SaleError::PoolMintMismatch
    );

    require_keys_eq!(
        ctx.accounts.lp_mint.key(),
        lp_mint,
        SaleError::PoolLpMintMismatch
    );

    // Read the LP *mint's* supply, never `PoolState.lp_supply`.
    //
    // That field is stale after a burn: our devnet pool reports `lp_supply` of
    // 315,832,233,947 while the mint's actual supply is 0. Checking the pool field would
    // have rejected our own correctly-burned launch, and trusting it in the other
    // direction would report live LP that does not exist.
    require!(ctx.accounts.lp_mint.supply == 0, SaleError::LpNotBurned);

    drop(data);

    let open_time = i64::try_from(open_time).map_err(|_| SaleError::Overflow)?;
    // `claim` waits for `open_time`, so an unbounded one is an indefinite freeze on every
    // bidder's principal. Bounding it at `pool_deadline` costs a real launch nothing —
    // marking already has to happen before that deadline — and guarantees claims open no
    // later than the point at which the refund path would otherwise have taken over.
    require!(
        open_time <= ctx.accounts.sale.pool_deadline,
        SaleError::PoolOpensTooLate
    );

    let sale = &mut ctx.accounts.sale;
    sale.pool = ctx.accounts.pool.key();
    sale.pool_open_time = open_time;
    sale.pool_created = true;

    msg!(
        "pool {} verified: lp burned, opens at {}",
        sale.pool,
        sale.pool_open_time
    );
    Ok(())
}

fn read_pubkey(data: &[u8], off: usize) -> Pubkey {
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&data[off..off + 32]);
    Pubkey::new_from_array(buf)
}

fn read_u64(data: &[u8], off: usize) -> u64 {
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[off..off + 8]);
    u64::from_le_bytes(buf)
}
