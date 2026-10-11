use anchor_lang::prelude::*;

use crate::{constants::*, error::SaleError, state::*};

/// Phase 2. **Permissionless by design.**
///
/// An authority-gated finalize traps principal: if the only key that can close the sale
/// goes away, nobody can claim and nobody can refund. Anyone may call this, and the
/// outcome is a pure function of recorded state, so there is nothing to gate.
#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(
        mut,
        seeds = [SALE_SEED, sale.token_mint.as_ref()],
        bump = sale.bump,
    )]
    pub sale: Account<'info, Sale>,
}

pub fn handle_finalize(ctx: Context<Finalize>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let sale = &mut ctx.accounts.sale;

    require!(
        sale.status == SaleStatus::Bidding,
        SaleError::SaleAlreadyFinalized
    );
    // `close_ts` may have been pushed out by the activity extension, so this reads the
    // current value rather than anything decided at initialize.
    require!(now >= sale.close_ts, SaleError::SaleStillOpen);

    // `floor_lamports > 0` is enforced at initialize, so a zero raise necessarily lands
    // here as Failed. One comparison, no special case.
    sale.status = if sale.total_committed < sale.floor_lamports {
        SaleStatus::Failed
    } else {
        SaleStatus::Succeeded
    };

    msg!(
        "finalized: total={} floor={} status={:?}",
        sale.total_committed,
        sale.floor_lamports,
        sale.status
    );
    Ok(())
}

/// The abandonment recovery path. **Permissionless, and deliberately order-independent.**
///
/// If the pool does not exist by `pool_deadline`, anyone may flip the sale to `Failed`,
/// which turns every claim into a full refund. This accepts both `Bidding` and
/// `Succeeded`: if the builder disappeared *before* finalizing, requiring `Succeeded`
/// would mean recovery needed someone to call `finalize` first — and "you must make two
/// calls in the right order" is the opposite of self-executing.
///
/// Safe against double-paying only because of the invariant documented on
/// `Sale::pool_created`: this requires `!pool_created` and `claim` requires
/// `pool_created`, so no token can have been claimed before this runs.
#[derive(Accounts)]
pub struct FailOnMissingPool<'info> {
    #[account(
        mut,
        seeds = [SALE_SEED, sale.token_mint.as_ref()],
        bump = sale.bump,
    )]
    pub sale: Account<'info, Sale>,
}

pub fn handle_fail_on_missing_pool(ctx: Context<FailOnMissingPool>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let sale = &mut ctx.accounts.sale;

    require!(!sale.pool_created, SaleError::PoolAlreadyCreated);
    require!(
        now >= sale.pool_deadline,
        SaleError::PoolDeadlineNotReached
    );
    require!(
        sale.status == SaleStatus::Bidding || sale.status == SaleStatus::Succeeded,
        SaleError::SaleAlreadyFinalized
    );

    sale.status = SaleStatus::Failed;

    msg!(
        "pool deadline missed at {}; sale failed, claims are full refunds",
        now
    );
    Ok(())
}
