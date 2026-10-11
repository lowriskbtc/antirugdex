/**
 * Opens a sale: funds the token vault, then calls `initialize_sale`.
 *
 *   npx tsx src/11-sale-init.ts                  # dry run, prints the plan
 *   $env:CONFIRM='yes'; npx tsx src/11-sale-init.ts
 *
 * Env knobs (all rehearsal-sized by default — these are NOT the launch numbers):
 *   SALE_TOKENS=200000000   whole tokens to move into the vault
 *   SALE_PRICE=100          lamports per whole token
 *   SALE_CAP=2              hard cap, SOL
 *   SALE_FLOOR=0.5          minimum floor, SOL — below it everyone refunds
 *   SALE_MIN_BID=0.05       minimum bid, SOL
 *   SALE_WINDOW=900         bid window, seconds
 *   SALE_GRACE=3600         close_ts -> absolute_deadline, seconds. Minimum 300
 *   SALE_POOL_GRACE=3600    absolute_deadline -> pool_deadline, seconds. Minimum 1
 *
 * `SALE_GRACE` and `SALE_POOL_GRACE` default to the 3600 that was hardcoded here until
 * 2026-08-10, so the launch path is byte-for-byte unchanged unless someone sets them.
 * They exist because `fail_on_missing_pool` cannot be rehearsed otherwise: it needs
 * `now >= pool_deadline`, and with both offsets fixed at an hour, proving the abandonment
 * refund path on devnet meant a two-hour wait. **Shortening a safety deadline is a
 * rehearsal tool. Never pass these on mainnet** — 00-preflight and mainnetGuard do not
 * check them, because they are parameters rather than configuration.
 *
 * ── Two things here are easy to get wrong and expensive to discover late ──
 *
 * 1. **`supply_for_sale` is measured, never assumed.** Funding the vault is an ordinary
 *    transfer, so the 0.25% fee takes a cut on the way in. Worse, the program's
 *    `vault_spendable_amount` computes `amount - withheld`, and `amount` is ALREADY net of
 *    the fee — so it is conservative by one further fee (measured 2026-08-08; see
 *    SALE-PROGRAM.md open items). Rather than gross up by a factor and hope, this funds the
 *    vault first, reads the vault back, computes the number the program itself will
 *    compute, and declares exactly that. The same approach the LiteSVM tests take.
 *
 * 2. **The pool seed does not come from the raise.** `sweep_proceeds` requires
 *    `pool_created`, because a swept vault plus a pool that never appears turns
 *    `fail_on_missing_pool` into unrecoverable loss of every bidder's principal. So you
 *    front the pool seed yourself and sweep to reimburse. Size the cap against what you can
 *    front, not only against what you want to raise.
 */

import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  assertClusterMatchesRpc,
  CLUSTER,
  connection,
  explorer,
  fmt,
  loadKeypair,
  mainnetGuard,
  readMint,
  send,
} from "./lib.js";
import {
  assertIdlMatchesChain,
  buildIx,
  encodeSaleParams,
  fetchSale,
  programId,
  salePda,
  solVaultPda,
} from "./sale-client.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;

function envBig(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  return v === undefined ? fallback : BigInt(v);
}
function envSol(name: string, fallbackSol: string): bigint {
  const v = process.env[name] ?? fallbackSol;
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt((frac + "000000000").slice(0, 9));
}

async function main() {
  await assertClusterMatchesRpc();
  mainnetGuard("open a sale");
  const conn = connection();
  await assertIdlMatchesChain(conn);

  const authority = loadKeypair("DEPLOYER_KEYPAIR");
  const mint = new PublicKey(readMint().mint);
  const [sale, saleBump] = salePda(mint);
  const [solVault] = solVaultPda(sale);

  const existing = await fetchSale(conn, sale);
  if (existing) {
    console.log(`\nA sale already exists at ${sale.toBase58()} (status ${existing.status}).`);
    console.log(`There is one Sale PDA per mint, so this is terminal for this mint.\n`);
    console.log(`  npx tsx src/10-sale-status.ts\n`);
    process.exit(1);
  }

  const mintInfo = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const decimals = mintInfo.decimals;
  const D = 10n ** BigInt(decimals);

  // The vault is an ATA owned by the sale PDA. Off-curve owner, so allowOwnerOffCurve.
  // An ATA has no delegate and no close authority, which is what Phase 0 demands.
  const vault = getAssociatedTokenAddressSync(mint, sale, true, TOKEN_2022_PROGRAM_ID);
  const source = getAssociatedTokenAddressSync(
    mint,
    authority.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  const tokens = envBig("SALE_TOKENS", 200_000_000n);
  const toSend = tokens * D;
  const price = envBig("SALE_PRICE", 100n);
  const cap = envSol("SALE_CAP", "2");
  const floor = envSol("SALE_FLOOR", "0.5");
  const minBid = envSol("SALE_MIN_BID", "0.05");
  const window = Number(envBig("SALE_WINDOW", 900n));

  const feeCfg = getTransferFeeConfig(mintInfo);
  const bps = BigInt(feeCfg?.newerTransferFee.transferFeeBasisPoints ?? 0);

  console.log(`\nOpen a sale — ${CLUSTER}`);
  console.log(`  program   : ${programId().toBase58()}`);
  console.log(`  mint      : ${mint.toBase58()}  (${decimals} decimals, ${bps} bps fee)`);
  console.log(`  sale PDA  : ${sale.toBase58()}  (bump ${saleBump})`);
  console.log(`  token vault: ${vault.toBase58()}`);
  console.log(`  sol vault : ${solVault.toBase58()}`);
  console.log(`  authority : ${authority.publicKey.toBase58()}`);

  const srcAcct = await getAccount(conn, source, "confirmed", TOKEN_2022_PROGRAM_ID).catch(
    () => undefined,
  );
  if (!srcAcct) throw new Error(`Authority holds no ${mint.toBase58()} account (${source})`);
  console.log(`\n  authority holds : ${fmt(srcAcct.amount, decimals)} tokens`);
  console.log(`  moving to vault : ${fmt(toSend, decimals)} tokens`);
  if (srcAcct.amount < toSend)
    throw new Error(
      `Not enough tokens: holding ${fmt(srcAcct.amount, decimals)}, need ${fmt(toSend, decimals)}`,
    );

  // What the program will measure, once the fee has taken its cut on the way in.
  // Predicted here only to show the plan; the real value is READ BACK after funding.
  const fee = bps === 0n ? 0n : (toSend * bps + 9_999n) / 10_000n;
  const predictedSpendable = toSend - fee;
  const maxRaise = (predictedSpendable * price) / D;

  console.log(`\n  transfer fee    : ${fmt(fee, decimals)} tokens`);
  console.log(`  vault will hold : ${fmt(toSend - fee, decimals)} spendable + ${fmt(fee, decimals)} withheld`);
  console.log(`  program will see: ${fmt(predictedSpendable, decimals)}  (base.amount — withheld sits beside it, not inside)`);

  console.log(`\nTERMS`);
  console.log(`  price     : ${price} lamports per whole token`);
  console.log(`  hard cap  : ${fmt(cap, 9)} SOL`);
  console.log(`  floor     : ${fmt(floor, 9)} SOL`);
  console.log(`  min bid   : ${fmt(minBid, 9)} SOL`);
  console.log(`  window    : ${window}s`);
  console.log(`  cap ceiling from supply: ${fmt(maxRaise, 9)} SOL  ${cap <= maxRaise ? "OK" : "TOO SMALL — initialize will reject"}`);
  if (cap > maxRaise)
    throw new Error(
      `hard cap ${fmt(cap, 9)} SOL exceeds what the supply covers at this price ` +
        `(${fmt(maxRaise, 9)} SOL). Raise SALE_TOKENS or SALE_PRICE, or lower SALE_CAP.`,
    );

  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — nothing sent. Re-run with CONFIRM=yes to execute.\n`);
    console.log(`  $env:CONFIRM='yes'; npx tsx src/11-sale-init.ts`);
    console.log(`  $env:CONFIRM=''\n`);
    return;
  }

  // ---- 1. Fund the vault --------------------------------------------------
  const vaultExists = await conn.getAccountInfo(vault);
  const fundIxs: TransactionInstruction[] = [];
  if (!vaultExists)
    fundIxs.push(
      createAssociatedTokenAccountInstruction(
        authority.publicKey,
        vault,
        sale,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  fundIxs.push(
    createTransferCheckedInstruction(
      source,
      mint,
      vault,
      authority.publicKey,
      toSend,
      decimals,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  console.log(`\n-> funding the vault`);
  await send(conn, fundIxs, [authority], "fund vault");

  // ---- 2. Measure what the program will measure ---------------------------
  //
  // `spendable` is `base.amount` and nothing is subtracted from it. Withheld fees sit
  // BESIDE `amount`, not inside it — measured against the live token program 2026-08-08 —
  // so `amount` is already net of the funding fee.
  //
  // This used to be `amount - withheld`, mirroring the program's own helper. Both were
  // wrong in the same direction and the cost was not theoretical: the 2026-08-09 rehearsal
  // declared one fee less than the vault held, and `burn_unsold` (which burns a recorded
  // figure, not the balance, and runs once) left 500,000 ARD permanently out of reach.
  // Fixed in `vault_spendable_amount` the same day; this must not drift back.
  const vaultAcct = await getAccount(conn, vault, "confirmed", TOKEN_2022_PROGRAM_ID);
  const withheld = vaultAcct.tlvData ? readWithheld(conn, vaultAcct) : 0n;
  const spendable = vaultAcct.amount;
  console.log(`\n  vault amount   : ${fmt(vaultAcct.amount, decimals)}`);
  console.log(`  vault withheld : ${fmt(withheld, decimals)}   (beside amount, never sellable — harvest moves it)`);
  console.log(`  supply_for_sale: ${fmt(spendable, decimals)}   <- declared, not assumed`);
  console.log(`                   the vault's full spendable balance: nothing held back, so`);
  console.log(`                   burn_unsold can empty it and nothing is stranded.`);

  const recheck = (spendable * price) / D;
  if (cap > recheck)
    throw new Error(
      `After the fee, the vault only covers ${fmt(recheck, 9)} SOL at this price, ` +
        `below the ${fmt(cap, 9)} SOL cap. The vault is funded; re-run with a lower SALE_CAP.`,
    );

  // ---- 3. initialize_sale -------------------------------------------------
  const now = BigInt(Math.floor(Date.now() / 1000));
  const closeTs = now + BigInt(window);

  // Both offsets were hardcoded at 3600 until 2026-08-10 and still default to it. See the
  // header: they are configurable only so the abandonment path can be rehearsed on devnet.
  //
  // The 300 floor is the program's, not ours — initialize_sale requires
  // `absolute_deadline - close_ts >= EXTENSION_SECONDS` so the activity extension can fire
  // at least once, rejecting anything tighter with ExtensionWindowTooTight. Checking it
  // here turns a decoded on-chain error into a sentence.
  const grace = envBig("SALE_GRACE", 3600n);
  const poolGrace = envBig("SALE_POOL_GRACE", 3600n);
  if (grace < 300n)
    throw new Error(
      `SALE_GRACE=${grace} is below the program's 300s minimum (EXTENSION_SECONDS).\n` +
        `  initialize_sale would reject it with ExtensionWindowTooTight.`,
    );
  if (poolGrace < 1n)
    throw new Error(
      `SALE_POOL_GRACE=${poolGrace} — pool_deadline must be strictly after absolute_deadline.`,
    );

  const absoluteDeadline = closeTs + grace;
  const poolDeadline = absoluteDeadline + poolGrace;

  const ix = buildIx("initialize_sale", {
    authority: authority.publicKey,
    sale,
    token_mint: mint,
    token_vault: vault,
    sol_vault: solVault,
    // Proceeds may go here and nowhere else, recorded before the first bid.
    seed_destination: authority.publicKey,
    token_program: TOKEN_2022_PROGRAM_ID,
  }, encodeSaleParams({
    price_lamports: price,
    supply_for_sale: spendable,
    hard_cap_lamports: cap,
    floor_lamports: floor,
    min_bid_lamports: minBid,
    close_ts: closeTs,
    absolute_deadline: absoluteDeadline,
    pool_deadline: poolDeadline,
  }));

  console.log(`\n-> initialize_sale`);
  await send(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }), ix],
    [authority],
    "initialize_sale",
  );

  console.log(`\nSale open: ${explorer(sale)}`);
  console.log(`  closes at         ${new Date(Number(closeTs) * 1000).toISOString()}   finalize needs now >= this`);
  console.log(`  absolute deadline ${new Date(Number(absoluteDeadline) * 1000).toISOString()}   the extension can never cross this`);
  console.log(`  pool deadline     ${new Date(Number(poolDeadline) * 1000).toISOString()}   fail_on_missing_pool needs now >= this`);
  console.log(`\n  npx tsx src/10-sale-status.ts\n`);
}

/** The withheld amount lives in the account's TransferFeeAmount extension. */
function readWithheld(_conn: unknown, acct: { tlvData: Buffer }): bigint {
  // Extension type 2 = TransferFeeAmount, payload is a single u64.
  const d = acct.tlvData;
  let off = 0;
  while (off + 4 <= d.length) {
    const type = d.readUInt16LE(off);
    const len = d.readUInt16LE(off + 2);
    if (type === 2 && len >= 8) return d.readBigUInt64LE(off + 4);
    off += 4 + len;
  }
  return 0n;
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
