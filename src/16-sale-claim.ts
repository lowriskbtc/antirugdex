/**
 * Settles one commitment on a Succeeded sale: tokens out, pro-rata excess back.
 *
 *   npx tsx src/16-sale-claim.ts                       # dry run, deployer's own commitment
 *   $env:CONFIRM='yes'; npx tsx src/16-sale-claim.ts
 *   ... CLAIM_WALLET=bidders.devnet/Gz….json           # claim as another bidder
 *
 * ## One claim per transaction — this is enforced, not advisory
 *
 * `require_unbundled` demands that exactly one top-level instruction in the transaction
 * targets this program, and that `claim` itself is top-level. Batching both bidders'
 * claims into one transaction fails with `MultipleOwnInstructions`; wrapping it in a CPI
 * fails with `NotTopLevel`. The ComputeBudget instruction this script prepends belongs to a
 * different program, so it does not count.
 *
 * Honest scope, same as the program's own comment: this stops a router CPI-wrapping the
 * claim and stops batching. It does NOT stop `[claim, raydium_swap]` as two top-level
 * instructions — both sit at stack height 1 and the swap targets Raydium, not us.
 *
 * ## The bidder receives LESS than the allocation — always quote the net
 *
 * The claim moves tokens by ordinary Token-2022 `transfer_checked`, so the mint's transfer
 * fee applies exactly as it would to any other transfer. The vault is debited the gross;
 * the bidder's account is credited the gross minus the fee, with the fee withheld on their
 * own account. Every router and every UI that quotes `alloc.tokens` overstates what lands.
 * This script prints both and labels which is which.
 *
 * ## Compute
 *
 * 400k units, not the 60k used for `bid`. A claim can create an ATA (`init_if_needed`), do
 * a `transfer_checked` CPI, do a system transfer for the refund, and walk the instructions
 * sysvar. The bid does none of that.
 */

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeAmount,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";
import {
  assertClusterMatchesRpc,
  CLUSTER,
  connection,
  explorer,
  fmt,
  loadKeypair,
  loadKeypairFromPath,
  mainnetGuard,
  readMint,
  send,
} from "./lib.js";
import {
  buildIx,
  commitPda,
  fetchCommitment,
  fetchSale,
  salePda,
  solVaultPda,
  SYSTEM_PROGRAM,
} from "./sale-client.js";

/** Mirrors `allocate` in claim.rs. Floor division throughout, u128 via BigInt. */
function allocate(
  s: {
    total_committed: bigint;
    hard_cap_lamports: bigint;
    supply_for_sale: bigint;
    price_lamports: bigint;
    decimals: number;
  },
  c: bigint,
): { tokens: bigint; accepted: bigint; refund: bigint } {
  if (s.total_committed <= s.hard_cap_lamports) {
    const d = 10n ** BigInt(s.decimals);
    return { tokens: (c * d) / s.price_lamports, accepted: c, refund: 0n };
  }
  const tokens = (c * s.supply_for_sale) / s.total_committed;
  const accepted = (c * s.hard_cap_lamports) / s.total_committed;
  return { tokens, accepted, refund: c - accepted };
}

/** Token-2022's own rule: ceil(amount * bps / 10000), capped at maximumFee. */
function transferFee(amount: bigint, bps: number, maxFee: bigint): bigint {
  if (bps === 0) return 0n;
  const raw = (amount * BigInt(bps) + 9999n) / 10000n;
  return raw > maxFee ? maxFee : raw;
}

async function main() {
  await assertClusterMatchesRpc();
  mainnetGuard("claim from a sale");
  const conn = connection();

  const mint = new PublicKey(readMint().mint);
  const [sale] = salePda(mint);
  const [solVault] = solVaultPda(sale);

  const s = await fetchSale(conn, sale);
  if (!s) throw new Error(`No sale at ${sale.toBase58()}`);

  const walletPath = process.env.CLAIM_WALLET;
  const bidder: Keypair = walletPath
    ? loadKeypairFromPath(path.resolve(walletPath), "CLAIM_WALLET")
    : loadKeypair("DEPLOYER_KEYPAIR");

  const [commitment] = commitPda(sale, bidder.publicKey);
  const c = await fetchCommitment(conn, commitment);
  if (!c)
    throw new Error(
      `No commitment for ${bidder.publicKey.toBase58()} in this sale.\n` +
        `  Expected at ${commitment.toBase58()}. Wrong wallet?`,
    );

  const info = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeCfg = getTransferFeeConfig(info);
  const bps = feeCfg?.newerTransferFee.transferFeeBasisPoints ?? 0;
  const maxFee = feeCfg?.newerTransferFee.maximumFee ?? 0n;

  const alloc = allocate(s, c.amount);
  const fee = transferFee(alloc.tokens, bps, maxFee);
  const net = alloc.tokens - fee;

  const ata = getAssociatedTokenAddressSync(
    mint,
    bidder.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const ataExists = (await conn.getAccountInfo(ata)) !== null;
  const solBefore = BigInt(await conn.getBalance(bidder.publicKey));

  // Bidder A here IS the deployer, whose ATA already holds ~799M ARD left over from the
  // mint. Comparing the post-claim balance against the expected net would then "fail" by
  // the entire pre-existing holding. The claim is only ever a delta on this account.
  const tokensBefore = ataExists
    ? (await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount
    : 0n;
  const withheldBefore = ataExists
    ? (getTransferFeeAmount(
        await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID),
      )?.withheldAmount ?? 0n)
    : 0n;

  console.log(`\nClaim — ${CLUSTER}`);
  console.log(`  sale        : ${sale.toBase58()}  (${s.status})`);
  console.log(`  bidder      : ${bidder.publicKey.toBase58()}${walletPath ? `  (${walletPath})` : "  (deployer)"}`);
  console.log(`  commitment  : ${commitment.toBase58()}  ${fmt(c.amount, 9)} SOL${c.claimed ? "  ALREADY CLAIMED" : ""}`);
  console.log(`  token acct  : ${ata.toBase58()}${ataExists ? `  (exists, holds ${fmt(tokensBefore, info.decimals)})` : "  (will be created — bidder pays ~0.002 SOL rent)"}`);
  console.log(`  bidder SOL  : ${fmt(solBefore, 9)}`);

  console.log(`\n  ALLOCATION — floor(c_i * S / C) and floor(c_i * cap / C)`);
  console.log(`  tokens gross : ${alloc.tokens} base units  (${fmt(alloc.tokens, s.decimals)})`);
  console.log(`  transfer fee : ${fee}  (${bps} bps, applied to the claim like any transfer)`);
  console.log(`  TOKENS NET   : ${net} base units  (${fmt(net, s.decimals)})   <-- what actually lands`);
  console.log(`  accepted     : ${alloc.accepted} lamports`);
  console.log(`  refund       : ${alloc.refund} lamports  (${fmt(alloc.refund, 9)} SOL)`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (c.claimed) throw new Error("This commitment is already settled — AlreadyClaimed.");
  if (s.status !== "Succeeded") throw new Error(`Sale is ${s.status} — claim needs Succeeded.`);
  if (!s.pool_created) throw new Error("pool_created is false — PoolNotCreated.");
  if (now < s.pool_open_time)
    throw new Error(
      `Claims open at ${new Date(Number(s.pool_open_time) * 1000).toISOString()} — ClaimsNotOpen.`,
    );
  // The ATA rent is paid by the bidder up front; the refund only arrives later in the same
  // handler. A bidder who committed nearly everything can be short at exactly this point.
  if (!ataExists && solBefore < 3_000_000n)
    throw new Error(
      `${bidder.publicKey.toBase58()} has ${solBefore} lamports and must fund an ATA first.\n` +
        `  Fund it before claiming — the refund arrives too late to pay for the account.`,
    );

  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — nothing sent. Re-run with CONFIRM=yes.\n`);
    return;
  }

  const ix = buildIx("claim", {
    bidder: bidder.publicKey,
    sale,
    commitment,
    token_mint: mint,
    token_vault: s.token_vault,
    bidder_token_account: ata,
    sol_vault: solVault,
    token_program: TOKEN_2022_PROGRAM_ID,
    system_program: SYSTEM_PROGRAM,
  });

  console.log(`\n-> claim`);
  // One claim, one transaction. Never add a second instruction that targets this program.
  await send(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix],
    [bidder],
    "claim",
  );

  const acct = await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
  const withheld = getTransferFeeAmount(acct)?.withheldAmount ?? 0n;
  const cAfter = await fetchCommitment(conn, commitment);
  const sAfter = await fetchSale(conn, sale);
  const solAfter = BigInt(await conn.getBalance(bidder.publicKey));

  console.log(`\n  RECORDED BY THE PROGRAM`);
  console.log(`  tokens_claimed    : ${cAfter!.tokens_claimed}  (gross, debited from the vault)`);
  console.log(`  lamports_refunded : ${cAfter!.lamports_refunded}`);
  console.log(`  claim_count       : ${sAfter!.claim_count} of ${sAfter!.commitment_count}`);
  console.log(`  total_accepted    : ${sAfter!.total_accepted_lamports} lamports`);

  const gained = acct.amount - tokensBefore;
  console.log(`\n  ACTUALLY IN THE BIDDER'S ACCOUNT — as a delta, not a balance`);
  console.log(`  spendable    : ${tokensBefore} -> ${acct.amount}   gained ${gained}  (${fmt(gained, s.decimals)})`);
  console.log(`  withheld fee : ${withheldBefore} -> ${withheld}   ${explorer(ata)}`);
  console.log(`  SOL          : ${fmt(solBefore, 9)} -> ${fmt(solAfter, 9)}  (refund in, fee + any ATA rent out)`);

  if (cAfter!.tokens_claimed !== alloc.tokens)
    console.log(`  FLAGGED      : predicted gross ${alloc.tokens}, chain recorded ${cAfter!.tokens_claimed}.`);
  if (cAfter!.lamports_refunded !== alloc.refund)
    console.log(`  FLAGGED      : predicted refund ${alloc.refund}, chain recorded ${cAfter!.lamports_refunded}.`);
  if (gained !== net)
    console.log(`  FLAGGED      : predicted net ${net}, account gained ${gained}.`);
  if (withheld - withheldBefore !== fee)
    console.log(`  FLAGGED      : predicted fee ${fee}, account withheld ${withheld - withheldBefore}.`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
