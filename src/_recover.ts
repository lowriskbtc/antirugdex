/**
 * Recovers token accounts for this mint from transaction signatures, for use
 * when getProgramAccounts is unavailable on your RPC.
 *
 *   npx tsx src/_recover.ts <sig> <sig> ...
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackAccount, getTransferFeeAmount } from "@solana/spl-token";
import { connection, readMint } from "./lib.js";

const conn = connection();
const mint = new PublicKey(readMint().mint);
const sigs = process.argv.slice(2);
if (!sigs.length) { console.error("usage: _recover.ts <sig> ..."); process.exit(1); }

const found = new Set<string>();

for (const sig of sigs) {
  const tx = await conn.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) { console.error(`  ${sig.slice(0, 12)}...: not found`); continue; }
  for (const key of tx.transaction.message.getAccountKeys().staticAccountKeys) {
    const info = await conn.getAccountInfo(key, "confirmed");
    if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) continue;
    try {
      const acct = unpackAccount(key, info, TOKEN_2022_PROGRAM_ID);
      if (!acct.mint.equals(mint)) continue;
      const held = getTransferFeeAmount(acct)?.withheldAmount ?? 0n;
      if (held > 0n) found.add(key.toBase58());
    } catch { /* not a token account (the mint itself lands here) */ }
  }
}

console.log([...found].join(" "));
