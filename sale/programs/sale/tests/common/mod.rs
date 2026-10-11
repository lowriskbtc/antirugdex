//! Shared test scaffolding.
//!
//! Accounts are injected with `set_account` rather than built through CPIs, so each
//! hostile shape (withheld fees, a delegate, a close authority, a frozen vault) is
//! constructed exactly rather than approximated.

#![allow(dead_code)]

use {
    anchor_lang::{
        prelude::Pubkey, solana_program::instruction::Instruction, AccountDeserialize,
        InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_account::Account as SolanaAccount,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    spl_token_2022_interface::{
        extension::{
            transfer_fee::{TransferFee, TransferFeeAmount, TransferFeeConfig},
            BaseStateWithExtensions, BaseStateWithExtensionsMut, ExtensionType,
            PodStateWithExtensions, PodStateWithExtensionsMut,
        },
        pod::{PodAccount, PodCOption, PodMint},
        state::AccountState,
    },
};

// Re-exported so test files get `.pubkey()` on Keypair from `use common::*`.
// Not dead code — the `allow(dead_code)` above makes it look unused. Delete it and
// every `bidder.pubkey()` in the test files stops compiling.
pub use solana_signer::Signer as _TestSigner;

pub const DECIMALS: u8 = 9;
pub const ONE_TOKEN: u64 = 1_000_000_000;

/// 200,000,000 ARD spendable — what the sale actually sells, and what a funded vault's
/// `base.amount` reads. Fund 200,500,000 at 25 bps and this is what lands.
pub const SUPPLY: u64 = 200_000_000 * ONE_TOKEN;
/// The 0.25% haircut the funding transfer left behind, withheld on the vault **alongside**
/// `amount`, not inside it. Owed to the mint's withdraw-withheld authority; only `harvest`
/// moves it, and it is never sellable supply.
pub const WITHHELD: u64 = 500_000 * ONE_TOKEN;
/// `amount + withheld` — what a naive reading calls "the vault's total".
///
/// **Not a balance any field holds.** It exists so tests can assert that declaring this as
/// `supply_for_sale` is rejected. Until 2026-08-09 the fixture injected it as `base.amount`,
/// which the live token program never produces — see `withheld_fees_are_not_part_of_amount`.
pub const VAULT_AMOUNT: u64 = SUPPLY + WITHHELD;

/// 100 lamports per whole token (1e-7 SOL), so the supply is worth 20 SOL at the cap.
pub const PRICE: u64 = 100;
pub const HARD_CAP: u64 = 20_000_000_000;
pub const FLOOR: u64 = 5_000_000_000;
pub const MIN_BID: u64 = 50_000_000;

pub fn token_program_id() -> Pubkey {
    Pubkey::new_from_array(spl_token_2022_interface::id().to_bytes())
}

pub fn sale_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[sale::constants::SALE_SEED, mint.as_ref()], &sale::id())
}

pub fn sol_vault_pda(sale_key: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[sale::constants::SOL_VAULT_SEED, sale_key.as_ref()],
        &sale::id(),
    )
}

pub fn commit_pda(sale_key: &Pubkey, bidder: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            sale::constants::COMMIT_SEED,
            sale_key.as_ref(),
            bidder.as_ref(),
        ],
        &sale::id(),
    )
}

pub struct MintOpts {
    pub permanent_delegate: Option<Pubkey>,
    pub transfer_hook: Option<Pubkey>,
    pub close_authority: Option<Pubkey>,
}

impl Default for MintOpts {
    fn default() -> Self {
        Self { permanent_delegate: None, transfer_hook: None, close_authority: None }
    }
}

/// A Token-2022 mint carrying a 25 bps transfer fee, plus whichever hostile extensions
/// the caller asks for.
pub fn build_mint(opts: &MintOpts) -> Vec<u8> {
    let mut exts = vec![ExtensionType::TransferFeeConfig];
    if opts.permanent_delegate.is_some() {
        exts.push(ExtensionType::PermanentDelegate);
    }
    if opts.transfer_hook.is_some() {
        exts.push(ExtensionType::TransferHook);
    }
    if opts.close_authority.is_some() {
        exts.push(ExtensionType::MintCloseAuthority);
    }

    let len = ExtensionType::try_calculate_account_len::<PodMint>(&exts).unwrap();
    let mut data = vec![0u8; len];
    {
        let mut state =
            PodStateWithExtensionsMut::<PodMint>::unpack_uninitialized(&mut data).unwrap();

        let fee_cfg = state.init_extension::<TransferFeeConfig>(true).unwrap();
        let fee = TransferFee {
            epoch: 0.into(),
            maximum_fee: u64::MAX.into(),
            transfer_fee_basis_points: 25u16.into(),
        };
        fee_cfg.older_transfer_fee = fee;
        fee_cfg.newer_transfer_fee = fee;

        if let Some(d) = opts.permanent_delegate {
            let ext = state
                .init_extension::<spl_token_2022_interface::extension::permanent_delegate::PermanentDelegate>(true)
                .unwrap();
            ext.delegate = Some(d).try_into().unwrap();
        }
        if let Some(p) = opts.transfer_hook {
            let ext = state
                .init_extension::<spl_token_2022_interface::extension::transfer_hook::TransferHook>(true)
                .unwrap();
            ext.program_id = Some(p).try_into().unwrap();
        }
        if let Some(c) = opts.close_authority {
            let ext = state
                .init_extension::<spl_token_2022_interface::extension::mint_close_authority::MintCloseAuthority>(true)
                .unwrap();
            ext.close_authority = Some(c).try_into().unwrap();
        }

        state.base.decimals = DECIMALS;
        state.base.is_initialized = true.into();
        state.base.supply = (1_000_000_000u64 * ONE_TOKEN).into();
        state.init_account_type().unwrap();
    }
    data
}

/// Note for whoever adds the next check: the two "optional pubkey" encodings do **not**
/// agree on what absent means. `PodCOption` (base account fields: delegate, close
/// authority) treats a *set* default pubkey as present; `OptionalNonZeroPubkey` (mint
/// extension fields) treats the default pubkey as absent. Every test here uses a real
/// `Pubkey::new_unique()`, so the distinction never bites — but pick the wrong one and a
/// negative test will pass for the wrong reason.
pub struct VaultOpts {
    pub owner: Pubkey,
    pub amount: u64,
    pub withheld: u64,
    pub delegate: Option<Pubkey>,
    pub close_authority: Option<Pubkey>,
    pub frozen: bool,
}

pub fn build_vault(mint: &Pubkey, o: &VaultOpts) -> Vec<u8> {
    let len =
        ExtensionType::try_calculate_account_len::<PodAccount>(&[ExtensionType::TransferFeeAmount])
            .unwrap();
    let mut data = vec![0u8; len];
    {
        let mut state =
            PodStateWithExtensionsMut::<PodAccount>::unpack_uninitialized(&mut data).unwrap();

        let ext = state.init_extension::<TransferFeeAmount>(true).unwrap();
        ext.withheld_amount = o.withheld.into();

        state.base.mint = *mint;
        state.base.owner = o.owner;
        state.base.amount = o.amount.into();
        state.base.state = if o.frozen {
            AccountState::Frozen as u8
        } else {
            AccountState::Initialized as u8
        };
        if let Some(d) = o.delegate {
            state.base.delegate = PodCOption::some(d);
        }
        if let Some(c) = o.close_authority {
            state.base.close_authority = PodCOption::some(c);
        }
        state.init_account_type().unwrap();
    }
    data
}

pub fn default_params(close_ts: i64) -> sale::SaleParams {
    sale::SaleParams {
        price_lamports: PRICE,
        supply_for_sale: SUPPLY,
        hard_cap_lamports: HARD_CAP,
        floor_lamports: FLOOR,
        min_bid_lamports: MIN_BID,
        close_ts,
        absolute_deadline: close_ts + 3_600,
        pool_deadline: close_ts + 86_400,
    }
}

pub struct Ctx {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub sale_key: Pubkey,
    pub now: i64,
}

pub fn setup(
    mint_opts: MintOpts,
    vault_override: Option<Box<dyn Fn(Pubkey) -> VaultOpts>>,
) -> Ctx {
    let mut svm = LiteSVM::new();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/sale.so"));
    svm.add_program(sale::id(), bytes).unwrap();

    let mint = Pubkey::new_unique();
    let (sale_key, _) = sale_pda(&mint);

    svm.set_account(
        mint,
        SolanaAccount {
            lamports: 10_000_000,
            data: build_mint(&mint_opts),
            owner: token_program_id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let vopts = match vault_override {
        Some(f) => f(sale_key),
        None => VaultOpts {
            owner: sale_key,
            // The shape a real funding transfer leaves: `amount` already net of the fee,
            // `withheld` beside it. Was `VAULT_AMOUNT` until 2026-08-09, which put withheld
            // *inside* amount — a state the live token program cannot produce.
            amount: SUPPLY,
            withheld: WITHHELD,
            delegate: None,
            close_authority: None,
            frozen: false,
        },
    };
    let vault = Pubkey::new_unique();
    svm.set_account(
        vault,
        SolanaAccount {
            lamports: 10_000_000,
            data: build_vault(&mint, &vopts),
            owner: token_program_id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let now = svm.get_sysvar::<solana_clock::Clock>().unix_timestamp;

    Ctx { svm, payer, mint, vault, sale_key, now }
}

pub fn send_init(ctx: &mut Ctx, params: sale::SaleParams) -> Result<(), String> {
    let (sol_vault, _) = sol_vault_pda(&ctx.sale_key);
    let ix = Instruction::new_with_bytes(
        sale::id(),
        &sale::instruction::InitializeSale { params }.data(),
        sale::accounts::InitializeSale {
            authority: ctx.payer.pubkey(),
            sale: ctx.sale_key,
            token_mint: ctx.mint,
            token_vault: ctx.vault,
            sol_vault,
            seed_destination: Pubkey::new_unique(),
            token_program: token_program_id(),
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
    );
    send(ctx, ix, &[])
}

/// A funded bidder wallet.
pub fn new_bidder(ctx: &mut Ctx, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    ctx.svm.airdrop(&kp.pubkey(), lamports).unwrap();
    kp
}

pub fn send_bid(ctx: &mut Ctx, bidder: &Keypair, amount: u64) -> Result<(), String> {
    send_bid_with_marker(ctx, bidder, amount, sale::constants::JITO_DONT_FRONT)
}

pub fn send_bid_with_marker(
    ctx: &mut Ctx,
    bidder: &Keypair,
    amount: u64,
    marker: Pubkey,
) -> Result<(), String> {
    let (sol_vault, _) = sol_vault_pda(&ctx.sale_key);
    let (commitment, _) = commit_pda(&ctx.sale_key, &bidder.pubkey());
    let ix = Instruction::new_with_bytes(
        sale::id(),
        &sale::instruction::Bid { amount }.data(),
        sale::accounts::Bid {
            bidder: bidder.pubkey(),
            sale: ctx.sale_key,
            commitment,
            sol_vault,
            jito_dont_front: marker,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
    );
    let payer = bidder.insecure_clone();
    send_as(ctx, ix, &payer, &[])
}

fn send(ctx: &mut Ctx, ix: Instruction, extra: &[&Keypair]) -> Result<(), String> {
    let payer = ctx.payer.insecure_clone();
    send_as(ctx, ix, &payer, extra)
}

fn send_as(
    ctx: &mut Ctx,
    ix: Instruction,
    payer: &Keypair,
    extra: &[&Keypair],
) -> Result<(), String> {
    send_many_as(ctx, &[ix], payer, extra)
}

pub fn send_many_as(
    ctx: &mut Ctx,
    ixs: &[Instruction],
    payer: &Keypair,
    extra: &[&Keypair],
) -> Result<(), String> {
    // Every send gets a fresh blockhash. Two identical bids (same payer, same amount,
    // same blockhash) hash to the same signature and are rejected as duplicates before
    // execution — which surfaces as an empty log array, not an error message.
    ctx.svm.expire_blockhash();
    let mut msg = Message::new(ixs, Some(&payer.pubkey()));
    msg.recent_blockhash = ctx.svm.latest_blockhash();
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
    ctx.svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e.meta.logs))
}

/// Finalize, paid for by `caller` — which is the point: it takes no signer, so anyone
/// with a funded wallet can settle the sale.
pub fn send_finalize(ctx: &mut Ctx, caller: &Keypair) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        sale::id(),
        &sale::instruction::Finalize {}.data(),
        sale::accounts::Finalize { sale: ctx.sale_key }.to_account_metas(None),
    );
    let payer = caller.insecure_clone();
    send_as(ctx, ix, &payer, &[])
}

pub fn send_fail_on_missing_pool(ctx: &mut Ctx, caller: &Keypair) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        sale::id(),
        &sale::instruction::FailOnMissingPool {}.data(),
        sale::accounts::FailOnMissingPool { sale: ctx.sale_key }.to_account_metas(None),
    );
    let payer = caller.insecure_clone();
    send_as(ctx, ix, &payer, &[])
}

/// Build a Raydium CPMM `PoolState` byte image from the layout validated against the
/// live devnet pool `6zKJcfz…`: discriminator, 637 bytes, ten pubkeys then five u8s then
/// seven u64s.
pub struct PoolOpts {
    /// `PoolState.pool_creator` — whoever sent the create-pool transaction. Anyone can
    /// create a CPMM pool for any mint pair, so this is what binds a pool to *this* launch.
    pub creator: Pubkey,
    pub lp_mint: Pubkey,
    pub token_0_mint: Pubkey,
    pub token_1_mint: Pubkey,
    pub open_time: u64,
    /// `PoolState.lp_supply`, which is stale after a burn. Set it non-zero in tests to
    /// prove the program does not consult it.
    pub lp_supply: u64,
}

pub fn build_pool(o: &PoolOpts) -> Vec<u8> {
    let mut d = vec![0u8; sale::constants::POOL_STATE_LEN];
    d[..8].copy_from_slice(&sale::constants::POOL_STATE_DISCRIMINATOR);
    // Offsets 8..296 are amm_config, pool_creator, the two vaults, lp_mint, the two
    // mints, the two token programs, observation_key.
    d[40..72].copy_from_slice(o.creator.as_ref());
    d[136..168].copy_from_slice(o.lp_mint.as_ref());
    d[168..200].copy_from_slice(o.token_0_mint.as_ref());
    d[200..232].copy_from_slice(o.token_1_mint.as_ref());
    d[333..341].copy_from_slice(&o.lp_supply.to_le_bytes()); // lp_supply
    d[373..381].copy_from_slice(&o.open_time.to_le_bytes()); // open_time
    d
}

/// An SPL-Token mint image with the given supply — the LP mint.
///
/// Built through `PodStateWithExtensionsMut` rather than hand-written offsets, so the
/// layout is the library's problem. A base-only mint has no extensions, so
/// `init_account_type` is deliberately not called.
pub fn build_plain_mint(supply: u64) -> Vec<u8> {
    let len = ExtensionType::try_calculate_account_len::<PodMint>(&[]).unwrap();
    let mut data = vec![0u8; len];
    {
        let mut state =
            PodStateWithExtensionsMut::<PodMint>::unpack_uninitialized(&mut data).unwrap();
        state.base.supply = supply.into();
        state.base.decimals = 9;
        state.base.is_initialized = true.into();
    }
    data
}

pub fn install_pool(ctx: &mut Ctx, o: &PoolOpts) -> Pubkey {
    let pool = Pubkey::new_unique();
    ctx.svm
        .set_account(
            pool,
            SolanaAccount {
                lamports: 10_000_000,
                data: build_pool(o),
                owner: sale::constants::RAYDIUM_CPMM_PROGRAM,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    pool
}

pub fn install_lp_mint(ctx: &mut Ctx, supply: u64) -> Pubkey {
    let lp = Pubkey::new_unique();
    ctx.svm
        .set_account(
            lp,
            SolanaAccount {
                lamports: 10_000_000,
                data: build_plain_mint(supply),
                // Legacy SPL Token — Raydium creates LP mints with it, and
                // InterfaceAccount<Mint> must accept both programs.
                owner: Pubkey::new_from_array(spl_token_interface_id()),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    lp
}

fn spl_token_interface_id() -> [u8; 32] {
    // TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
    anchor_spl::token::ID.to_bytes()
}

pub fn send_mark_pool_created(
    ctx: &mut Ctx,
    caller: &Keypair,
    pool: Pubkey,
    lp_mint: Pubkey,
) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        sale::id(),
        &sale::instruction::MarkPoolCreated {}.data(),
        sale::accounts::MarkPoolCreated { sale: ctx.sale_key, pool, lp_mint }
            .to_account_metas(None),
    );
    let payer = caller.insecure_clone();
    send_as(ctx, ix, &payer, &[])
}

/// Move the on-chain clock. `warp_to_slot` does not advance `unix_timestamp`, so
/// anything time-dependent has to be driven through the sysvar directly.
pub fn set_clock(ctx: &mut Ctx, unix_timestamp: i64) {
    let mut clock = ctx.svm.get_sysvar::<solana_clock::Clock>();
    clock.unix_timestamp = unix_timestamp;
    ctx.svm.set_sysvar(&clock);
}

pub fn read_sale(ctx: &Ctx) -> sale::Sale {
    let raw = ctx.svm.get_account(&ctx.sale_key).unwrap();
    sale::Sale::try_deserialize(&mut raw.data.as_slice()).unwrap()
}

pub fn read_commitment(ctx: &Ctx, bidder: &Pubkey) -> sale::Commitment {
    let (key, _) = commit_pda(&ctx.sale_key, bidder);
    let raw = ctx.svm.get_account(&key).unwrap();
    sale::Commitment::try_deserialize(&mut raw.data.as_slice()).unwrap()
}

pub fn balance(ctx: &Ctx, key: &Pubkey) -> u64 {
    ctx.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
}

pub fn sol_vault_balance(ctx: &Ctx) -> u64 {
    let (key, _) = sol_vault_pda(&ctx.sale_key);
    ctx.svm.get_account(&key).map(|a| a.lamports).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Claims and refunds
// ---------------------------------------------------------------------------

pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program_id().as_ref(), mint.as_ref()],
        &anchor_spl::associated_token::ID,
    )
    .0
}

/// Build a `claim` instruction, with every account overridable so the negative tests can
/// swap one at a time.
pub fn claim_ix(ctx: &Ctx, bidder: &Pubkey, marker: Pubkey, sysvar: Pubkey) -> Instruction {
    let (sol_vault, _) = sol_vault_pda(&ctx.sale_key);
    let (commitment, _) = commit_pda(&ctx.sale_key, bidder);
    Instruction::new_with_bytes(
        sale::id(),
        &sale::instruction::Claim {}.data(),
        sale::accounts::Claim {
            bidder: *bidder,
            sale: ctx.sale_key,
            commitment,
            token_mint: ctx.mint,
            token_vault: ctx.vault,
            bidder_token_account: ata(bidder, &ctx.mint),
            sol_vault,
            jito_dont_front: marker,
            instructions_sysvar: sysvar,
            token_program: token_program_id(),
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn send_claim(ctx: &mut Ctx, bidder: &Keypair) -> Result<(), String> {
    let ix = claim_ix(
        ctx,
        &bidder.pubkey(),
        sale::constants::JITO_DONT_FRONT,
        sale::constants::INSTRUCTIONS_SYSVAR,
    );
    let payer = bidder.insecure_clone();
    send_as(ctx, ix, &payer, &[])
}

/// Refund is permissionless: `caller` pays the fee, `bidder` receives the lamports and
/// never signs.
pub fn send_refund(ctx: &mut Ctx, caller: &Keypair, bidder: &Pubkey) -> Result<(), String> {
    let (sol_vault, _) = sol_vault_pda(&ctx.sale_key);
    let (commitment, _) = commit_pda(&ctx.sale_key, bidder);
    let ix = Instruction::new_with_bytes(
        sale::id(),
        &sale::instruction::Refund {}.data(),
        sale::accounts::Refund {
            payer: caller.pubkey(),
            bidder: *bidder,
            sale: ctx.sale_key,
            commitment,
            sol_vault,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
    );
    let payer = caller.insecure_clone();
    send_as(ctx, ix, &payer, &[])
}

/// `base.amount` — **the spendable balance, and what a wallet displays.**
///
/// Measured against the live Token-2022 program on 2026-08-08: a transfer of `X` into a
/// fresh account leaves `base.amount = X - fee` and `withheld_amount = fee`, while the
/// source is debited the full `X`. Conservation only works if withheld is held *alongside*
/// `amount`, not inside it — so `amount` is already net of the fee and nothing should be
/// subtracted from it. See `token_withheld`.
pub fn token_balance(ctx: &Ctx, key: &Pubkey) -> u64 {
    let raw = match ctx.svm.get_account(key) {
        Some(a) => a,
        None => return 0,
    };
    let state = PodStateWithExtensions::<PodAccount>::unpack(&raw.data).unwrap();
    state.base.amount.into()
}

/// Fees parked on the account, owed to the mint's withdraw-withheld authority. Additional
/// to `base.amount`, never part of it — and non-zero here is what blocks `CloseAccount`
/// forever (`AccountHasWithheldTransferFees`).
pub fn token_withheld(ctx: &Ctx, key: &Pubkey) -> u64 {
    let raw = match ctx.svm.get_account(key) {
        Some(a) => a,
        None => return 0,
    };
    let state = PodStateWithExtensions::<PodAccount>::unpack(&raw.data).unwrap();
    match state.get_extension::<TransferFeeAmount>() {
        Ok(ext) => ext.withheld_amount.into(),
        Err(_) => 0,
    }
}

/// The 25 bps fee Token-2022 will take on a transfer of `gross`. Rounded **up** — never
/// hand-roll this in production code, the mint's own config is the authority.
pub fn fee_on(gross: u64) -> u64 {
    ((gross as u128 * 25).div_ceil(10_000)) as u64
}

/// A mint's `supply` field, for checking that a burn actually destroyed tokens.
pub fn mint_supply(ctx: &Ctx, key: &Pubkey) -> u64 {
    let raw = ctx.svm.get_account(key).unwrap();
    let state = PodStateWithExtensions::<PodMint>::unpack(&raw.data).unwrap();
    state.base.supply.into()
}

// ---------------------------------------------------------------------------
// Proceeds
// ---------------------------------------------------------------------------

/// The `seed_destination` recorded at initialize. `send_init` generates it fresh each run,
/// so tests read it back off the sale rather than guessing.
pub fn seed_destination(ctx: &Ctx) -> Pubkey {
    read_sale(ctx).seed_destination
}

pub fn send_sweep(ctx: &mut Ctx, caller: &Keypair) -> Result<(), String> {
    send_sweep_to(ctx, caller, seed_destination(ctx))
}

pub fn send_sweep_to(
    ctx: &mut Ctx,
    caller: &Keypair,
    destination: Pubkey,
) -> Result<(), String> {
    let (sol_vault, _) = sol_vault_pda(&ctx.sale_key);
    let ix = Instruction::new_with_bytes(
        sale::id(),
        &sale::instruction::SweepProceeds {}.data(),
        sale::accounts::SweepProceeds {
            payer: caller.pubkey(),
            sale: ctx.sale_key,
            seed_destination: destination,
            sol_vault,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
    );
    let payer = caller.insecure_clone();
    send_as(ctx, ix, &payer, &[])
}

pub fn send_burn_unsold(ctx: &mut Ctx, caller: &Keypair) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        sale::id(),
        &sale::instruction::BurnUnsold {}.data(),
        sale::accounts::BurnUnsold {
            payer: caller.pubkey(),
            sale: ctx.sale_key,
            token_mint: ctx.mint,
            token_vault: ctx.vault,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
    );
    let payer = caller.insecure_clone();
    send_as(ctx, ix, &payer, &[])
}

/// Open a sale, take the given bids, settle it, prove a pool, and move the clock past the
/// pool's `open_time` — i.e. everything `claim` requires, and nothing more.
///
/// Returns the funded bidder wallets in the order their amounts were given.
pub fn drive_to_claimable(ctx: &mut Ctx, amounts: &[u64]) -> Vec<Keypair> {
    let close_ts = ctx.now + 3_600;
    drive_to_claimable_with(ctx, default_params(close_ts), amounts)
}

pub fn drive_to_claimable_with(
    ctx: &mut Ctx,
    params: sale::SaleParams,
    amounts: &[u64],
) -> Vec<Keypair> {
    let close_ts = params.close_ts;
    let pool_deadline = params.pool_deadline;
    send_init(ctx, params).unwrap();

    let mut bidders = Vec::new();
    for amount in amounts {
        let kp = new_bidder(ctx, amount + 1_000_000_000);
        send_bid(ctx, &kp, *amount).unwrap();
        bidders.push(kp);
    }

    set_clock(ctx, close_ts + 1);
    let caller = new_bidder(ctx, 1_000_000_000);
    send_finalize(ctx, &caller).unwrap();

    // `pool_creator` must be the sale authority, and `open_time` must not be later than
    // `pool_deadline` — both enforced by `mark_pool_created`.
    let open_time = (close_ts + 7_200).min(pool_deadline) as u64;
    let lp_mint = install_lp_mint(ctx, 0);
    let pool = install_pool(
        ctx,
        &PoolOpts {
            creator: ctx.payer.pubkey(),
            lp_mint,
            token_0_mint: Pubkey::new_unique(),
            token_1_mint: ctx.mint,
            open_time,
            lp_supply: 315_832_233_947,
        },
    );
    send_mark_pool_created(ctx, &caller, pool, lp_mint).unwrap();

    set_clock(ctx, open_time as i64 + 1);
    bidders
}
