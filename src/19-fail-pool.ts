/**
 * The abandonment recovery path: flips a sale to `Failed` when the pool never appeared,
 * turning every claim into a full refund.
 *
 *   npx tsx src/19-fail-pool.ts            # dry run
 *   $env:CONFIRM='yes'; npx tsx src/19-fail-pool.ts
 *
 * ## This instruction takes no signer at all
 *
 * Its entire account list is `[sale]`, writable, and nothing else — no authority, no payer
 * in the instruction, no token accounts. Whoever submits the transaction pays the fee and
 * gains nothing. That is deliberate and worth defending against a future "improvement":
 *
 * The sale this unblocks is one where **the builder has already disappeared**. Gating it on
 * the authority's signature would mean the recovery path depends on the one party whose
 * absence is the emergency. Bidders would be unable to recover their own principal.
 *
 * So: do not add an authority check, and do not add a "only the bidder may call for their
 * own refund" check. Anyone may call it, the outcome is a pure function of recorded state
 * and the clock, and there is nothing to gate.
 *
 * ## The three guards, read off the program (`finalize.rs:70`)
 *
 *   require!(!sale.pool_created,              PoolAlreadyCreated);
 *   require!(now >= sale.pool_deadline,       PoolDeadlineNotReached);
 *   require!(status == Bidding || Succeeded,  SaleAlreadyFinalized);
 *
 * Note it accepts **Bidding as well as Succeeded**. If the builder vanished before ever
 * calling `finalize`, requiring `Succeeded` would mean recovery needed someone to call
 * `finalize` first — "you must make two calls in the right order" is the opposite of
 * self-executing. This script therefore does not require a finalized sale either.
 *
 * ## Why it can never double-pay
 *
 * This requires `!pool_created` and `claim` requires `pool_created`. The two are disjoint,
 * so no token can have been claimed before this runs. That invariant is documented on
 * `Sale::pool_created` and is the reason this is safe to leave permissionless.
 *
 * After this succeeds, every bidder recovers principal in full via `18-sale-refund.ts`,
 * which anyone may also push on anyone's behalf.
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
import { buildIx, fetchSale, salePda, solVaultPda } from "./sale-client.js";

const ts = (v: number | bigint) => new Date(Number(v) * 1000).toISOString();

async function main() {
  await assertClusterMatchesRpc();
  mainnetGuard("declare a sale failed for a missing pool");
  const conn = connection();

  const mint = new PublicKey(readMint().mint);
  const [sale] = salePda(mint);
  const [solVault] = solVaultPda(sale);

  const s = await fetchSale(conn, sale);
  if (!s) throw new Error(`No sale at ${sale.toBase58()} for mint ${mint.toBase58()}`);

  const now = Math.floor(Date.now() / 1000);
  const deadline = Number(s.pool_deadline);
  const vault = await conn.getBalance(solVault);

  console.log(`\nfail_on_missing_pool — ${CLUSTER}`);
  console.log(`  sale         : ${sale.toBase58()}`);
  console.log(`  status       : ${s.status}`);
  console.log(`  pool_created : ${s.pool_created}`);
  console.log(`  pool deadline: ${ts(deadline)}`);
  console.log(`  now          : ${ts(now)}   ${now >= deadline ? `(lapsed ${now - deadline}s ago)` : `(${deadline - now}s remaining)`}`);
  console.log(`  total committed: ${fmt(s.total_committed, 9)} SOL from ${s.commitment_count} bidder(s)`);
  console.log(`  sol vault      : ${vault} lamports`);

  // Each guard is checked here with the program's own error name, so a refusal is readable
  // rather than an anchor code the caller has to look up.
  if (s.pool_created)
    throw new Error(
      `pool_created is true — PoolAlreadyCreated.\n` +
        `  A proven pool permanently disables this path, which is the point: claims are real.`,
    );
  if (s.status !== "Bidding" && s.status !== "Succeeded")
    throw new Error(
      `Sale is ${s.status} — SaleAlreadyFinalized. This accepts only Bidding or Succeeded.` +
        (s.status === "Failed" ? `\n  Already Failed: refunds are open. Run 18-sale-refund.ts.` : ""),
    );
  if (now < deadline)
    throw new Error(
      `Pool deadline has not passed — PoolDeadlineNotReached.\n` +
        `  ${deadline - now}s remaining, until ${ts(deadline)}.\n` +
        `  Until then the builder may still prove a pool with 14-mark-pool.ts.`,
    );

  console.log(`\n  All three guards pass. This flips the sale to Failed, PERMANENTLY:`);
  console.log(`    - every commitment becomes refundable in full via 18-sale-refund.ts`);
  console.log(`    - claim is dead on this sale; no token will ever be delivered`);
  console.log(`    - sweep_proceeds is dead; the ${vault} lamports go back to bidders`);
  console.log(`  It cannot be undone, and 14-mark-pool.ts will no longer work afterwards.`);

  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — nothing sent. Re-run with CONFIRM=yes.\n`);
    return;
  }

  // A fee payer is needed to submit a transaction, but the instruction itself has no signer
  // account — this keypair is not an authority here and any funded key would do.
  const payer = loadKeypair("DEPLOYER_KEYPAIR");
  const ix = buildIx("fail_on_missing_pool", { sale });

  console.log(`\n-> fail_on_missing_pool (fee paid by ${payer.publicKey.toBase58()}, who has no special standing)`);
  await send(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }), ix],
    [payer],
    "fail_on_missing_pool",
  );

  const after = await fetchSale(conn, sale);
  console.log(`\n  status       : ${s.status} -> ${after!.status}`);
  console.log(`  sol vault    : ${await conn.getBalance(solVault)} lamports  (unchanged — this moves no money)`);
  console.log(`  ${explorer(sale)}`);

  if (after!.status !== "Failed")
    console.log(
      `\n  FLAGGED — expected Failed, got ${after!.status}. The instruction reported success,\n` +
        `            so this is a real finding, not a retry.`,
    );
  else console.log(`\n  Refunds are open. Next: npx tsx src/18-sale-refund.ts <bidder-pubkey>\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
