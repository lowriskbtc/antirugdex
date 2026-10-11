/**
 * Destroys the supply nobody bought.
 *
 *   npx tsx src/17-burn-unsold.ts                  # dry run
 *   $env:CONFIRM='yes'; npx tsx src/17-burn-unsold.ts
 *
 * PERMISSIONLESS — the amount is `supply_for_sale - total_claimed_tokens` and it goes
 * nowhere, so there is no discretion to gate. The vault's authority is the sale PDA and
 * only this program can move tokens out of it, so without this instruction an
 * undersubscribed sale's remainder would be locked forever.
 *
 * ## The guard that may never be satisfiable
 *
 * On a Succeeded sale this needs `claim_count == commitment_count` — everyone settled.
 * Until then the remainder cannot be told apart from tokens still owed, and burning early
 * would eat someone's allocation. **One bidder who lost their key blocks this forever**,
 * and CEX-deposit-address bidders are a known instance. The failure mode is cosmetic supply
 * rather than lost funds, which is why it is acceptable — but it is a real mainnet
 * consequence, not a devnet artifact.
 *
 * Burning is untaxed, proven by the program's `burning_is_untaxed` test rather than taken
 * from the Token-2022 spec — so the burn moves the full amount, unlike a claim.
 */

import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { getAccount, getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
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
  mainnetGuard("burn unsold supply");
  const conn = connection();

  const mint = new PublicKey(readMint().mint);
  const [sale] = salePda(mint);

  const s = await fetchSale(conn, sale);
  if (!s) throw new Error(`No sale at ${sale.toBase58()}`);

  const unsold = s.supply_for_sale - s.total_claimed_tokens;
  const vault = await getAccount(conn, s.token_vault, "confirmed", TOKEN_2022_PROGRAM_ID);
  const mintBefore = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);

  console.log(`\nBurn unsold — ${CLUSTER}`);
  console.log(`  sale           : ${sale.toBase58()}  (${s.status})`);
  console.log(`  claims settled : ${s.claim_count} of ${s.commitment_count}`);
  console.log(`  supply_for_sale: ${s.supply_for_sale}  (${fmt(s.supply_for_sale, s.decimals)})`);
  console.log(`  claimed        : ${s.total_claimed_tokens}  (${fmt(s.total_claimed_tokens, s.decimals)})`);
  console.log(`  TO BURN        : ${unsold} base units  (${fmt(unsold, s.decimals)})`);
  console.log(`\n  token vault    : ${s.token_vault.toBase58()}`);
  console.log(`  vault holds    : ${vault.amount} base units`);
  console.log(`  mint supply    : ${mintBefore.supply}`);

  if (s.unsold_burned) throw new Error("Already burned — AlreadyBurned.");
  if (s.status === "Bidding") throw new Error("Sale is still Bidding — SaleStillOpen.");
  if (s.status === "Succeeded" && s.claim_count !== s.commitment_count)
    throw new Error(
      `${s.commitment_count - s.claim_count} commitment(s) unsettled — ClaimsOutstanding.\n` +
        `  The remainder is indistinguishable from tokens still owed until everyone claims.`,
    );
  if (unsold === 0n) throw new Error("Nothing unsold — NothingToBurn.");
  if (vault.amount < unsold)
    console.log(
      `\n  FLAGGED        : the vault holds less than the amount to burn. The burn will\n` +
        `                   fail. Recorded state and the vault have diverged.`,
    );

  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — nothing sent. Re-run with CONFIRM=yes.\n`);
    return;
  }

  const payer = loadKeypair("DEPLOYER_KEYPAIR");
  const ix = buildIx("burn_unsold", {
    payer: payer.publicKey,
    sale,
    token_mint: mint,
    token_vault: s.token_vault,
    token_program: TOKEN_2022_PROGRAM_ID,
  });

  console.log(`\n-> burn_unsold (fee paid by ${payer.publicKey.toBase58()})`);
  await send(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ix],
    [payer],
    "burn_unsold",
  );

  const after = await fetchSale(conn, sale);
  const vaultAfter = await getAccount(conn, s.token_vault, "confirmed", TOKEN_2022_PROGRAM_ID);
  const mintAfter = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log(`\n  unsold_burned  : ${after!.unsold_burned}`);
  console.log(`  vault          : ${vault.amount} -> ${vaultAfter.amount}`);
  console.log(`  mint supply    : ${mintBefore.supply} -> ${mintAfter.supply}   (burned ${mintBefore.supply - mintAfter.supply})`);
  console.log(`  ${explorer(mint)}`);
  if (mintBefore.supply - mintAfter.supply !== unsold)
    console.log(
      `  FLAGGED        : predicted a ${unsold} burn, supply fell by ` +
        `${mintBefore.supply - mintAfter.supply}. Burning is supposed to be untaxed.`,
    );
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
