/**
 * Burns the fee authority. IRREVERSIBLE.
 *
 * This is the whole differentiator. An anti-rug brand whose own token has a
 * live transferFeeConfigAuthority is claiming something it cannot back: that
 * key can raise the tax toward 100% and turn the token into a honeypot.
 * Revoking it makes "the tax is X% and always will be" a fact a stranger can
 * verify in ten seconds instead of a promise.
 *
 * Understand what you give up: the lock is irreversible in BOTH directions.
 * You can never lower the fee to 0% either — if a CEX or partner later demands
 * a zero-fee token, the answer is permanently no. Decide before you run this.
 *
 * Run AFTER the pool is seeded and 03 has passed. Revoking early is fine too;
 * it changes nothing about how the fee behaves.
 */
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createSetAuthorityInstruction, AuthorityType,
  getMint, getTransferFeeConfig,
} from "@solana/spl-token";
import {
  createUpdateAuthorityInstruction, createUpdateFieldInstruction,
} from "@solana/spl-token-metadata";
import { POST_LOCK_METADATA } from "./config.js";
import { connection, loadKeypair, readMint, send, explorer, mainnetGuard } from "./lib.js";

async function main() {
  mainnetGuard("permanently revoke the fee authority");

  const conn = connection();
  const payer = loadKeypair("DEPLOYER_KEYPAIR");
  const mint = new PublicKey(readMint().mint);

  const info = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const cfg = getTransferFeeConfig(info);
  const cur = cfg?.transferFeeConfigAuthority;

  if (!cfg) throw new Error("No transfer fee config on this mint.");
  if (!cur || cur.equals(PublicKey.default)) {
    console.log("\nFee authority is already revoked. Nothing to do.\n");
    return;
  }
  if (!cur.equals(payer.publicKey))
    throw new Error(`Fee authority is ${cur.toBase58()}, you loaded ${payer.publicKey.toBase58()}.`);

  console.log(`\nLocking the fee at ${cfg.newerTransferFee.transferFeeBasisPoints} bps FOREVER.`);
  console.log(`  mint: ${mint.toBase58()}`);

  const ixs = [
    createSetAuthorityInstruction(
      mint, payer.publicKey, AuthorityType.TransferFeeConfig, null, [], TOKEN_2022_PROGRAM_ID,
    ),
  ];

  // Record the revoke on-chain, in the same transaction that performs it, so
  // the metadata is never asserting something untrue. This has to come BEFORE
  // the update-authority revoke below or the write is rejected.
  for (const [field, value] of POST_LOCK_METADATA) {
    ixs.push(createUpdateFieldInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      updateAuthority: payer.publicKey,
      field,
      value,
    }));
  }

  // Opt-in: also freeze name/symbol/uri and the metadata pointer. Neither is a
  // funds-at-risk authority — they cannot take or freeze anyone's tokens — but
  // together they are a rebrand/repoint vector, and for a token whose pitch is
  // ten-second verifiability that is worth closing. Only do this once the URI
  // is final and permanently hosted; you cannot fix a dead link afterward.
  if (process.env.REVOKE_METADATA_AUTHORITY === "yes") {
    console.log(`  also revoking metadata update + pointer authority (identity frozen)`);
    ixs.push(createSetAuthorityInstruction(
      mint, payer.publicKey, AuthorityType.MetadataPointer, null, [], TOKEN_2022_PROGRAM_ID,
    ));
    // Must be last: it revokes the key the UpdateField instructions above need.
    ixs.push(createUpdateAuthorityInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      oldAuthority: payer.publicKey,
      newAuthority: null,
    }));
  }

  await send(conn, ixs, [payer], "authority revoked");

  console.log(`\n  Done. ${explorer(mint)}`);
  console.log(`  Run  npm run verify  — all three rug checks should now read PASS.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
