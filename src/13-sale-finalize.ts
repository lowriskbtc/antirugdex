/**
 * Phase 2 — closes bidding and records the outcome.
 *
 *   npx tsx src/13-sale-finalize.ts                 # dry run
 *   $env:CONFIRM='yes'; npx tsx src/13-sale-finalize.ts
 *
 * PERMISSIONLESS. `finalize` takes exactly one account — the sale — and no signer of its
 * own, so the wallet here pays the fee and nothing else. Any funded key would do; the
 * deployer is used only because it is the one already configured.
 *
 * The outcome is a pure function of recorded state: `Succeeded` if `total_committed >=
 * floor_lamports`, `Failed` otherwise. This script predicts it from the fetched account
 * before sending, so a disagreement with the on-chain result is visible immediately rather
 * than being discovered later as a surprise status.
 */

import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
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
import { buildIx, fetchSale, salePda } from "./sale-client.js";

async function main() {
  await assertClusterMatchesRpc();
  mainnetGuard("finalize a sale");
  const conn = connection();

  const mint = new PublicKey(process.argv[2] ?? readMint().mint);
  const [sale] = salePda(mint);

  const s = await fetchSale(conn, sale);
  if (!s) throw new Error(`No sale at ${sale.toBase58()}`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const predicted = s.total_committed < s.floor_lamports ? "Failed" : "Succeeded";

  console.log(`\nFinalize — ${CLUSTER}`);
  console.log(`  sale      : ${sale.toBase58()}  ${explorer(sale)}`);
  console.log(`  status    : ${s.status}`);
  console.log(`  committed : ${fmt(s.total_committed, 9)} SOL  vs floor ${fmt(s.floor_lamports, 9)} SOL`);
  console.log(`  closes    : ${new Date(Number(s.close_ts) * 1000).toISOString()}  (${Number(s.close_ts - now)}s from now)`);
  console.log(`  PREDICTED : ${predicted}`);

  if (s.status !== "Bidding")
    throw new Error(`Sale is already ${s.status} — finalize only acts on Bidding.`);
  if (now < s.close_ts)
    throw new Error(
      `Bidding is still open for ${Number(s.close_ts - now)}s. finalize would fail with ` +
        `SaleStillOpen.\n  Note close_ts moves: a bid inside the last 5 minutes extends it.`,
    );

  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — nothing sent. Re-run with CONFIRM=yes.\n`);
    return;
  }

  const payer = loadKeypair("DEPLOYER_KEYPAIR");
  const ix = buildIx("finalize", { sale });

  console.log(`\n-> finalize (fee paid by ${payer.publicKey.toBase58()})`);
  await send(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }), ix],
    [payer],
    "finalize",
  );

  const after = await fetchSale(conn, sale);
  console.log(`\n  status now : ${after!.status}`);
  if (after!.status !== predicted)
    console.log(
      `  FLAGGED    : chain says ${after!.status}, this script predicted ${predicted}.\n` +
        `               That is a real disagreement about recorded state, not a rounding\n` +
        `               quibble. Stop and read the Sale account before continuing.`,
    );
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
