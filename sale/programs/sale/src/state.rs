use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum SaleStatus {
    /// Bids are open (subject to `close_ts`).
    Bidding,
    /// Closed, `total_committed` frozen, at or above the floor. Claims may open.
    Succeeded,
    /// Closed below the floor, or the pool deadline passed. Everyone refunds in full.
    Failed,
}

/// One per token mint. Written at initialize, frozen in shape thereafter.
///
/// Everything a claimer needs is here plus their own `Commitment`: pro-rata is a fold, so
/// there is no merkle root and no settlement authority that could strand principal.
#[account]
#[derive(InitSpace)]
pub struct Sale {
    /// Funds the sale and seeds the pool afterwards. Holds no power over bidder principal.
    pub authority: Pubkey,
    /// The token being sold.
    pub token_mint: Pubkey,
    /// Program-owned token account holding the tokens. Verified in Phase 0.
    pub token_vault: Pubkey,
    /// The single shared SOL vault PDA.
    pub sol_vault: Pubkey,
    /// Where proceeds may go, and nowhere else. Pre-committed and publicly readable
    /// before anyone bids — this is the account that makes "the builder cannot redirect
    /// your SOL" checkable rather than promised.
    pub seed_destination: Pubkey,

    /// Lamports per whole token (per 10^decimals base units).
    pub price_lamports: u64,
    /// Base units of the token available. Never exceeds the vault's spendable balance.
    pub supply_for_sale: u64,
    /// Lamports. Commitments above this are refunded pro-rata.
    pub hard_cap_lamports: u64,
    /// Lamports. Below this at close the sale Fails and everyone refunds in full.
    pub floor_lamports: u64,
    /// Lamports. Dust-griefing deterrent; the real cost to an attacker is the lockup.
    pub min_bid_lamports: u64,

    /// Frozen at finalize. Until then it only grows.
    pub total_committed: u64,
    /// Bookkeeping for the invariant `sum(alloc) <= supply_for_sale`.
    pub total_claimed_tokens: u64,
    /// Lamports actually kept from settled commitments — the sum of `accepted_i`, which is
    /// what `sweep_proceeds` is allowed to move.
    ///
    /// **Not `hard_cap_lamports`, and the difference is not zero.** Oversubscribed,
    /// `accepted_i = floor(c_i * cap / C)` and flooring loses up to one lamport per bidder,
    /// so `sum(accepted_i)` lands *below* the cap by up to N-1 lamports. Sweeping the cap
    /// instead would leave the last refunder's transaction short — the same failure mode as
    /// over-allocating tokens, transposed onto principal. Recorded here at settle time so a
    /// sweep never has to infer it. It is also why `sweep_proceeds` must run after claims,
    /// or move only what has been recorded so far.
    pub total_accepted_lamports: u64,
    /// How many bidders have claimed tokens. Deliberately not incremented by `refund`,
    /// which does not write this account at all.
    ///
    /// Load-bearing in exactly one place: `burn_unsold` requires
    /// `claim_count == commitment_count`, because until then the unsold remainder is not
    /// distinguishable from tokens someone is still owed.
    pub claim_count: u64,
    /// Distinct `Commitment` accounts ever created, incremented by `bid` on first creation.
    ///
    /// Two uses, both of which need a count rather than a sum:
    /// 1. `sweep_proceeds` before claims settle. Oversubscribed, the sale retains
    ///    `sum(floor(c_i * cap / C))`, which is not computable without iterating every
    ///    commitment — but flooring loses under one lamport each, so it is strictly greater
    ///    than `cap - commitment_count`. That bound is safe at any time, including before
    ///    the first claim, which is when the sweep actually has to run.
    /// 2. `burn_unsold`, as the definition of "everyone has claimed".
    pub commitment_count: u64,

    pub open_ts: i64,
    /// Extends on late activity, capped by `MAX_EXTENSIONS` and `absolute_deadline`.
    pub close_ts: i64,
    /// `close_ts` can never pass this, however much late activity there is.
    pub absolute_deadline: i64,
    /// If the pool does not exist by here, claims flip permissionlessly to full refund.
    /// This is what turns "the builder disappeared" into self-executing recovery.
    pub pool_deadline: i64,

    pub extension_count: u16,
    pub status: SaleStatus,
    /// Set once the pool has been created and seeded.
    ///
    /// **INVARIANT — both halves required, and `claim` owns the second one:**
    /// 1. `fail_on_missing_pool` may flip a sale to `Failed` only while `!pool_created`.
    /// 2. `claim` MUST `require!(sale.pool_created)`.
    ///
    /// Together these make the two states mutually exclusive, so a sale can never flip to
    /// `Failed` after someone has already claimed tokens. Drop half 2 and the abandonment
    /// path becomes a way for early claimers to keep tokens while everyone else refunds.
    /// It also matches the launch sequence, where claims open only after trading is live.
    pub pool_created: bool,
    /// Lamports already moved to `seed_destination`. A running total, not a flag, because
    /// the sweep is re-callable: the amount it may safely move grows as claims settle.
    pub total_swept_lamports: u64,
    /// Set once the unsold remainder has been burned. One shot — the burnable amount is a
    /// function of state that does not change afterwards, so a flag is the only guard.
    pub unsold_burned: bool,

    /// The verified Raydium CPMM pool. Default until `mark_pool_created` proves one.
    pub pool: Pubkey,
    /// The pool's `open_time`, copied from pool state once verified.
    ///
    /// **`claim` MUST require `now >= pool_open_time`.** Claims opening only after trading
    /// is live is what makes the opening price safe: at the moment the pool goes live the
    /// circulating float is zero, so nobody holds tokens to dump into an overpriced pool.
    /// Reverse the order and opening high builds a sell-side snipe instead of preventing a
    /// buy-side one. Enforcing it here makes that ordering a program rule rather than a
    /// procedure someone has to follow correctly on launch day.
    pub pool_open_time: i64,

    pub decimals: u8,
    pub bump: u8,
    pub sol_vault_bump: u8,
}

/// One per bidder, at ["commit", sale, bidder]. Every per-bidder decision lives here, so a
/// claimer needs only this account, the frozen totals, and a constant — no merkle root and
/// no settlement authority that could strand principal.
///
/// `refund` writes only this account and the SOL vault; it never touches `Sale`. That keeps
/// the principal-recovery path independent of the allocation bookkeeping, and it lets
/// refunds run in parallel instead of queueing on one write lock.
#[account]
#[derive(InitSpace)]
pub struct Commitment {
    pub sale: Pubkey,
    pub bidder: Pubkey,
    /// Total lamports committed. Accumulates across repeat bids. Irrevocable.
    pub amount: u64,
    /// Tokens received. Set once.
    pub tokens_claimed: u64,
    /// Lamports refunded (excess above the cap, or the full amount if Failed). Set once.
    pub lamports_refunded: u64,
    pub claimed: bool,
    pub bump: u8,
}
