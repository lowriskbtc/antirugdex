//! AntiRugDex sale program — a fixed-price, capped, pro-rata batch sale.
//!
//! Nothing fills during the bid window. Allocation is `floor(c_i * S / C)`, so bid
//! ordering is worth exactly zero and splitting across wallets is worth exactly zero.
//! Spec: GAMEPLAN.md §6.
//!
//! The invariant this design is judged against:
//!
//! > If the allocation math were completely broken, can every bidder still recover
//! > their principal?
//!
//! Three arithmetic rules that are never bent here: floor division always, u128
//! intermediates, and `u64::try_from(..)?` — never `as u64`, which truncates silently
//! and is not caught by `overflow-checks`.

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("51zNMfwD1ExHuWBPgT94jQfThaqBnnFbGMecH4AzfjWz");

#[program]
pub mod sale {
    use super::*;

    /// Phase 0. Verifies the vault is safe, records the terms, opens bidding.
    pub fn initialize_sale(ctx: Context<InitializeSale>, params: SaleParams) -> Result<()> {
        crate::instructions::initialize_sale::handle_initialize_sale(ctx, params)
    }

    /// Phase 1. Irrevocable deposit. There is no withdraw instruction, by design.
    pub fn bid(ctx: Context<Bid>, amount: u64) -> Result<()> {
        crate::instructions::bid::handle_bid(ctx, amount)
    }

    /// Phase 2. Permissionless. Freezes `total_committed` and settles against the floor.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        crate::instructions::finalize::handle_finalize(ctx)
    }

    /// Permissionless recovery: no pool by `pool_deadline` means every claim refunds.
    pub fn fail_on_missing_pool(ctx: Context<FailOnMissingPool>) -> Result<()> {
        crate::instructions::finalize::handle_fail_on_missing_pool(ctx)
    }

    /// Permissionless. Proves the pool exists and its LP is burned; unblocks claims.
    pub fn mark_pool_created(ctx: Context<MarkPoolCreated>) -> Result<()> {
        crate::instructions::mark_pool_created::handle_mark_pool_created(ctx)
    }

    /// Phase 3. Tokens plus any pro-rata excess, on a Succeeded sale. Bidder signs.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        crate::instructions::claim::handle_claim(ctx)
    }

    /// Phase 3, the recovery half. Full principal on a Failed sale. **Permissionless**,
    /// and deliberately free of the allocation math — see the module docs on `claim.rs`.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        crate::instructions::claim::handle_refund(ctx)
    }

    /// Phase 4. Permissionless. Moves the raise to the pre-committed `seed_destination`.
    /// **Gated on `pool_created`** — without that gate it destroys bidder principal.
    pub fn sweep_proceeds(ctx: Context<SweepProceeds>) -> Result<()> {
        crate::instructions::proceeds::handle_sweep_proceeds(ctx)
    }

    /// Phase 4. Permissionless. Burns the supply nobody bought, which is otherwise locked
    /// in the vault forever.
    pub fn burn_unsold(ctx: Context<BurnUnsold>) -> Result<()> {
        crate::instructions::proceeds::handle_burn_unsold(ctx)
    }
}
