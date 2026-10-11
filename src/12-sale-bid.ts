/**
 * Places a bid.
 *
 *   npx tsx src/12-sale-bid.ts 0.6                 # dry run
 *   $env:CONFIRM='yes'; npx tsx src/12-sale-bid.ts 0.6
 *   ... BID_WALLET=fresh                            # generate + airdrop a throwaway wallet
 *
 * Bidding is IRREVOCABLE — there is no withdraw instruction, by design. The only ways SOL
 * comes back are a pro-rata refund above the cap, or a full refund if the sale fails.
 *
 * Ordering is worth exactly zero here and so is wallet-splitting: allocation is
 * `floor(c_i * S / C)`, which depends on neither. That is the entire mechanism. A late bid
 * does one thing only — if it lands within 5 minutes of the close it pushes the close out,
 * capped by both `MAX_EXTENSIONS` and the absolute deadline.
 */

import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
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
  encodeU64,
  fetchCommitment,
  fetchSale,
  jitoMarker,
  salePda,
  solVaultPda,
} from "./sale-client.js";

const WALLET_DIR = path.join(process.cwd(), `bidders.${CLUSTER}`);

async function bidderWallet(conn: ReturnType<typeof connection>, need: bigint): Promise<Keypair> {
  if (process.env.BID_WALLET !== "fresh") return loadKeypair("DEPLOYER_KEYPAIR");

  // Throwaway wallets, kept on disk so the same bidder can claim later. Devnet only —
  // these are unencrypted keys and exist purely to rehearse a multi-wallet book.
  if (CLUSTER !== "devnet") throw new Error("BID_WALLET=fresh is devnet-only");
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  const kp = Keypair.generate();
  const file = path.join(WALLET_DIR, `${kp.publicKey.toBase58()}.json`);
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`  fresh bidder: ${kp.publicKey.toBase58()}\n  saved to ${file}`);

  // Funded by transfer from the deployer, NOT by airdrop. The devnet faucet returns a bare
  // "Internal error" under rate limiting — it did on the first attempt here — and a
  // rehearsal that depends on a faucet is a rehearsal that fails at random.
  const want = need + BigInt(Math.ceil(0.05 * LAMPORTS_PER_SOL));
  const funder = loadKeypair("DEPLOYER_KEYPAIR");
  await send(
    conn,
    [
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: kp.publicKey,
        lamports: Number(want),
      }),
    ],
    [funder],
    "fund bidder",
  );
  return kp;
}

async function main() {
  await assertClusterMatchesRpc();
  mainnetGuard("place a bid");
  const conn = connection();

  const solArg = process.argv[2];
  if (!solArg) throw new Error("Usage: npx tsx src/12-sale-bid.ts <SOL amount>");
  const [whole, frac = ""] = solArg.split(".");
  const amount = BigInt(whole) * 1_000_000_000n + BigInt((frac + "000000000").slice(0, 9));

  const mint = new PublicKey(readMint().mint);
  const [sale] = salePda(mint);
  const [solVault] = solVaultPda(sale);

  const s = await fetchSale(conn, sale);
  if (!s) throw new Error(`No sale at ${sale.toBase58()} — run 11-sale-init.ts first.`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const left = Number(s.close_ts - now);
  console.log(`\nBid — ${CLUSTER}`);
  console.log(`  sale      : ${sale.toBase58()}  (${s.status})`);
  console.log(`  amount    : ${fmt(amount, 9)} SOL   (min ${fmt(s.min_bid_lamports, 9)})`);
  console.log(`  committed : ${fmt(s.total_committed, 9)} of ${fmt(s.hard_cap_lamports, 9)} SOL cap`);
  console.log(`  floor     : ${fmt(s.floor_lamports, 9)} SOL`);
  console.log(`  closes in : ${left}s${left <= 300 ? "  — inside the extension window, this bid will push the close out" : ""}`);

  if (s.status !== "Bidding") throw new Error(`Sale is ${s.status}, not accepting bids.`);
  if (left <= 0) throw new Error("Bidding has closed.");
  if (amount < s.min_bid_lamports)
    throw new Error(`Below the ${fmt(s.min_bid_lamports, 9)} SOL minimum.`);

  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — nothing sent. Re-run with CONFIRM=yes.\n`);
    return;
  }

  const bidder = await bidderWallet(conn, amount);
  const [commitment] = commitPda(sale, bidder.publicKey);

  const ix = buildIx(
    "bid",
    {
      bidder: bidder.publicKey,
      sale,
      commitment,
      sol_vault: solVault,
      jito_dont_front: jitoMarker(),
    },
    encodeU64(amount),
  );

  console.log(`\n-> bid from ${bidder.publicKey.toBase58()}`);
  await send(
    conn,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ix],
    [bidder],
    "bid",
  );

  const after = await fetchSale(conn, sale);
  const c = await fetchCommitment(conn, commitment);
  console.log(`\n  your commitment : ${fmt(c!.amount, 9)} SOL   ${explorer(commitment)}`);
  console.log(`  sale committed  : ${fmt(after!.total_committed, 9)} SOL from ${after!.commitment_count} wallet(s)`);
  console.log(`  closes at       : ${new Date(Number(after!.close_ts) * 1000).toISOString()}`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
