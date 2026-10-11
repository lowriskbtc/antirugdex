use anchor_lang::prelude::*;

#[error_code]
pub enum SaleError {
    // ---- Phase 0: the vault must be safe before anyone may bid ----
    #[msg("Token vault is not owned by the sale PDA")]
    VaultNotProgramOwned,
    #[msg("Token vault has a delegate; it could be drained mid-sale")]
    VaultHasDelegate,
    #[msg("Token vault has a close authority; it could be closed mid-sale")]
    VaultHasCloseAuthority,
    #[msg("Token vault is frozen")]
    VaultFrozen,
    #[msg("Token vault mint does not match the sale mint")]
    VaultMintMismatch,
    #[msg("Token vault spendable balance is below the declared supply for sale")]
    VaultUnderfunded,

    // ---- Phase 0: mint-level authorities that would make the vault checks vacuous ----
    #[msg("Mint has a permanent delegate, which can move tokens out of any account")]
    MintHasPermanentDelegate,
    #[msg("Mint has a transfer hook, which can block or divert claims")]
    MintHasTransferHook,
    #[msg("Mint has a close authority")]
    MintHasCloseAuthority,

    // ---- Configuration ----
    #[msg("Supply for sale must be greater than zero")]
    ZeroSupply,
    #[msg("Price must be greater than zero")]
    ZeroPrice,
    #[msg("Hard cap must be greater than zero")]
    ZeroHardCap,
    #[msg("Minimum bid must be greater than zero")]
    ZeroMinBid,
    #[msg("Minimum floor must be greater than zero, or it can never bind")]
    ZeroFloor,
    #[msg("Minimum floor cannot exceed the hard cap")]
    FloorAboveCap,
    #[msg("Minimum bid cannot exceed the hard cap")]
    MinBidAboveCap,
    #[msg("Hard cap exceeds what the supply can cover at this price")]
    CapExceedsSupplyValue,
    #[msg("Close timestamp must be in the future")]
    CloseInPast,
    #[msg("Absolute deadline must be at or after the close timestamp")]
    DeadlineBeforeClose,
    #[msg("Pool deadline must be after the absolute deadline")]
    PoolDeadlineTooEarly,
    #[msg("Absolute deadline leaves no room for even one extension")]
    ExtensionWindowTooTight,

    // ---- Bidding ----
    #[msg("Sale is not accepting bids")]
    SaleNotBidding,
    #[msg("Bidding has closed")]
    BiddingClosed,
    #[msg("Bid is below the minimum")]
    BidBelowMinimum,
    #[msg("Missing the jitodontfront marker account")]
    MissingJitoMarker,

    // ---- Settlement ----
    #[msg("Bidding is still open")]
    SaleStillOpen,
    #[msg("Sale has already been finalized")]
    SaleAlreadyFinalized,
    #[msg("Pool deadline has not been reached")]
    PoolDeadlineNotReached,
    #[msg("Pool has already been created")]
    PoolAlreadyCreated,
    #[msg("Sale did not succeed")]
    SaleNotSucceeded,
    #[msg("Pool account is not owned by the Raydium CPMM program")]
    PoolWrongOwner,
    #[msg("Pool account is not a PoolState (bad discriminator or length)")]
    PoolNotPoolState,
    #[msg("Pool does not trade the sale's token")]
    PoolMintMismatch,
    #[msg("LP mint account does not match the pool's lp_mint")]
    PoolLpMintMismatch,
    #[msg("LP tokens are not fully burned")]
    LpNotBurned,
    #[msg("Pool deadline has already passed; only refunds remain")]
    PoolDeadlinePassed,
    #[msg("Pool was not created by the sale authority")]
    PoolWrongCreator,
    #[msg("Pool open_time is later than the pool deadline; it would block claims")]
    PoolOpensTooLate,

    // ---- Claims and refunds ----
    #[msg("This commitment has already been settled")]
    AlreadyClaimed,
    #[msg("No pool has been proven yet")]
    PoolNotCreated,
    #[msg("Claims do not open until the pool starts trading")]
    ClaimsNotOpen,
    #[msg("Sale has not failed; use claim instead")]
    SaleNotFailed,
    #[msg("Commitment is empty")]
    NothingToClaim,
    #[msg("Sale recorded no commitments at all")]
    NoCommitments,
    #[msg("Bidder account does not match the commitment")]
    BidderMismatch,
    #[msg("This instruction must be top-level, not invoked by another program")]
    NotTopLevel,
    #[msg("Only one instruction per transaction may target this program")]
    MultipleOwnInstructions,
    #[msg("Instructions sysvar is malformed")]
    MalformedInstructionsSysvar,
    #[msg("Payout would take the SOL vault below its rent reserve")]
    VaultBelowRentReserve,
    #[msg("Allocation would exceed the supply for sale")]
    SupplyExceeded,

    // ---- Proceeds and the unsold remainder ----
    #[msg("Destination is not the pre-committed seed destination")]
    WrongSeedDestination,
    #[msg("Nothing further is sweepable yet")]
    NothingToSweep,
    #[msg("Proceeds cannot be swept until a pool has been proven")]
    SweepBeforePool,
    #[msg("Not every commitment has been claimed yet")]
    ClaimsOutstanding,
    #[msg("The unsold remainder has already been burned")]
    AlreadyBurned,
    #[msg("There is no unsold remainder to burn")]
    NothingToBurn,

    // ---- Arithmetic ----
    #[msg("Arithmetic overflow")]
    Overflow,
}
