/**
 * Read-only. Prints everything about a sale that a bidder would need to decide, and
 * nothing it cannot prove from chain.
 *
 *   npx tsx src/10-sale-status.ts [<mint>]
 *
 * Defaults to the mint recorded in `mint.<cluster>.json`.
 *
 * Follows the grader's three rules, which the sale tooling inherits:
 *   1. Read chain, never config — every number here is decoded from the Sale account.
 *   2. No pass/fail badge.
 *   3. A check that could not run is FLAGGED, never silent.
 */

import { PublicKey } from "@solana/web3.js";
import {
  assertClusterMatchesRpc,
  CLUSTER,
  connection,
  explorer,
  fmt,
  readMint,
} from "./lib.js";
import {
  assertIdlMatchesChain,
  commitPda,
  fetchSale,
  IDL_PATH,
  programId,
  salePda,
  solVaultPda,
} from "./sale-client.js";

const LAMPORTS = 1_000_000_000n;

function sol(v: bigint): string {
  return `${fmt(v, 9)} SOL`;
}

function ts(v: bigint): string {
  if (v === 0n) return "(unset)";
  const d = new Date(Number(v) * 1000);
  const delta = Number(v) - Math.floor(Date.now() / 1000);
  const rel =
    Math.abs(delta) < 60
      ? `${delta}s`
      : Math.abs(delta) < 3600
        ? `${Math.round(delta / 60)}m`
        : `${(delta / 3600).toFixed(1)}h`;
  return `${d.toISOString().replace("T", " ").slice(0, 19)}Z  (${delta >= 0 ? "in " : ""}${rel}${delta < 0 ? " ago" : ""})`;
}

async function main() {
  await assertClusterMatchesRpc();
  const conn = connection();

  const mintArg = process.argv[2] ?? readMint().mint;
  const mint = new PublicKey(mintArg);
  const [sale] = salePda(mint);
  const [solVault] = solVaultPda(sale);

  console.log(`\nAntiRugDex sale status — ${CLUSTER}`);
  console.log(`  program : ${programId().toBase58()}`);
  console.log(`  idl     : ${IDL_PATH}`);
  console.log(`  mint    : ${mint.toBase58()}`);
  console.log(`  sale    : ${sale.toBase58()}  ${explorer(sale)}\n`);

  await assertIdlMatchesChain(conn);

  const s = await fetchSale(conn, sale);
  if (!s) {
    console.log("No sale exists for this mint yet.\n");
    console.log("  Nothing has been initialized at the sale PDA above. This is the");
    console.log("  expected state before `initialize_sale` runs.\n");
    return;
  }

  const C = s.total_committed;
  const cap = s.hard_cap_lamports;
  const over = C > cap;

  console.log("TERMS — fixed before the first bid, and immutable after");
  console.log(`  price          : ${sol(s.price_lamports)} per whole token`);
  console.log(`  supply         : ${fmt(s.supply_for_sale, s.decimals)} tokens`);
  console.log(`  hard cap       : ${sol(cap)}`);
  console.log(`  minimum floor  : ${sol(s.floor_lamports)}   (below this, everyone refunds)`);
  console.log(`  minimum bid    : ${sol(s.min_bid_lamports)}`);
  console.log(`  authority      : ${s.authority.toBase58()}`);
  console.log(`  proceeds go to : ${s.seed_destination.toBase58()}`);
  console.log(`                   ^ pre-committed. The program can send them nowhere else.`);

  console.log("\nSTATE");
  console.log(`  status         : ${s.status}`);
  console.log(`  committed      : ${sol(C)}  from ${s.commitment_count} wallet(s)`);
  console.log(`  subscription   : ${cap === 0n ? "?" : `${((Number(C) / Number(cap)) * 100).toFixed(1)}%`}${over ? "  — OVERSUBSCRIBED, excess refunds pro-rata" : ""}`);
  console.log(`  claims settled : ${s.claim_count} of ${s.commitment_count}`);
  console.log(`  tokens out     : ${fmt(s.total_claimed_tokens, s.decimals)} of ${fmt(s.supply_for_sale, s.decimals)}`);
  console.log(`  swept          : ${sol(s.total_swept_lamports)}`);
  console.log(`  unsold burned  : ${s.unsold_burned}`);

  console.log("\nTIMELINE");
  console.log(`  opened         : ${ts(s.open_ts)}`);
  console.log(`  closes         : ${ts(s.close_ts)}   (extended ${s.extension_count} time(s))`);
  console.log(`  absolute limit : ${ts(s.absolute_deadline)}`);
  console.log(`  pool deadline  : ${ts(s.pool_deadline)}`);

  console.log("\nPOOL");
  if (s.pool_created) {
    console.log(`  proven         : ${s.pool.toBase58()}  ${explorer(s.pool)}`);
    console.log(`  opens trading  : ${ts(s.pool_open_time)}`);
    const now = BigInt(Math.floor(Date.now() / 1000));
    console.log(`  claims open    : ${now >= s.pool_open_time ? "YES" : "not yet — claims wait for the pool to trade"}`);
  } else {
    console.log(`  proven         : NO`);
    console.log(`  FLAGGED        : claims are blocked until a pool is proven on chain.`);
    console.log(`                   If none exists by the pool deadline above, anyone may`);
    console.log(`                   call fail_on_missing_pool and every claim becomes a`);
    console.log(`                   full refund. That path is permissionless by design.`);
  }

  // Recorded state is the truth; the balance is shown only so a mismatch is visible.
  // Anyone can donate lamports to any address, so this is never an invariant.
  const vaultLamports = BigInt((await conn.getBalance(solVault)) ?? 0);
  console.log("\nSOL VAULT");
  console.log(`  address        : ${solVault.toBase58()}`);
  console.log(`  balance        : ${sol(vaultLamports)}`);
  console.log(`  recorded       : ${sol(C)} committed, ${sol(s.total_swept_lamports)} swept`);
  const expectedFloor = C > s.total_swept_lamports ? C - s.total_swept_lamports : 0n;
  if (vaultLamports + LAMPORTS < expectedFloor)
    console.log(
      `  FLAGGED        : balance is below committed-minus-swept. Refunds could fail.`,
    );

  if (process.argv[3]) {
    const bidder = new PublicKey(process.argv[3]);
    const [commit] = commitPda(sale, bidder);
    console.log(`\nCOMMITMENT for ${bidder.toBase58()}`);
    console.log(`  address        : ${commit.toBase58()}`);
  }

  console.log("\nCANNOT VERIFY FROM THIS ACCOUNT — always printed");
  console.log("  - pool depth. A pool existing is not a pool being deep enough.");
  console.log("  - the opening price. Pre-committed and grader-checked, never enforced here.");
  console.log("  - that Raydium's CPMM program will not be upgraded. It is upgradeable.");
  console.log("  - that the sale program will not be upgraded. Check its upgrade authority.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
