/**
 * Reads the mint back from chain and prints the exact report a buyer would
 * run before touching your token. Green across the board is the whole pitch.
 *
 * Every check here reports the real state. A check that can only print PASS
 * is not a check — the additionalMetadata assertion exists because writing
 * zero extra fields and writing all of them look identical in a bare loop.
 */
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getMint, getTransferFeeConfig,
  getMetadataPointerState, getTokenMetadata,
} from "@solana/spl-token";
import { ADDITIONAL_METADATA } from "./config.js";
import { connection, readMint, explorer, fmt } from "./lib.js";

const ok = (b: boolean) => (b ? "PASS" : "FAIL");
const isNull = (k?: PublicKey | null) => !k || k.equals(PublicKey.default);

async function main() {
  const conn = connection();
  const mint = new PublicKey(readMint().mint);

  const info = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(info);
  const ptr = getMetadataPointerState(info);
  const md = await getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);

  console.log(`\n=== ${mint.toBase58()} ===`);
  console.log(explorer(mint));

  console.log(`\n-- metadata --`);
  console.log(`  name     : ${md?.name ?? "(none)"}`);
  console.log(`  symbol   : ${md?.symbol ?? "(none)"}`);
  console.log(`  uri      : ${md?.uri ?? "(none)"}`);
  console.log(`  pointer  : ${ptr?.metadataAddress?.toBase58() ?? "(none)"}`);
  const extras = md?.additionalMetadata ?? [];
  for (const [k, v] of extras) console.log(`  + ${k}: ${v}`);
  if (extras.length === 0) console.log(`  (no additional fields)`);

  console.log(`\n-- supply --`);
  console.log(`  decimals : ${info.decimals}`);
  console.log(`  supply   : ${fmt(info.supply, info.decimals)}`);

  if (!fee) {
    console.log(`\n-- fee --\n  FAIL  no TransferFeeConfig on this mint`);
  } else {
    const cur = fee.newerTransferFee;
    const uncapped = cur.maximumFee >= (1n << 64n) - 1n;
    console.log(`\n-- fee --`);
    console.log(`  rate      : ${cur.transferFeeBasisPoints} bps (${cur.transferFeeBasisPoints / 100}%)`);
    console.log(`  max fee   : ${uncapped ? "uncapped (true % at all sizes)" : cur.maximumFee.toString() + "  <-- whales pay less than the headline rate"}`);
    console.log(`  withheld  : ${fmt(fee.withheldAmount, info.decimals)} sitting on the mint`);
    console.log(`  withdraw authority : ${fee.withdrawWithheldAuthority?.toBase58() ?? "null"}`);
  }

  // ---- checks ------------------------------------------------------------
  const mintRevoked = info.mintAuthority === null;
  const freezeNull = info.freezeAuthority === null;
  const feeRevoked = isNull(fee?.transferFeeConfigAuthority);
  const ptrRevoked = isNull(ptr?.authority);
  const mdRevoked = isNull(md?.updateAuthority);
  // Check the launch keys are present by name, not by count — 05 adds more
  // later, and a count comparison would print a confusing "3/2 expected".
  const missing = ADDITIONAL_METADATA
    .map(([k]) => k)
    .filter((k) => !extras.some(([ek]) => ek === k));
  const extrasOk = missing.length === 0;

  // Derived from CHAIN state, never from config.ts — this script exists to
  // report what is actually deployed, and a hardcoded rate here would have
  // kept printing "1%" after the mint moved to 0.25%.
  const feeBps = fee?.newerTransferFee.transferFeeBasisPoints;
  const feePct = feeBps === undefined ? "configured" : `${feeBps / 100}%`;

  console.log(`\n-- supply & fee (funds at risk) --`);
  console.log(`  ${ok(mintRevoked)}  mint authority revoked  (supply cannot be inflated)`);
  console.log(`  ${ok(freezeNull)}  freeze authority null   (accounts cannot be frozen)`);
  console.log(`  ${ok(feeRevoked)}  fee authority revoked   (tax locked at ${fee?.newerTransferFee.transferFeeBasisPoints ?? "?"} bps forever)`);
  if (!feeRevoked)
    console.log(`         ^ ${fee!.transferFeeConfigAuthority!.toBase58()} can raise the tax toward 100%. Run 05 to burn it.`);

  // This authority is live forever by design and an auditor will ask about it.
  // Answer in the output rather than leaving it as an unexplained live key.
  console.log(`\n-- withdraw authority (live by design) --`);
  console.log(`  ${fee?.withdrawWithheldAuthority?.toBase58() ?? "null"}`);
  console.log(`  Can move ONLY fees already withheld by the ${feePct} fee — it cannot touch`);
  console.log(`  any holder's principal, mint new supply, or change the rate.`);
  console.log(`  Revoking it would make the fee uncollectable, not safer.`);

  console.log(`\n-- identity (no funds at risk, but mutable) --`);
  console.log(`  ${ok(mdRevoked)}  metadata update authority revoked  (name/symbol/uri frozen)`);
  console.log(`  ${ok(ptrRevoked)}  metadata pointer authority revoked (metadata cannot be repointed)`);
  console.log(`  ${ok(extrasOk)}  launch metadata fields written  (${extras.length} field(s) on chain)`);
  if (!extrasOk)
    console.log(`         ^ missing: ${missing.join(", ")}. InitializeMetadata does not carry these — 01 must send UpdateField instructions.`);

  // ---- verdict -----------------------------------------------------------
  const fundsSafe = mintRevoked && freezeNull && feeRevoked;
  const fullyLocked = fundsSafe && mdRevoked && ptrRevoked;

  console.log(`\n-- verdict --`);
  if (fullyLocked) {
    console.log(`  Fully immutable. Nothing about this token can be changed by anyone.`);
  } else if (fundsSafe) {
    console.log(`  Supply and fee are locked — no authority here can take or freeze a`);
    console.log(`  holder's funds. Identity is still mutable: the ${[
      !mdRevoked && "name/symbol/uri", !ptrRevoked && "metadata pointer",
    ].filter(Boolean).join(" and ")} can still be changed.`);
    console.log(`  That is a rebrand vector, not a rug vector — but say so publicly`);
    console.log(`  rather than letting someone find it.`);
  } else {
    console.log(`  NOT SAFE TO PROMOTE YET — a funds-at-risk check above is failing.`);
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
