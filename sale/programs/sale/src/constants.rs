use anchor_lang::prelude::*;

/// PDA seed for the one `Sale` account per token mint.
#[constant]
pub const SALE_SEED: &[u8] = b"sale";

/// PDA seed for a bidder's `Commitment`: ["commit", sale, bidder].
#[constant]
pub const COMMIT_SEED: &[u8] = b"commit";

/// PDA seed for the single shared SOL vault: ["sol_vault", sale].
///
/// One shared vault, not one per bidder. Per-bidder custody and decoupled refunds are
/// mutually exclusive, and per-bidder accounts would make pool seeding an N-account sweep.
#[constant]
pub const SOL_VAULT_SEED: &[u8] = b"sol_vault";

/// Hard ceiling on how many times late activity may push `close_ts` out.
///
/// Without a cap an attacker controls the deadline indefinitely at minimum-bid cost.
/// The absolute deadline sits behind this as a second backstop.
#[constant]
pub const MAX_EXTENSIONS: u16 = 12;

/// How far past `close_ts` a qualifying late bid pushes the close, in seconds.
#[constant]
pub const EXTENSION_SECONDS: i64 = 300;

/// A bid landing within this window before `close_ts` triggers an extension.
#[constant]
pub const EXTENSION_TRIGGER_SECONDS: i64 = 300;

// ---------------------------------------------------------------------------
// Raydium CPMM — every value below was read off a live pool account, not docs.
// ---------------------------------------------------------------------------

/// Owner of a genuine CPMM pool account.
///
/// **Both values are confirmed against live pools, not documentation.** A wrong program
/// id here is the easiest possible way to accept a counterfeit pool.
///
/// - devnet: the `owner` of our own pool `6zKJcfz…`, read 2026-08-08
/// - mainnet: the `owner` of live pool `H1Kvn7XW1qh9BP9kKo2KZqz8Q6ZcppsJCsUDxJEvntav`,
///   read 2026-08-08 with `tools/verify-mainnet-cpmm.py`. That pool is 637 bytes with the
///   same discriminator, so the layout below holds on mainnet too.
#[cfg(feature = "devnet")]
#[constant]
pub const RAYDIUM_CPMM_PROGRAM: Pubkey = pubkey!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
#[cfg(not(feature = "devnet"))]
#[constant]
pub const RAYDIUM_CPMM_PROGRAM: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

/// Anchor discriminator of `PoolState`, from the live account.
pub const POOL_STATE_DISCRIMINATOR: [u8; 8] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];

/// `PoolState::LEN`, confirmed as the live account's data length.
pub const POOL_STATE_LEN: usize = 637;

// Byte offsets into `PoolState`. It is `#[repr(C, packed)]` zero-copy, so these are read
// from the raw slice — no alignment assumptions, no dependency on Raydium's crate.
/// The wallet that created the pool. Read back as `A9h5uLS6…` — our own devnet
/// deployer — from the live pool on 2026-08-08 via `tools/decode-pool-offsets.py`.
pub const POOL_OFF_POOL_CREATOR: usize = 40;
pub const POOL_OFF_LP_MINT: usize = 136;
pub const POOL_OFF_TOKEN_0_MINT: usize = 168;
pub const POOL_OFF_TOKEN_1_MINT: usize = 200;
pub const POOL_OFF_OPEN_TIME: usize = 373;

/// Jito's anti-sandwich marker.
///
/// Any pubkey whose base58 begins with `jitodontfront`, present in any instruction, makes
/// the Jito block engine reject a bundle unless this transaction sits at index 0. Padding
/// the prefix with `1`s yields exactly one valid 32-byte key, which is this one.
///
/// **Honest scope:** this is anti-sandwich only, enforced off-chain by one block engine.
/// Transactions submitted directly to validators are not covered, and it prevents nothing
/// about bid ordering — which is worth zero here anyway, by design.
#[constant]
pub const JITO_DONT_FRONT: Pubkey = pubkey!("jitodontfront111111111111111111111111111111");

/// The instructions sysvar, which `claim` reads to count how many top-level instructions
/// in this transaction target this program.
///
/// Hardcoded because anchor-lang 1.1.2 re-exports neither the address nor
/// `load_instruction_at_checked`. The value is `solana_sdk_ids` 3.1.0's
/// `sysvar::instructions` declaration, read out of the vendored crate source.
pub const INSTRUCTIONS_SYSVAR: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");
