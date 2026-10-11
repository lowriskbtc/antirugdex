/**
 * Moves the raise to the pre-committed `seed_destination`.
 *
 *   npx tsx src/15-sweep-proceeds.ts               # dry run
 *   $env:CONFIRM='yes'; npx tsx src/15-sweep-proceeds.ts
 *
 * PERMISSIONLESS, and the destination is not a parameter — it is `sale.seed_destination`,
 * recorded before the first bid. This script prints it next to the authority so "the
 * builder cannot redirect your SOL" is visible rather than asserted.
 *
 * ## It is meant to be called more than once
 *
 * The sweepable ceiling is `max(cap - commitment_count, total_accepted_lamports)` when
 * oversubscribed. Before any claim, `total_accepted_lamports` is 0 and the conservative
 * bound governs: the sale sweeps `cap - commitment_count`, deliberately leaving under one
 * lamport per commitment behind because the exact accepted total cannot be known without
 * iterating every commitment. As claims settle, `total_accepted_lamports` overtakes the
 * bound and a second call collects the remainder.
 *
 * On this rehearsal that remainder is exactly 1 lamport, which makes the conservative bound
 * directly observable: if a single sweep takes everything, the bound is not being applied.
 *
 * ## Why the pool has to exist first
 *
 * `sweep_proceeds` requires `pool_created`. Without that gate the sweep empties the vault,
 * the pool never appears, `fail_on_missing_pool` still fires, and every refund then fails
 * on `VaultBelowRentReserve` — total unrecoverable loss of bidder principal by way of the
 * path that exists to make abandonment survivable. Consequence: the pool seed cannot come
 * from the raise. The builder fronts it and sweeps to reimburse.
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
import { buildIx, fetchSale, salePda, solVaultPda, SYSTEM_PROGRAM } from "./sale-client.js";

/** Mirrors `sweepable_ceiling` in proceeds.rs. */
function ceiling(s: {
  total_committed: bigint;
  hard_cap_lamports: bigint;
  commitment_count: bigint;
  total_accepted_lamports: bigint;
}): bigint {
  if (s.total_committed <= s.hard_cap_lamports) return s.total_committed;
  const conservative =
    s.hard_cap_lamports > s.commitment_count ? s.hard_cap_lamports - s.commitment_count : 0n;
  return conservative > s.total_accepted_lamports ? conservative : s.total_accepted_lamports;
}

async function main() {
  await assertClusterMatchesRpc();
  mainnetGuard("sweep sale proceeds");
  const conn = connection();

  const mint = new PublicKey(readMint().mint);
  const [sale] = salePda(mint);
  const [solVault] = solVaultPda(sale);

  const s = await fetchSale(conn, sale);
  if (!s) throw new Error(`No sale at ${sale.toBase58()}`);

  const ceil = ceiling(s);
  const amount = ceil > s.total_swept_lamports ? ceil - s.total_swept_lamports : 0n;
  const bound =
    s.total_committed <= s.hard_cap_lamports
      ? "undersubscribed — the exact committed total"
      : ceil === s.total_accepted_lamports && s.total_accepted_lamports > 0n
        ? "exact — total_accepted_lamports, now that claims have settled"
        : "conservative — cap minus commitment_count, because claims have not settled";

  const vault = BigInt(await conn.getBalance(solVault));

  console.log(`\nSweep proceeds — ${CLUSTER}`);
  console.log(`  sale           : ${sale.toBase58()}  (${s.status})`);
  console.log(`  destination    : ${s.seed_destination.toBase58()}`);
  console.log(`                   ^ recorded at initialize; the program can send nowhere else`);
  console.log(`  pool proven    : ${s.pool_created}`);
  console.log(`\n  committed      : ${fmt(s.total_committed, 9)} SOL`);
  console.log(`  hard cap       : ${fmt(s.hard_cap_lamports, 9)} SOL`);
  console.log(`  commitments    : ${s.commitment_count}   claims settled ${s.claim_count}`);
  console.log(`  accepted so far: ${s.total_accepted_lamports} lamports`);
  console.log(`  ceiling        : ${ceil} lamports  (${bound})`);
  console.log(`  already swept  : ${s.total_swept_lamports} lamports`);
  console.log(`  THIS SWEEP     : ${amount} lamports  (${fmt(amount, 9)} SOL)`);
  console.log(`\n  vault balance  : ${vault} lamports`);
  console.log(`  after this     : ${vault - amount} lamports`);

  if (s.status !== "Succeeded") throw new Error(`Sale is ${s.status} — sweep needs Succeeded.`);
  if (!s.pool_created)
    throw new Error("pool_created is false — sweep would fail with SweepBeforePool.");
  if (amount === 0n)
    throw new Error(
      "Nothing to sweep — NothingToSweep. The ceiling has not moved since the last sweep.\n" +
        "  If claims are still outstanding, come back after they settle.",
    );

  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — nothing sent. Re-run with CONFIRM=yes.\n`);
    return;
  }

  const payer = loadKeypair("DEPLOYER_KEYPAIR");
  const before = BigInt(await conn.getBalance(s.seed_destination));

  const ix = buildIx("sweep_proceeds", {
    payer: payer.publicKey,
    sale,
    seed_destination: s.seed_destination,
    sol_vault: solVault,
    system_program: SYSTEM_PROGRAM,
  });

  console.log(`\n-> sweep_proceeds (fee paid by ${payer.publicKey.toBase58()})`);
  await send(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }), ix],
    [payer],
    "sweep_proceeds",
  );

  const after = await fetchSale(conn, sale);
  const moved = after!.total_swept_lamports - s.total_swept_lamports;
  const destAfter = BigInt(await conn.getBalance(s.seed_destination));
  console.log(`\n  recorded swept : ${after!.total_swept_lamports} lamports (this call moved ${moved})`);
  console.log(`  vault now      : ${await conn.getBalance(solVault)} lamports`);
  console.log(`  destination    : ${before} -> ${destAfter}   ${explorer(s.seed_destination)}`);
  if (moved !== amount)
    console.log(
      `  FLAGGED        : predicted ${amount}, chain moved ${moved}. That is a real\n` +
        `                   disagreement about the sweepable ceiling.`,
    );
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
