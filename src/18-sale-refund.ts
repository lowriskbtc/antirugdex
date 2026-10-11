/**
 * Returns a bidder's principal in full on a FAILED sale.
 *
 *   npx tsx src/18-sale-refund.ts <bidder-pubkey>            # dry run
 *   $env:CONFIRM='yes'; npx tsx src/18-sale-refund.ts <bidder-pubkey>
 *
 * ✅ **Exercised against a validator 2026-08-09** on a second devnet mint (`4wY2cFxa…`)
 * deliberately taken below its floor — the first rehearsal Succeeded, so this path had not
 * fired. It returned the bidder's principal to the lamport with the deployer paying the fee.
 * There is one Sale PDA per mint, forever, which is why proving it needed a separate mint.
 *
 * Reached by two routes, and only the first had been driven until 2026-08-10: `finalize`
 * below the floor, or `19-fail-pool.ts` after the pool deadline lapses with no pool proven.
 *
 * ## Anyone may push anyone's refund, and that is the point
 *
 * `payer` signs and pays the fee; `bidder` does not sign and receives every lamport. A
 * bidder who committed everything they had cannot afford the transaction that returns it,
 * and requiring their signature would make recovery depend on them still holding a live key
 * *and* a fee balance. Nobody can profit from pushing someone else's refund — the amount is
 * a recorded number and the destination is fixed by the PDA seeds.
 *
 * So the argument here is a pubkey, not a keypair. That is deliberate: recovering for a
 * bidder whose key is gone is precisely the case this instruction exists for.
 *
 * ## Deliberately the plainest instruction in the program
 *
 * No mint, no token account, no token program, no CPI but a system transfer, and no
 * arithmetic beyond copying a recorded number — it does not even write the `Sale` account.
 * That is the design invariant: if the allocation math were completely broken, every bidder
 * could still recover principal, because the recovery path does not contain that math.
 * Keep it that way — do not "improve" this script into something that reads allocations.
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
import {
  buildIx,
  commitPda,
  fetchCommitment,
  fetchSale,
  salePda,
  solVaultPda,
  SYSTEM_PROGRAM,
} from "./sale-client.js";

async function main() {
  await assertClusterMatchesRpc();
  mainnetGuard("push a refund");
  const conn = connection();

  const arg = process.argv[2];
  if (!arg)
    throw new Error(
      "Usage: npx tsx src/18-sale-refund.ts <bidder-pubkey>\n" +
        "  A pubkey, not a keypair — the bidder never signs a refund.",
    );
  const bidder = new PublicKey(arg);

  const mint = new PublicKey(readMint().mint);
  const [sale] = salePda(mint);
  const [solVault] = solVaultPda(sale);

  const s = await fetchSale(conn, sale);
  if (!s) throw new Error(`No sale at ${sale.toBase58()}`);

  const [commitment] = commitPda(sale, bidder);
  const c = await fetchCommitment(conn, commitment);
  if (!c)
    throw new Error(
      `No commitment for ${bidder.toBase58()} in this sale (expected at ${commitment.toBase58()}).`,
    );

  const vault = BigInt(await conn.getBalance(solVault));
  const bidderBefore = BigInt(await conn.getBalance(bidder));

  console.log(`\nRefund — ${CLUSTER}`);
  console.log(`  sale       : ${sale.toBase58()}  (${s.status})`);
  console.log(`  bidder     : ${bidder.toBase58()}   (receives the lamports; does not sign)`);
  console.log(`  commitment : ${commitment.toBase58()}${c.claimed ? "   ALREADY SETTLED" : ""}`);
  console.log(`  REFUND     : ${c.amount} lamports  (${fmt(c.amount, 9)} SOL) — principal in full`);
  console.log(`\n  sol vault  : ${vault} lamports`);
  console.log(`  bidder now : ${fmt(bidderBefore, 9)} SOL`);

  if (c.claimed) throw new Error("This commitment is already settled — AlreadyClaimed.");
  if (s.status !== "Failed")
    throw new Error(
      `Sale is ${s.status} — refund requires Failed, and would fail with SaleNotFailed.\n` +
        `  A sale reaches Failed by exactly two routes: finalize below the floor, or\n` +
        `  fail_on_missing_pool after the pool deadline with no pool proven.`,
    );
  if (c.amount === 0n) throw new Error("Commitment is zero — NothingToClaim.");

  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — nothing sent. Re-run with CONFIRM=yes.\n`);
    return;
  }

  const payer = loadKeypair("DEPLOYER_KEYPAIR");
  const ix = buildIx("refund", {
    payer: payer.publicKey,
    bidder,
    sale,
    commitment,
    sol_vault: solVault,
    system_program: SYSTEM_PROGRAM,
  });

  console.log(`\n-> refund (fee paid by ${payer.publicKey.toBase58()}, who receives nothing)`);
  await send(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }), ix],
    [payer],
    "refund",
  );

  const after = await fetchCommitment(conn, commitment);
  const bidderAfter = BigInt(await conn.getBalance(bidder));
  console.log(`\n  lamports_refunded : ${after!.lamports_refunded}`);
  console.log(`  bidder            : ${fmt(bidderBefore, 9)} -> ${fmt(bidderAfter, 9)} SOL   ${explorer(bidder)}`);
  console.log(`  sol vault         : ${await conn.getBalance(solVault)} lamports`);
  if (bidderAfter - bidderBefore !== c.amount)
    console.log(
      `  FLAGGED           : expected the bidder to gain exactly ${c.amount} lamports,\n` +
        `                      they gained ${bidderAfter - bidderBefore}. A refund is a copy\n` +
        `                      of a recorded number — any difference is a real finding.`,
    );
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
