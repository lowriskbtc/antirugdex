//! Phase 3 — settlement, split into two instructions on purpose.
//!
//! `claim` pays out tokens and any pro-rata excess on a **Succeeded** sale. `refund` pays
//! back principal in full on a **Failed** one.
//!
//! **They are separate because the design invariant is:**
//!
//! > If the allocation math were completely broken, could every bidder still recover their
//! > principal?
//!
//! Only "yes" makes custody in unaudited Rust survivable, and the cheapest way to make it
//! yes is for the recovery path not to contain the allocation math at all. `refund` has no
//! mint, no token account, no token program, no CPI other than a system transfer, and no
//! arithmetic beyond copying a recorded number. It does not even write the `Sale` account.
//! A bug anywhere in `allocate` below cannot reach it.
//!
//! One `commitment.claimed` flag covers both, so a commitment settles exactly once by
//! exactly one of the two routes.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{constants::*, error::SaleError, state::*};

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/// What one commitment settles to. `accepted + refund == c_i`, always.
pub struct Allocation {
    /// Base units moved out of the vault. The bidder *receives* less — see below.
    pub tokens: u64,
    /// Lamports the sale keeps.
    pub accepted: u64,
    /// Lamports returned.
    pub refund: u64,
}

/// The whole mechanism, in fifteen lines. Ordering appears nowhere and wallet count
/// appears nowhere, which is why bundling and Sybil are both worth exactly zero.
///
/// Arithmetic rules, no exceptions: floor division always, u128 intermediates, and
/// `u64::try_from` — never `as u64`, which truncates silently and is not caught by
/// `overflow-checks`.
///
/// The u128 requirement is not theoretical at these numbers. Undersubscribed, `c_i * D`
/// with the harness's own configuration (`c_i` up to a 20 SOL cap, `D = 10^9`) is `2e19`,
/// which is already past `u64::MAX`. A u64 intermediate overflows at the *configured* cap,
/// not at some absurd input.
pub fn allocate(sale: &Sale, c_i: u64) -> Result<Allocation> {
    let c = c_i as u128;
    let total = sale.total_committed as u128;
    // Guards the division below. Unreachable through `claim`, which requires `Succeeded`
    // and therefore `total_committed >= floor_lamports > 0` — but it gets its own error
    // rather than sharing `NothingToClaim` with the caller's empty-commitment check. Two
    // guards answering to one error code means a failure never tells you which one fired,
    // which is the same trap as asserting a disjunction of two possible errors.
    require!(total > 0, SaleError::NoCommitments);

    if sale.total_committed <= sale.hard_cap_lamports {
        // Undersubscribed: everyone fills at the fixed price and nothing is refunded.
        // `initialize_sale` already proved `cap <= floor(S * P / D)`, so the sum of these
        // payouts can never exceed the vault.
        let d = 10u128
            .checked_pow(sale.decimals as u32)
            .ok_or(SaleError::Overflow)?;
        let tokens = c
            .checked_mul(d)
            .ok_or(SaleError::Overflow)?
            / (sale.price_lamports as u128);
        Ok(Allocation {
            tokens: u64::try_from(tokens).map_err(|_| SaleError::Overflow)?,
            accepted: c_i,
            refund: 0,
        })
    } else {
        // Oversubscribed: pro-rata on both sides. GAMEPLAN §6.4's canonical formula.
        //
        // Flooring makes both sums sub-additive, which is what keeps them safe:
        // `sum(floor(c_i * S / C)) <= floor(C * S / C) = S`, and likewise
        // `sum(accepted_i) <= cap`. Dust is left behind, never over-committed.
        let tokens = c
            .checked_mul(sale.supply_for_sale as u128)
            .ok_or(SaleError::Overflow)?
            / total;
        let accepted = c
            .checked_mul(sale.hard_cap_lamports as u128)
            .ok_or(SaleError::Overflow)?
            / total;
        let accepted = u64::try_from(accepted).map_err(|_| SaleError::Overflow)?;
        Ok(Allocation {
            tokens: u64::try_from(tokens).map_err(|_| SaleError::Overflow)?,
            accepted,
            refund: c_i.checked_sub(accepted).ok_or(SaleError::Overflow)?,
        })
    }
}

// ---------------------------------------------------------------------------
// The anti-bundle rule
// ---------------------------------------------------------------------------

/// GAMEPLAN §6.3: `claim` must be top-level, and no other top-level instruction in the
/// transaction may target this program.
///
/// **Honest scope, in the same spirit as `JITO_DONT_FRONT`.** What this actually buys:
/// no other program can CPI-wrap `claim` (a router that claims and dumps in one inner
/// call), and no transaction can batch many claims together. What it does **not** buy:
/// it does not stop `[claim, raydium_swap]` as two top-level instructions in one
/// transaction — both sit at stack height 1, and the swap targets Raydium, not us. Atomic
/// claim-and-dump by the bidder themselves is not preventable here, and the broader rule
/// that would catch it needs a hardcoded bypass whitelist (Meteora's shape), which §6.3
/// rejected. State the residual gap rather than let the check imply it is closed.
fn require_unbundled(sysvar: &AccountInfo) -> Result<()> {
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        SaleError::NotTopLevel
    );

    // Instructions sysvar layout, taken from `solana_instructions_sysvar`'s own
    // deserializer (anchor-lang 1.1.2 re-exports neither the loader nor the address):
    //
    //   [0..2]                      u16  number of top-level instructions
    //   [2 + i*2 .. +2]             u16  byte offset of instruction i
    //   at that offset:             u16  number of accounts
    //                               then num_accounts * (1 flag byte + 32-byte pubkey)
    //                               then the 32-byte program id
    //   [len-2 .. len]              u16  index of the instruction now executing
    //
    // Parsed by hand rather than through `load_instruction_at_checked`, which allocates a
    // full `Instruction` — accounts vector included — per call. The BPF bump allocator
    // never frees, so a transaction with many instructions could exhaust the 32 KB heap
    // inside this loop. This walk allocates nothing and reads only the program ids.
    let data = sysvar.try_borrow_data()?;
    let count = read_u16(&data, 0)?;

    let mut own: u16 = 0;
    for i in 0..count as usize {
        let start = read_u16(&data, 2 + i * 2)? as usize;
        let num_accounts = read_u16(&data, start)? as usize;
        let program_id_off = start
            .checked_add(2)
            .and_then(|v| v.checked_add(num_accounts.checked_mul(33)?))
            .ok_or(SaleError::MalformedInstructionsSysvar)?;
        let end = program_id_off
            .checked_add(32)
            .ok_or(SaleError::MalformedInstructionsSysvar)?;
        let program_id = data
            .get(program_id_off..end)
            .ok_or(SaleError::MalformedInstructionsSysvar)?;
        if program_id == crate::ID.as_ref() {
            own = own.checked_add(1).ok_or(SaleError::Overflow)?;
        }
    }

    // Exactly one: the instruction now executing, and nothing else.
    require!(own == 1, SaleError::MultipleOwnInstructions);
    Ok(())
}

fn read_u16(data: &[u8], off: usize) -> Result<u16> {
    let end = off
        .checked_add(2)
        .ok_or(SaleError::MalformedInstructionsSysvar)?;
    let bytes = data
        .get(off..end)
        .ok_or(SaleError::MalformedInstructionsSysvar)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

// ---------------------------------------------------------------------------
// claim — Succeeded sales only
// ---------------------------------------------------------------------------

/// Pull-based, and signed by the bidder. Unlike settlement, this is not permissionless:
/// nothing here can strand anyone (a bidder who never claims still holds an unspent
/// `Commitment`), and the anti-bundle rules above are about the bidder's own transaction.
/// Every account big enough to matter is `Box`ed. Unboxed, this struct's generated
/// `try_accounts` overflows the 4 KB SBF stack frame by a handful of bytes — which the
/// toolchain reports as a warning while still emitting a binary, and the consequence is
/// undefined behaviour at runtime rather than a failed build. Do not un-box these.
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,

    #[account(
        mut,
        seeds = [SALE_SEED, sale.token_mint.as_ref()],
        bump = sale.bump,
    )]
    pub sale: Box<Account<'info, Sale>>,

    #[account(
        mut,
        seeds = [COMMIT_SEED, sale.key().as_ref(), bidder.key().as_ref()],
        bump = commitment.bump,
    )]
    pub commitment: Box<Account<'info, Commitment>>,

    #[account(address = sale.token_mint @ SaleError::VaultMintMismatch)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = sale.token_vault @ SaleError::VaultMintMismatch)]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = bidder,
        associated_token::mint = token_mint,
        associated_token::authority = bidder,
        associated_token::token_program = token_program,
    )]
    pub bidder_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: address fully constrained by seeds; holds lamports and no data.
    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, sale.key().as_ref()],
        bump = sale.sol_vault_bump,
    )]
    pub sol_vault: UncheckedAccount<'info>,

    /// CHECK: a marker, never read or written. See `JITO_DONT_FRONT`.
    #[account(address = JITO_DONT_FRONT @ SaleError::MissingJitoMarker)]
    pub jito_dont_front: UncheckedAccount<'info>,

    /// CHECK: address-constrained to the real sysvar; parsed by hand in `require_unbundled`.
    #[account(address = INSTRUCTIONS_SYSVAR @ SaleError::MalformedInstructionsSysvar)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim(ctx: Context<Claim>) -> Result<()> {
    require_unbundled(&ctx.accounts.instructions_sysvar.to_account_info())?;

    let now = Clock::get()?.unix_timestamp;
    let sale_key = ctx.accounts.sale.key();
    let sale = &ctx.accounts.sale;

    require!(!ctx.accounts.commitment.claimed, SaleError::AlreadyClaimed);
    require!(
        sale.status == SaleStatus::Succeeded,
        SaleError::SaleNotSucceeded
    );
    // Invariant half two, and the reason `fail_on_missing_pool` can never double-pay:
    // it flips to `Failed` only while `!pool_created`, so no token can have been claimed
    // before it runs. Drop this line and early claimers keep tokens while everyone else
    // refunds. Documented on `Sale::pool_created`.
    require!(sale.pool_created, SaleError::PoolNotCreated);
    // Claims open only once trading is live, so the circulating float at the pool opening
    // is zero and the only possible first trade is a buy. Reverse the order and opening
    // deliberately high builds a sell-side snipe instead of preventing a buy-side one.
    require!(now >= sale.pool_open_time, SaleError::ClaimsNotOpen);

    let c_i = ctx.accounts.commitment.amount;
    require!(c_i > 0, SaleError::NothingToClaim);

    let alloc = allocate(sale, c_i)?;

    // `sum(alloc) <= supply_for_sale`. Sub-additive flooring already proves this whenever
    // `total_committed` really is the sum of the commitments, so this cannot fire on the
    // allocation formula alone — it backstops the other bug class, a `total_committed`
    // that has drifted from the commitments it is supposed to summarise. Without it the
    // only remaining backstop is Token-2022, and that surfaces as *the last claimer's*
    // transaction failing, which is invisible unless you go looking.
    let claimed_after = sale
        .total_claimed_tokens
        .checked_add(alloc.tokens)
        .ok_or(SaleError::Overflow)?;
    require!(
        claimed_after <= sale.supply_for_sale,
        SaleError::SupplyExceeded
    );

    let token_mint_key = sale.token_mint;
    let sale_bump = sale.bump;
    let sol_vault_bump = sale.sol_vault_bump;
    let decimals = sale.decimals;

    // ---- Effects before interactions ----
    let commitment = &mut ctx.accounts.commitment;
    commitment.claimed = true;
    commitment.tokens_claimed = alloc.tokens;
    commitment.lamports_refunded = alloc.refund;

    let sale = &mut ctx.accounts.sale;
    sale.total_claimed_tokens = claimed_after;
    sale.total_accepted_lamports = sale
        .total_accepted_lamports
        .checked_add(alloc.accepted)
        .ok_or(SaleError::Overflow)?;
    sale.claim_count = sale.claim_count.checked_add(1).ok_or(SaleError::Overflow)?;

    // ---- Interactions ----
    if alloc.tokens > 0 {
        // The vault's authority is the sale PDA, so this is signed with the sale's seeds.
        //
        // **The bidder receives less than `alloc.tokens`.** The 0.25% transfer fee applies
        // to this transfer like any other: 19,462 base units leaving the vault land as
        // 19,413 spendable, with the rest withheld on the destination account. The vault
        // still debits the full amount, so `sum(alloc) <= S` is unaffected — but every UI
        // must quote the net number, because every router overstates it by the fee.
        let sale_seeds: &[&[u8]] = &[SALE_SEED, token_mint_key.as_ref(), &[sale_bump]];
        anchor_spl::token_2022::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                anchor_spl::token_2022::TransferChecked {
                    from: ctx.accounts.token_vault.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.bidder_token_account.to_account_info(),
                    authority: ctx.accounts.sale.to_account_info(),
                },
                &[sale_seeds],
            ),
            alloc.tokens,
            decimals,
        )?;
    }

    if alloc.refund > 0 {
        pay_from_sol_vault(
            &ctx.accounts.sol_vault,
            &ctx.accounts.bidder.to_account_info(),
            &ctx.accounts.system_program,
            &sale_key,
            sol_vault_bump,
            alloc.refund,
        )?;
    }

    msg!(
        "claim: committed={} tokens={} accepted={} refund={}",
        c_i,
        alloc.tokens,
        alloc.accepted,
        alloc.refund
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// refund — Failed sales only
// ---------------------------------------------------------------------------

/// Full principal back, and **permissionless**: any funded wallet may push a bidder's
/// refund, and the lamports go to the bidder regardless of who paid the fee.
///
/// That matters more here than anywhere else in the program. A bidder who committed
/// everything they had cannot afford the transaction that returns it, and requiring their
/// signature would make the recovery path depend on them still holding a live key and a
/// fee balance. Nobody can profit from pushing someone else's refund — the amount is a
/// recorded number and the destination is fixed by the PDA seeds.
///
/// No `jitodontfront` marker and no stack-height rule, deliberately. Both exist to make
/// atomic claim-and-dump harder, and a refund produces no tokens to dump. Keeping the
/// principal path free of guards it does not need is the point of splitting it out.
///
/// **It also needs no `pool_created` check, and here is the trace.** A sale reaches
/// `Failed` by exactly two routes: `finalize` below the floor, or `fail_on_missing_pool`,
/// which requires `!pool_created`. `mark_pool_created` requires `Succeeded`, so it can
/// neither have run before a below-floor `finalize` nor after one. Therefore `Failed`
/// implies `!pool_created`, and `claim` requires `pool_created` — so no token can ever
/// have been claimed on a sale this instruction will act on. The per-commitment `claimed`
/// flag is a second, independent lock on the same thing.
#[derive(Accounts)]
pub struct Refund<'info> {
    /// Anyone. Pays the fee and receives nothing.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: constrained to be this commitment's bidder by the seeds below, and checked
    /// again in the handler. Receives the lamports; never signs.
    #[account(mut)]
    pub bidder: UncheckedAccount<'info>,

    /// Not `mut`. `refund` never writes the sale account, so refunds do not queue behind
    /// one write lock and a bug in the claim bookkeeping cannot reach principal.
    #[account(
        seeds = [SALE_SEED, sale.token_mint.as_ref()],
        bump = sale.bump,
    )]
    pub sale: Account<'info, Sale>,

    #[account(
        mut,
        seeds = [COMMIT_SEED, sale.key().as_ref(), bidder.key().as_ref()],
        bump = commitment.bump,
    )]
    pub commitment: Account<'info, Commitment>,

    /// CHECK: address fully constrained by seeds; holds lamports and no data.
    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, sale.key().as_ref()],
        bump = sale.sol_vault_bump,
    )]
    pub sol_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_refund(ctx: Context<Refund>) -> Result<()> {
    let sale_key = ctx.accounts.sale.key();

    require!(!ctx.accounts.commitment.claimed, SaleError::AlreadyClaimed);
    require!(
        ctx.accounts.sale.status == SaleStatus::Failed,
        SaleError::SaleNotFailed
    );
    // The seeds already pin this, but the whole point of this instruction is that it is
    // obviously correct on its own terms rather than correct via a derivation elsewhere.
    require_keys_eq!(
        ctx.accounts.bidder.key(),
        ctx.accounts.commitment.bidder,
        SaleError::BidderMismatch
    );

    let amount = ctx.accounts.commitment.amount;
    require!(amount > 0, SaleError::NothingToClaim);

    let sol_vault_bump = ctx.accounts.sale.sol_vault_bump;

    let commitment = &mut ctx.accounts.commitment;
    commitment.claimed = true;
    commitment.tokens_claimed = 0;
    commitment.lamports_refunded = amount;

    pay_from_sol_vault(
        &ctx.accounts.sol_vault,
        &ctx.accounts.bidder.to_account_info(),
        &ctx.accounts.system_program,
        &sale_key,
        sol_vault_bump,
        amount,
    )?;

    msg!("refund: {} lamports returned in full", amount);
    Ok(())
}

// ---------------------------------------------------------------------------

/// Move lamports out of the shared SOL vault, signed with its seeds.
///
/// The vault is a system-owned PDA with no data, which is what makes a plain system
/// transfer legal from it.
pub(crate) fn pay_from_sol_vault<'info>(
    sol_vault: &UncheckedAccount<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    sale_key: &Pubkey,
    sol_vault_bump: u8,
    amount: u64,
) -> Result<()> {
    // A floor check, not an invariant — invariants in this program read recorded state,
    // never balances. The rent reserve was seeded at initialize and is not anyone's
    // principal; letting a payout eat into it would make the vault reapable. Stated
    // explicitly instead of relying on the argument that recorded payouts can never
    // exceed recorded deposits.
    let rent_reserve = Rent::get()?.minimum_balance(0);
    let available = sol_vault.lamports().saturating_sub(rent_reserve);
    require!(available >= amount, SaleError::VaultBelowRentReserve);

    let vault_seeds: &[&[u8]] = &[SOL_VAULT_SEED, sale_key.as_ref(), &[sol_vault_bump]];
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system_program.key(),
            anchor_lang::system_program::Transfer {
                from: sol_vault.to_account_info(),
                to: to.clone(),
            },
            &[vault_seeds],
        ),
        amount,
    )
}
