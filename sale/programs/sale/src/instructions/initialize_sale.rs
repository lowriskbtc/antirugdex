use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_interface::{get_mint_extension_data, Mint, TokenAccount, TokenInterface};
use spl_token_2022::extension::{
    mint_close_authority::MintCloseAuthority, permanent_delegate::PermanentDelegate,
    transfer_fee::TransferFeeAmount, transfer_hook::TransferHook, BaseStateWithExtensions,
    StateWithExtensions,
};
use spl_token_2022::state::AccountState;

use crate::{constants::*, error::SaleError, state::*};

/// Everything the sale needs, decided before anyone may bid.
///
/// The four numbers (price, cap, floor, window) are parameters, not constants — they are
/// still undecided at the time of writing and do not block the mechanism.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SaleParams {
    pub price_lamports: u64,
    pub supply_for_sale: u64,
    pub hard_cap_lamports: u64,
    pub floor_lamports: u64,
    pub min_bid_lamports: u64,
    pub close_ts: i64,
    pub absolute_deadline: i64,
    pub pool_deadline: i64,
}

#[derive(Accounts)]
pub struct InitializeSale<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Sale::INIT_SPACE,
        seeds = [SALE_SEED, token_mint.key().as_ref()],
        bump
    )]
    pub sale: Account<'info, Sale>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    /// The tokens being sold. Funded *before* this instruction runs; this instruction's
    /// job is to verify it, not to trust it.
    #[account(
        constraint = token_vault.mint == token_mint.key() @ SaleError::VaultMintMismatch,
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    /// The single shared SOL vault: a system-owned PDA. Never created here — bidders'
    /// transfers fund it, and the program signs with these seeds to move SOL out.
    /// Seeded to rent-exempt minimum below so it cannot be reaped.
    /// CHECK: address is fully constrained by the seeds; holds lamports and no data.
    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, sale.key().as_ref()],
        bump
    )]
    pub sol_vault: UncheckedAccount<'info>,

    /// Where proceeds may go, and nowhere else. Recorded now so it is publicly readable
    /// before the first bid.
    /// CHECK: recorded as data, never signed or written by this program.
    pub seed_destination: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_sale(ctx: Context<InitializeSale>, params: SaleParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let sale_key = ctx.accounts.sale.key();

    // ---------------------------------------------------------------
    // Phase 0 — the vault must be provably safe before anyone may bid
    // ---------------------------------------------------------------
    let vault = &ctx.accounts.token_vault;

    require_keys_eq!(
        vault.owner,
        sale_key,
        SaleError::VaultNotProgramOwned
    );
    require!(vault.delegate.is_none(), SaleError::VaultHasDelegate);
    require!(
        vault.close_authority.is_none(),
        SaleError::VaultHasCloseAuthority
    );
    require!(
        vault.state == AccountState::Initialized,
        SaleError::VaultFrozen
    );

    // The spendable balance, not the amount someone says they sent. A transfer fee takes
    // its cut on the way in and parks it on the destination account as withheld — those
    // tokens are real but they belong to the withdraw-withheld authority, not to bidders.
    // Devnet proved the shape exactly: 1,000,000 sent, 997,500 spendable.
    let spendable = vault_spendable_amount(&ctx.accounts.token_vault.to_account_info())?;
    require!(
        spendable >= params.supply_for_sale,
        SaleError::VaultUnderfunded
    );

    // Mint-level authorities that would make every check above vacuous. A permanent
    // delegate can move tokens out of *any* account for this mint, the vault included;
    // a transfer hook can block or divert a claim. Beyond GAMEPLAN §6.1, deliberately:
    // without these, "the vault has no delegate" is not a statement about safety.
    //
    // `get_mint_extension_data` returns Err when the extension is absent — and also when
    // the mint carries no extensions at all, as a legacy SPL mint does. Err is therefore
    // read as "absent", which is correct for both. A malformed mint would read as clean
    // here, but it cannot get this far: the vault must deserialize and its mint must
    // match, and both are checked above.
    let mint_ai = ctx.accounts.token_mint.to_account_info();
    if let Ok(pd) = get_mint_extension_data::<PermanentDelegate>(&mint_ai) {
        require!(
            Option::<Pubkey>::from(pd.delegate).is_none(),
            SaleError::MintHasPermanentDelegate
        );
    }
    if let Ok(hook) = get_mint_extension_data::<TransferHook>(&mint_ai) {
        require!(
            Option::<Pubkey>::from(hook.program_id).is_none(),
            SaleError::MintHasTransferHook
        );
    }
    if let Ok(close) = get_mint_extension_data::<MintCloseAuthority>(&mint_ai) {
        require!(
            Option::<Pubkey>::from(close.close_authority).is_none(),
            SaleError::MintHasCloseAuthority
        );
    }

    // ---------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------
    require!(params.supply_for_sale > 0, SaleError::ZeroSupply);
    require!(params.price_lamports > 0, SaleError::ZeroPrice);
    require!(params.hard_cap_lamports > 0, SaleError::ZeroHardCap);
    require!(params.min_bid_lamports > 0, SaleError::ZeroMinBid);
    // A zero floor is a floor that can never bind: `total_committed < 0` is unreachable,
    // so "below the floor the sale cancels and refunds everyone" would be dead. It also
    // makes a zero-raise sale Succeed, which is the degenerate case §6.5 calls out.
    require!(params.floor_lamports > 0, SaleError::ZeroFloor);
    require!(
        params.floor_lamports <= params.hard_cap_lamports,
        SaleError::FloorAboveCap
    );
    require!(
        params.min_bid_lamports <= params.hard_cap_lamports,
        SaleError::MinBidAboveCap
    );

    // The cap must not exceed what the supply can actually cover at the fixed price.
    // Oversubscribed is safe by construction (pro-rata divides a fixed S), but the
    // *undersubscribed* branch pays out c_i / price, and without this the sum of those
    // payouts could exceed the vault. u128 throughout; floor division; `try_from`.
    let decimals_factor = 10u128
        .checked_pow(ctx.accounts.token_mint.decimals as u32)
        .ok_or(SaleError::Overflow)?;
    let max_raise = (params.supply_for_sale as u128)
        .checked_mul(params.price_lamports as u128)
        .ok_or(SaleError::Overflow)?
        / decimals_factor;
    let max_raise = u64::try_from(max_raise).map_err(|_| SaleError::Overflow)?;
    require!(
        params.hard_cap_lamports <= max_raise,
        SaleError::CapExceedsSupplyValue
    );

    require!(params.close_ts > now, SaleError::CloseInPast);
    require!(
        params.absolute_deadline >= params.close_ts,
        SaleError::DeadlineBeforeClose
    );

    // The activity extension must be able to fire at least once.
    //
    // With `absolute_deadline == close_ts` the extension is arithmetically inert:
    // `min(now + EXTENSION_SECONDS, absolute_deadline)` can never exceed `close_ts`, so
    // no bid ever moves the close and `extension_count` never leaves zero — a locked
    // design decision silently reduced to dead code. Requiring one extension's headroom
    // makes the mechanism live for every valid configuration.
    //
    // Which limit binds is then the operator's choice, and both are real:
    //   - headroom >= MAX_EXTENSIONS * EXTENSION_SECONDS  -> the count cap binds
    //   - headroom <  MAX_EXTENSIONS * EXTENSION_SECONDS  -> the absolute deadline binds
    // Both branches are covered by tests.
    require!(
        params
            .absolute_deadline
            .checked_sub(params.close_ts)
            .ok_or(SaleError::Overflow)?
            >= EXTENSION_SECONDS,
        SaleError::ExtensionWindowTooTight
    );

    require!(
        params.pool_deadline > params.absolute_deadline,
        SaleError::PoolDeadlineTooEarly
    );

    // ---------------------------------------------------------------
    // Record
    // ---------------------------------------------------------------
    let sale = &mut ctx.accounts.sale;
    sale.authority = ctx.accounts.authority.key();
    sale.token_mint = ctx.accounts.token_mint.key();
    sale.token_vault = ctx.accounts.token_vault.key();
    sale.sol_vault = ctx.accounts.sol_vault.key();
    sale.seed_destination = ctx.accounts.seed_destination.key();

    sale.price_lamports = params.price_lamports;
    sale.supply_for_sale = params.supply_for_sale;
    sale.hard_cap_lamports = params.hard_cap_lamports;
    sale.floor_lamports = params.floor_lamports;
    sale.min_bid_lamports = params.min_bid_lamports;

    sale.total_committed = 0;
    sale.total_claimed_tokens = 0;
    sale.total_accepted_lamports = 0;
    sale.total_swept_lamports = 0;
    sale.claim_count = 0;
    sale.commitment_count = 0;

    sale.open_ts = now;
    sale.close_ts = params.close_ts;
    sale.absolute_deadline = params.absolute_deadline;
    sale.pool_deadline = params.pool_deadline;

    sale.extension_count = 0;
    sale.status = SaleStatus::Bidding;
    sale.pool_created = false;
    sale.unsold_burned = false;

    sale.decimals = ctx.accounts.token_mint.decimals;
    sale.bump = ctx.bumps.sale;
    sale.sol_vault_bump = ctx.bumps.sol_vault;

    // Seed the SOL vault to rent-exempt minimum so it exists and cannot be reaped before
    // the first bid. This reserve is never part of `total_committed`: every invariant in
    // this program reads recorded state, never a lamport balance, precisely because
    // outsiders can donate to any address.
    let rent_reserve = Rent::get()?.minimum_balance(0);
    if ctx.accounts.sol_vault.lamports() < rent_reserve {
        let topup = rent_reserve.saturating_sub(ctx.accounts.sol_vault.lamports());
        anchor_lang::system_program::transfer(
            CpiContext::new(
                anchor_lang::system_program::ID,
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            topup,
        )?;
    }

    msg!(
        "sale open: supply={} spendable={} price={} cap={} floor={} close={}",
        params.supply_for_sale,
        spendable,
        params.price_lamports,
        params.hard_cap_lamports,
        params.floor_lamports,
        params.close_ts
    );
    Ok(())
}

/// What the vault can actually pay out: `base.amount`, and nothing subtracted from it.
///
/// **This used to return `amount - withheld`, and that was wrong twice over.** Measured
/// against the live Token-2022 program on 2026-08-08: a transfer of 5e16 base units left
/// the source debited the full 5e16, the destination credited `base.amount = 4.9875e16`,
/// and `withheld_amount = 1.25e14`. Those two sum to the gross, so **withheld sits
/// alongside `amount`, not inside it.** `base.amount` is already net of the fee, and
/// subtracting withheld took the fee a second time.
///
/// The old form was called "conservative, in the safe direction". It was safe for
/// *principal* — it could only ever demand a better-funded vault — but the over-funding it
/// forced never came back, and the 2026-08-09 devnet rehearsal proved it: the vault was
/// funded with 200,000,000, `supply_for_sale` was declared as 199,000,000, and **500,000
/// tokens were left in the vault that nothing can move.** `burn_unsold` burns
/// `supply_for_sale - total_claimed_tokens` — a recorded figure, not the vault balance —
/// and its flag is one-shot, so the residue is out of reach of the only two instructions
/// that move tokens at all. Always one transfer fee of whatever is funded, 0.25% at the
/// current rate. See RESULTS-2026-08-09.md.
///
/// **The extension is still read**, deliberately, even though nothing is subtracted: the
/// unpack is what proves this is a well-formed Token-2022 account and not something that
/// merely deserializes as one, and reading `withheld_amount` documents at the point of use
/// that those tokens are real but owed to the mint's withdraw-withheld authority. They are
/// not part of `amount` and never were.
pub fn vault_spendable_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data)
        .map_err(|_| error!(SaleError::VaultMintMismatch))?;

    // Read but NOT subtracted. Withheld fees belong to the mint's withdraw-withheld
    // authority and sit beside `amount`; they are already excluded from it.
    let _withheld = match state.get_extension::<TransferFeeAmount>() {
        Ok(ext) => u64::from(ext.withheld_amount),
        // No transfer-fee extension: a legacy SPL account, nothing withheld.
        Err(_) => 0,
    };

    Ok(state.base.amount)
}
