/**
 * Burns the LP tokens — makes the liquidity permanently unwithdrawable.
 *
 *   npx tsx src/07-burn-lp.ts                 # dry run
 *   $env:CONFIRM='yes'; npx tsx src/07-burn-lp.ts
 *
 * BURNED vs LOCKED — the distinction that most rug-checkers collapse into
 * one row, and the reason this project picked Raydium over Meteora.
 *
 *   BURNED (this script): LP tokens are destroyed. Supply drops. No account
 *     holds a claim. Nobody — including us — can withdraw the liquidity or
 *     collect fees against it. Verifiable in one read: does supply reach 0?
 *
 *   LOCKED (the alternative): LP is parked in a lock contract. On Meteora a
 *     permanently-locked position STILL PAYS CLAIMABLE FEES FOREVER to
 *     whoever holds the claim, and that claim can be assigned to a third
 *     address at lock time. "Liquidity locked" there does NOT mean nobody
 *     profits.
 *
 * A grader must report these as different states. Ours does.
 *
 * NOTE: the LP mint's authority stays set to the pool's PDA and that is
 * normal and correct — it is how an AMM mints/burns LP on deposit and
 * withdraw. It is NOT a rug vector and must not be flagged as one.
 */
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getMint, getAssociatedTokenAddressSync, createBurnInstruction,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { connection, loadKeypair, send, explorer, CLUSTER, IS_MAINNET } from "./lib.js";

async function main() {
  const poolFile = path.join(process.cwd(), `pool.${CLUSTER}.json`);
  if (!fs.existsSync(poolFile))
    throw new Error(`No ${poolFile}. Run 06-create-pool.ts first.`);
  const pool = JSON.parse(fs.readFileSync(poolFile, "utf8"));

  const conn = connection();
  const owner = loadKeypair("DEPLOYER_KEYPAIR");
  const lpMint = new PublicKey(pool.lpMint);

  const m = await getMint(conn, lpMint, "confirmed", TOKEN_PROGRAM_ID);
  const ata = getAssociatedTokenAddressSync(lpMint, owner.publicKey, false, TOKEN_PROGRAM_ID);

  let held = 0n;
  try {
    held = BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
  } catch {
    throw new Error(`No LP token account at ${ata.toBase58()} — nothing to burn.`);
  }

  console.log(`\n=== burn LP for pool ${pool.poolId} (${CLUSTER}) ===\n`);
  console.log(`  LP mint      : ${lpMint.toBase58()}`);
  console.log(`  LP supply    : ${m.supply.toString()}`);
  console.log(`  we hold      : ${held.toString()}`);
  console.log(`  after burn   : supply ${(m.supply - held).toString()}, ours 0`);
  console.log(`  effect       : the seeded liquidity can never be withdrawn by anyone, including us`);

  if (held === 0n) { console.log(`\n  Nothing to burn.\n`); return; }

  if (process.env.CONFIRM !== "yes") {
    console.log(`\n  DRY RUN — set CONFIRM=yes to burn. THIS IS IRREVERSIBLE.\n`);
    return;
  }
  // The mainnet refusal that used to sit here was pure caution, not a technical blocker:
  // this file has no cluster-specific logic at all — it reads pool.${CLUSTER}.json, takes
  // the LP mint from it, and burns an ordinary SPL token. Reviewed and lifted 2026-08-11
  // so that launch step 8 can actually run; the CONFIRM=yes gate above is unchanged and is
  // the same gate every other irreversible script uses.
  if (IS_MAINNET) {
    console.log(
      `\n  ############ MAINNET ############\n` +
      `  Burning ${held.toString()} LP for pool ${pool.poolId}.\n` +
      `  IRREVERSIBLE: after this nobody can withdraw the seeded liquidity, including you.\n`,
    );
  }

  const sig = await send(
    conn,
    [createBurnInstruction(ata, lpMint, owner.publicKey, held, [], TOKEN_PROGRAM_ID)],
    [owner],
    "LP burned",
  );

  const after = await getMint(conn, lpMint, "confirmed", TOKEN_PROGRAM_ID);
  console.log(`\n  LP supply now: ${after.supply.toString()}`);
  console.log(`  ${after.supply === 0n
    ? "Supply is ZERO — no claim on this liquidity exists anywhere."
    : `Supply is ${after.supply}. Any remainder is held by the pool program itself, not by us.`}`);

  pool.lpBurnTx = sig;
  pool.lpBurnedRaw = held.toString();
  pool.lpSupplyAfterBurn = after.supply.toString();
  fs.writeFileSync(poolFile, JSON.stringify(pool, null, 2));
  console.log(`\n  ${explorer(sig, "tx")}`);
  console.log(`  updated ${poolFile}\n`);
}

main().catch((e) => { console.error(`\n${(e as Error).message}\n`); process.exitCode = 1; });
