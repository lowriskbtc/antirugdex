use anchor_lang::prelude::*;

use crate::{constants::*, error::SaleError, state::*};

#[derive(Accounts)]
pub struct Bid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,

    #[account(
        mut,
        seeds = [SALE_SEED, sale.token_mint.as_ref()],
        bump = sale.bump,
    )]
    pub sale: Account<'info, Sale>,

    /// Accumulates across repeat bids from the same wallet. Splitting a bid across many
    /// wallets and concentrating it in one are worth exactly the same — that is the
    /// point of pro-rata, and it is why no per-wallet cap exists here.
    #[account(
        init_if_needed,
        payer = bidder,
        space = 8 + Commitment::INIT_SPACE,
        seeds = [COMMIT_SEED, sale.key().as_ref(), bidder.key().as_ref()],
        bump,
    )]
    pub commitment: Account<'info, Commitment>,

    /// CHECK: address fully constrained by seeds; holds lamports and no data.
    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, sale.key().as_ref()],
        bump = sale.sol_vault_bump,
    )]
    pub sol_vault: UncheckedAccount<'info>,

    /// CHECK: a marker, never read or written. Its presence in the account list is the
    /// entire mechanism; see `JITO_DONT_FRONT`.
    #[account(address = JITO_DONT_FRONT @ SaleError::MissingJitoMarker)]
    pub jito_dont_front: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_bid(ctx: Context<Bid>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let sale_key = ctx.accounts.sale.key();

    require!(
        ctx.accounts.sale.status == SaleStatus::Bidding,
        SaleError::SaleNotBidding
    );
    // One check covers both deadlines, but not because initialize said so — `bid` writes
    // `close_ts` further down. It holds because the extension clamps to
    // `min(proposed, absolute_deadline)`, so `close_ts <= absolute_deadline` is preserved
    // across every mutation. `now < close_ts` therefore implies `now < absolute_deadline`.
    // If the clamp is ever removed, this check stops covering the absolute deadline.
    require!(now < ctx.accounts.sale.close_ts, SaleError::BiddingClosed);
    require!(
        amount >= ctx.accounts.sale.min_bid_lamports,
        SaleError::BidBelowMinimum
    );

    // Deliberately NOT capped at `hard_cap_lamports`. Oversubscription is the mechanism,
    // not a failure: everything above the cap is refunded pro-rata from recorded state.
    // Rejecting bids at the cap would restore a race to bid, which is the exact thing
    // this design exists to make worthless.

    anchor_lang::system_program::transfer(
        CpiContext::new(
            anchor_lang::system_program::ID,
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.bidder.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        ),
        amount,
    )?;

    let bidder_key = ctx.accounts.bidder.key();

    // Read *before* the idempotent writes below, which would otherwise make every bid look
    // like the first one. `init_if_needed` zeroes a fresh account, so a default `bidder` is
    // the only reliable signal that this commitment did not exist a moment ago.
    let is_new_commitment = ctx.accounts.commitment.bidder == Pubkey::default();

    let commitment = &mut ctx.accounts.commitment;
    // Idempotent: identical on the first bid and every repeat.
    commitment.sale = sale_key;
    commitment.bidder = bidder_key;
    commitment.bump = ctx.bumps.commitment;
    commitment.amount = commitment
        .amount
        .checked_add(amount)
        .ok_or(SaleError::Overflow)?;

    let sale = &mut ctx.accounts.sale;
    sale.total_committed = sale
        .total_committed
        .checked_add(amount)
        .ok_or(SaleError::Overflow)?;
    if is_new_commitment {
        // Counts wallets, not lamports. `sweep_proceeds` needs it to bound the pro-rata
        // rounding dust before any claim has settled; `burn_unsold` needs it to know when
        // everyone has claimed. See the field docs on `Sale::commitment_count`.
        sale.commitment_count = sale
            .commitment_count
            .checked_add(1)
            .ok_or(SaleError::Overflow)?;
    }

    // ---- Capped activity extension ----
    //
    // A late bid pushes the close out so that a bid landing in the last moments cannot
    // end the sale by surprise. Two independent limits, both live:
    //   1. `MAX_EXTENSIONS` — without it an attacker owns the deadline forever at
    //      minimum-bid cost.
    //   2. `absolute_deadline` — a bound that no amount of activity can cross.
    let remaining = sale
        .close_ts
        .checked_sub(now)
        .ok_or(SaleError::Overflow)?;
    if remaining <= EXTENSION_TRIGGER_SECONDS && sale.extension_count < MAX_EXTENSIONS {
        let proposed = now
            .checked_add(EXTENSION_SECONDS)
            .ok_or(SaleError::Overflow)?;
        let new_close = proposed.min(sale.absolute_deadline);
        // Only counts as an extension if it actually moved the close. Clamping at the
        // absolute deadline must not burn one of the allowed extensions for nothing.
        if new_close > sale.close_ts {
            sale.close_ts = new_close;
            sale.extension_count = sale
                .extension_count
                .checked_add(1)
                .ok_or(SaleError::Overflow)?;
        }
    }

    msg!(
        "bid {} lamports; committed={} total={} close={} ext={}",
        amount,
        commitment.amount,
        sale.total_committed,
        sale.close_ts,
        sale.extension_count
    );
    Ok(())
}
