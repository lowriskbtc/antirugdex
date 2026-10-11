/**
 * Devnet funding helper. The public faucet is aggressively IP-rate-limited;
 * if this fails, use https://faucet.solana.com (web, GitHub login) and paste
 * the pubkey it prints.
 */
import { Connection } from "@solana/web3.js";
import { connection, loadKeypair, IS_MAINNET } from "./lib.js";

if (IS_MAINNET) {
  console.error("Mainnet has no faucet. Fund the deployer yourself.");
  process.exit(1);
}

const kp = loadKeypair("DEPLOYER_KEYPAIR");
const conn: Connection = connection();
console.log("pubkey:", kp.publicKey.toBase58());

for (const amt of [2, 1, 0.5]) {
  try {
    const s = await conn.requestAirdrop(kp.publicKey, amt * 1e9);
    await conn.confirmTransaction(s, "confirmed");
    console.log(`airdrop ok: ${amt} SOL`);
    break;
  } catch (e) {
    console.log(`  ${amt} SOL failed: ${(e as Error).message.slice(0, 100)}`);
  }
}

console.log("balance:", (await conn.getBalance(kp.publicKey)) / 1e9, "SOL");
