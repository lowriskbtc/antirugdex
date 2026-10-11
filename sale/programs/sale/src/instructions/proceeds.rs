//! Phase 4 — what happens to the money and the tokens once the sale is over.
//!
//! `sweep_proceeds` moves the raise to the pre-committed destination. `burn_unsold`
//! destroys whatever supply nobody bought. Neither holds bidder principal, but the first
//! one can *destroy* it if its gate is wrong — see below.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::instructions::claim::pay_from_sol_vault;
use crate::{constants::*, error::SaleError, state::*};

// ---------------------------------------------------------------------------
// sweep_proceeds
// ---------------------------------------------------------------------------

/// Moves the raise to `seed_destination` — the account recorded at initialize and publicly
/// readable before anyone bid, which is what makes "the builder cannot redirect your SOL"
/// checkable rather than promised.
///
/// **Permissionless**, and safe to be: the destination is fixed in state and the amount is
/// derived from recorded state, so there is no discretion to gate.
///
/// # 🔴 The `pool_created` gate is the whole safety argument
///
/// Without `require!(sale.pool_created)` this instruction destroys every bidder's
/// principal, by this exact route: sweep runs, the vault drops to its rent reserve, the
/// pool never appears, `fail_on_missing_pool` — which requires `!pool_created` and is
/// still satisfied — flips the sale to `Failed`, and every `refund` then fails on
/// `VaultBelowRentReserve`. Total, permanent, unrecoverable loss, triggered by the very
/// path that exists to make abandonment survivable.
///
/// The gate is not a new invariant. It is the `pool_created` invariant documented on
/// `Sale::pool_created` applied to a third instruction: `Failed` implies `!pool_created`,
/// so gating the sweep on `pool_created` means the vault is always solvent for refunds for
/// as long as a refund is still possible.
///
/// **Launch-sequence consequence, and it is a real one.** The pool must exist and be proven
/// before the raise can be swept, so **the pool seed cannot come from the raise** — the
/// builder fronts it and sweeps to reimburse. GAMEPLAN §B4 was written before the program
/// existed and reads the other way; this ordering is the one that does not lose money. It
/// also means the hard cap is bounded by what the builder can front at launch time,
/// separately from the raise itself. That is an input to A2's four numbers.
#[derive(Accounts)]
pub struct SweepProceeds<'info> {
    /// Anyone. Pays the fee and receives nothing.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [SALE_SEED, sale.token_mint.as_ref()],
        bump = sale.bump,
    )]
    pub sale: Account<'info, Sale>,

    /// CHECK: pinned to the address recorded before the first bid. Nothing else is
    /// verified about it, and nothing else needs to be — it was published in advance.
    #[account(mut, address = sale.seed_destination @ SaleError::WrongSeedDestination)]
    pub seed_destination: UncheckedAccount<'info>,

    /// CHECK: address fully constrained by seeds; holds lamports and no data.
    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, sale.key().as_ref()],
        bump = sale.sol_vault_bump,
    )]
    pub sol_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_sweep_proceeds(ctx: Context<SweepProceeds>) -> Result<()> {
    let sale_key = ctx.accounts.sale.key();
    let sale = &ctx.accounts.sale;

    require!(
        sale.status == SaleStatus::Succeeded,
        SaleError::SaleNotSucceeded
    );
    require!(sale.pool_created, SaleError::SweepBeforePool);

    let ceiling = sweepable_ceiling(sale)?;
    let amount = ceiling.saturating_sub(sale.total_swept_lamports);
    require!(amount > 0, SaleError::NothingToSweep);

    let sol_vault_bump = sale.sol_vault_bump;

    let sale = &mut ctx.accounts.sale;
    sale.total_swept_lamports = sale
        .total_swept_lamports
        .checked_add(amount)
        .ok_or(SaleError::Overflow)?;

    pay_from_sol_vault(
        &ctx.accounts.sol_vault,
        &ctx.accounts.seed_destination.to_account_info(),
        &ctx.accounts.system_program,
        &sale_key,
        sol_vault_bump,
        amount,
    )?;

    msg!(
        "swept {} lamports to {}; total swept {} of ceiling {}",
        amount,
        ctx.accounts.seed_destination.key(),
        ctx.accounts.sale.total_swept_lamports,
        ceiling
    );
    Ok(())
}

/// The most the sale may ever have retained, computable at any moment — including before
/// the first claim, which is when the sweep actually has to run.
///
/// **Undersubscribed (`C <= cap`):** every commitment is accepted in full, so the answer is
/// exactly `C`. No dust.
///
/// **Oversubscribed:** the sale retains `sum(floor(c_i * cap / C))`, which cannot be
/// computed without iterating every commitment. Flooring loses strictly under one lamport
/// per commitment, so that sum is strictly greater than `cap - commitment_count` — a bound
/// that needs only two recorded numbers. Once claims settle, `total_accepted_lamports`
/// becomes the exact figure and overtakes the bound, so the larger of the two is taken and
/// the re-callable sweep recovers the last few lamports.
///
/// Taking the **larger** matters: waiting on `total_accepted_lamports` alone would leave
/// the builder permanently short whenever a bidder never claims, and lost keys and CEX
/// deposit addresses guarantee some never will.
fn sweepable_ceiling(sale: &Sale) -> Result<u64> {
    if sale.total_committed <= sale.hard_cap_lamports {
        return Ok(sale.total_committed);
    }
    let conservative = sale
        .hard_cap_lamports
        .saturating_sub(sale.commitment_count);
    Ok(conservative.max(sale.total_accepted_lamports))
}

// ---------------------------------------------------------------------------
// burn_unsold
// ---------------------------------------------------------------------------

/// Destroys the supply nobody bought.
///
/// The vault is owned by the sale PDA and only this program can move tokens out of it, so
/// without this instruction an undersubscribed sale's remainder is locked forever.
/// GAMEPLAN §6.5's answer is to burn the bucket in place, and burning is untaxed — proven
/// by `burning_is_untaxed`, not taken from the spec.
///
/// **Permissionless.** Burning is not a discretionary act: the amount is
/// `supply_for_sale - total_claimed_tokens` and it goes nowhere.
///
/// # The guard, and the fact that it may never be satisfiable
///
/// On a `Succeeded` sale this requires `claim_count == commitment_count` — everyone has
/// claimed. Until then the remainder is indistinguishable from tokens still owed, and
/// burning early would eat someone's allocation.
///
/// **A single bidder who lost their key blocks this forever**, and CEX-deposit-address
/// bidders are a known instance of exactly that. This is acceptable — unsold tokens are
/// nobody's principal, so the failure mode is cosmetic supply rather than lost funds — but
/// it is stated here so a future session does not discover it as a surprise.
///
/// A `Failed` sale needs no such guard: `claim` requires `Succeeded`, so not one token can
/// ever have left the vault, and the entire supply is unsold by definition.
#[derive(Accounts)]
pub struct BurnUnsold<'info> {
    /// Anyone. Pays the fee and receives nothing.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [SALE_SEED, sale.token_mint.as_ref()],
        bump = sale.bump,
    )]
    pub sale: Box<Account<'info, Sale>>,

    #[account(mut, address = sale.token_mint @ SaleError::VaultMintMismatch)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = sale.token_vault @ SaleError::VaultMintMismatch)]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_burn_unsold(ctx: Context<BurnUnsold>) -> Result<()> {
    let sale = &ctx.accounts.sale;

    require!(!sale.unsold_burned, SaleError::AlreadyBurned);
    match sale.status {
        SaleStatus::Succeeded => require!(
            sale.claim_count == sale.commitment_count,
            SaleError::ClaimsOutstanding
        ),
        // Nothing was ever claimable, so the whole supply is unsold.
        SaleStatus::Failed => {}
        SaleStatus::Bidding => return Err(SaleError::SaleStillOpen.into()),
    }

    let unsold = sale
        .supply_for_sale
        .checked_sub(sale.total_claimed_tokens)
        .ok_or(SaleError::Overflow)?;
    require!(unsold > 0, SaleError::NothingToBurn);

    let token_mint_key = sale.token_mint;
    let sale_bump = sale.bump;

    let sale = &mut ctx.accounts.sale;
    sale.unsold_burned = true;

    let sale_seeds: &[&[u8]] = &[SALE_SEED, token_mint_key.as_ref(), &[sale_bump]];
    anchor_spl::token_2022::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            anchor_spl::token_2022::Burn {
                mint: ctx.accounts.token_mint.to_account_info(),
                from: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.sale.to_account_info(),
            },
            &[sale_seeds],
        ),
        unsold,
    )?;

    msg!("burned {} unsold base units", unsold);
    Ok(())
}
