/**
 * Measures the sale-side rent a launch actually pays, so preflight's budget line traces to
 * a number read off chain instead of a guess.
 *
 *   npx tsx src/_launch-rent.ts                 # resolves the sale from mint.<cluster>.json
 *   npx tsx src/_launch-rent.ts <saleAddress>
 *
 * Read-only. Rent is a global runtime parameter — `lamports_per_byte_year` does not differ
 * between devnet and mainnet — so a devnet sale measures the mainnet cost exactly. What
 * would NOT transfer is anything sized from a cluster-specific value, and none of these
 * accounts are: their lengths come from the program's own layout.
 *
 * `Commitment` PDAs are deliberately excluded. `bid` makes the BIDDER the payer, so they
 * are not the builder's cost — and they scale with turnout, which is exactly the kind of
 * unbounded line that does not belong in a fixed pre-launch budget.
 */
import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { connection, readMint, CLUSTER } from "./lib.js";
import { salePda, solVaultPda, fetchSale } from "./sale-client.js";

async function main() {
  const conn = connection();

  // `--mint <addr>` exists so the figure can be re-measured against any of the settled
  // rehearsal sales, not just whichever one mint.<cluster>.json currently points at.
  const argv = process.argv.slice(2);
  const mintFlag = argv.indexOf("--mint");
  const sale =
    mintFlag >= 0
      ? salePda(new PublicKey(argv[mintFlag + 1]))[0]
      : argv[0] && !argv[0].startsWith("--")
        ? new PublicKey(argv[0])
        : salePda(new PublicKey(readMint().mint))[0];

  const info = await fetchSale(conn, sale);
  if (!info)
    throw new Error(
      `No Sale account at ${sale.toBase58()} on ${CLUSTER}.\n` +
        `  Pass a sale address explicitly, or point mint.${CLUSTER}.json at a mint that has one.`,
    );

  const [solVault] = solVaultPda(sale);
  const targets: { label: string; address: PublicKey }[] = [
    { label: "Sale PDA", address: sale },
    { label: "sol_vault PDA", address: solVault },
    { label: "token vault", address: info.token_vault },
  ];

  console.log(`\n=== sale-side rent, measured on ${CLUSTER} ===`);
  console.log(`  sale ${sale.toBase58()}\n`);

  let total = 0;
  for (const t of targets) {
    const acct = await conn.getAccountInfo(t.address);
    if (!acct) {
      console.log(`  ${t.label.padEnd(14)} MISSING at ${t.address.toBase58()} — not counted`);
      continue;
    }
    // The rent-exempt MINIMUM for the account's size, not its balance: sol_vault also holds
    // bidder principal and sweep residue, and the token vault's balance is tokens, not rent.
    const rent = await conn.getMinimumBalanceForRentExemption(acct.data.length);
    total += rent;
    console.log(
      `  ${t.label.padEnd(14)} ${String(acct.data.length).padStart(4)} bytes   ` +
        `${(rent / 1e9).toFixed(6)} SOL   ${t.address.toBase58()}`,
    );
  }

  console.log(`\n  TOTAL          ${(total / 1e9).toFixed(6)} SOL  (${total} lamports)`);
  console.log(
    `\n  This is the "sale account rents" line in 00-preflight.ts's launch budget.\n` +
      `  Commitment PDAs are excluded — the bidder pays those, and they scale with turnout.`,
  );

  // ---- pool side ---------------------------------------------------------
  //
  // Measured off a real pool for the same reason: "pool account rents" was the other
  // guessed line. `configId` is deliberately NOT counted — the AmmConfig is Raydium's,
  // shared by every pool on that tier, and we do not pay to create it. What we do pay for
  // is Raydium's flat create fee, which is a separate budget line and not rent.
  const poolFile = path.join(process.cwd(), `pool.${CLUSTER}.json`);
  if (!fs.existsSync(poolFile)) {
    console.log(`\n  (no ${poolFile} — pool-side rent not measured)\n`);
    return;
  }
  const pool = JSON.parse(fs.readFileSync(poolFile, "utf8"));
  const poolAccounts = ["poolId", "lpMint", "vaultA", "vaultB", "observationId"] as const;

  console.log(`\n=== pool-side rent, measured on ${CLUSTER} ===`);
  console.log(`  pool ${pool.poolId}\n`);

  let poolTotal = 0;
  for (const key of poolAccounts) {
    const addr = pool[key];
    if (!addr) {
      console.log(`  ${key.padEnd(14)} NOT RECORDED in ${path.basename(poolFile)} — not counted`);
      continue;
    }
    const acct = await conn.getAccountInfo(new PublicKey(addr));
    if (!acct) {
      console.log(`  ${key.padEnd(14)} MISSING on chain at ${addr} — not counted`);
      continue;
    }
    const rent = await conn.getMinimumBalanceForRentExemption(acct.data.length);
    poolTotal += rent;
    console.log(
      `  ${key.padEnd(14)} ${String(acct.data.length).padStart(5)} bytes   ` +
        `${(rent / 1e9).toFixed(6)} SOL   ${addr}`,
    );
  }

  console.log(`\n  TOTAL          ${(poolTotal / 1e9).toFixed(6)} SOL  (${poolTotal} lamports)`);
  console.log(
    `\n  This is the "pool account rents" line. Raydium's flat create fee is separate and\n` +
      `  is not rent; the shared AmmConfig is Raydium's account, not ours, so it is excluded.\n`,
  );
}

main().catch((e) => {
  console.error(`\n${(e as Error).message}\n`);
  process.exitCode = 1;
});
