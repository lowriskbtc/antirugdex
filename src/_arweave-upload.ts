/**
 * Uploads a file to Arweave via ArDrive Turbo, then PROVES it landed there.
 *
 *   npx tsx src/_arweave-upload.ts site/token/ard.png
 *   $env:CONFIRM='yes'; npx tsx src/_arweave-upload.ts site/token/ard.png
 *
 * ## Why this script exists rather than an ad-hoc upload
 *
 * On 2026-08-07 the logo was uploaded with `@irys/upload` and recorded as being on Arweave.
 * It was not. `@irys/upload-core` defaults to `https://uploader.irys.xyz` — Irys's own
 * network — and the item it returned has a **44-character** id, while Arweave transaction
 * ids are 43. Arweave never said "not found"; it said `invalid tx id`. Two days were then
 * spent waiting for `arweave.net` to index something that could never appear there.
 *
 * The upload tool's own success message is therefore treated as **evidence of nothing**.
 * This script asks the canonical gateway directly, and refuses to print a usable URL until
 * that gateway confirms the transaction exists.
 *
 * ## What "verified" means here, precisely
 *
 * It means whatever `_arweave-verify.ts` says it means — this script imports that check
 * rather than keeping its own copy. It used to keep its own copy, asserting that
 * `GET /tx/<id>/status` must return 200, and **that was wrong**: Turbo uploads *bundled
 * data items*, which are not layer-1 transactions and never appear on `/tx/*`. The gate
 * could not open. See the header of `_arweave-verify.ts` for the full history.
 *
 * A fresh upload will normally report PENDING here — the bundle takes time to be posted and
 * mined. That is the one case where waiting is genuinely correct.
 *
 * Nothing here writes to `config.ts`, `metadata.json` or the site. Recording the id is a
 * separate, deliberate step once it is verified — see ARWEAVE-PROGRESS.md.
 */

import { TurboFactory } from "@ardrive/turbo-sdk/node";
import { Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { check } from "./_arweave-verify.js";

/**
 * Base58, inline.
 *
 * `bs58` is only a *transitive* dependency here (via web3.js) and ships no types, so
 * importing it means either an untyped import or a new direct dependency — for fifteen
 * lines of well-known algorithm that a secret key passes through. It is written out
 * instead, and `assertBase58Correct` proves it against web3.js before it is ever used on
 * key material.
 */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  // Leading zero bytes are significant and vanish in the bigint, so re-add them as '1'.
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/**
 * Self-test with a real oracle: web3.js already knows the base58 of a public key, so
 * encoding the same 32 bytes must reproduce it exactly. A silently wrong encoder would
 * otherwise produce a signer for the wrong wallet — and the upload would still "succeed".
 */
function assertBase58Correct(kp: Keypair): void {
  const mine = base58(kp.publicKey.toBytes());
  const theirs = kp.publicKey.toBase58();
  if (mine !== theirs)
    throw new Error(`base58 encoder is wrong: got ${mine}, web3.js says ${theirs}`);
}

const ARWEAVE = "https://arweave.net";
/** Turbo's free tier. Both of this project's files are far below it. */
const FREE_LIMIT = 100 * 1024;

/**
 * A throwaway signer, saved so a re-run is reproducible.
 *
 * Free uploads need a *signature*, not funds, so no project wallet has to appear on a
 * public permanent record. That property was deliberate in the first attempt and is kept.
 */
function uploadSigner(): Keypair {
  const file = path.join(process.cwd(), "arweave-uploader.json");
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`  new uploader keypair saved to ${file}`);
  console.log(`  (throwaway — signs the upload, never funded, never the project wallet)`);
  return kp;
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".json") return "application/json";
  if (ext === ".svg") return "image/svg+xml";
  throw new Error(`Refusing to guess a Content-Type for ${ext}. Add it to this script.`);
}


async function main() {
  const rel = process.argv[2];
  if (!rel) throw new Error("Usage: npx tsx src/_arweave-upload.ts <file>");
  const file = path.resolve(rel);
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);

  const size = fs.statSync(file).size;
  const ct = contentType(file);

  console.log(`\nArweave upload — via ArDrive Turbo`);
  console.log(`  file         : ${rel}`);
  console.log(`  size         : ${size.toLocaleString()} bytes`);
  console.log(`  content-type : ${ct}`);
  console.log(`  cost         : ${size < FREE_LIMIT ? "FREE (under Turbo's 100 KiB free tier)" : "PAID — over the free tier, needs credits"}`);

  if (size >= FREE_LIMIT)
    throw new Error(
      "Over the free tier. This script is written for the free path only; funding Turbo " +
        "credits is a separate, deliberate step.",
    );

  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — nothing uploaded. Re-run with CONFIRM=yes.`);
    console.log(`  NOTE: an Arweave upload is PERMANENT and PUBLIC. It cannot be deleted.\n`);
    return;
  }

  const kp = uploadSigner();
  assertBase58Correct(kp);
  const turbo = TurboFactory.authenticated({
    privateKey: base58(kp.secretKey),
    token: "solana",
  });

  console.log(`\n-> uploading as ${kp.publicKey.toBase58()}`);
  const receipt = await turbo.uploadFile({
    file,
    dataItemOpts: { tags: [{ name: "Content-Type", value: ct }] },
  });

  const id = receipt.id;
  console.log(`\n  returned id  : ${id}`);
  // Length is printed, never gated on: Turbo and Irys data-item ids are both 43 chars, so
  // this distinguishes nothing. The 44-char Irys id was an anomaly. The index check does
  // the real work below.
  console.log(`  id length    : ${id.length}`);
  if (receipt.deadlineHeight) console.log(`  deadline blk : ${receipt.deadlineHeight}`);

  // Record the raw receipt immediately. If verification is still pending later, the next
  // session needs the id without re-uploading — the first attempt lost this.
  const out = path.join(process.cwd(), `arweave-receipts.json`);
  const all = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : [];
  all.push({ file: rel, size, contentType: ct, id, uploadedBy: kp.publicKey.toBase58(), receipt });
  fs.writeFileSync(out, JSON.stringify(all, null, 2));
  console.log(`  receipt saved: ${out}`);

  // ---- proof, not optimism ----
  // Delegated to _arweave-verify.ts so there is exactly ONE definition of "confirmed".
  console.log(`\n  asking arweave.net directly...`);
  const confirmed = await check({ id, file: rel });

  if (confirmed) {
    console.log(`\n  ✅ Safe to record: ${ARWEAVE}/${id}\n`);
  } else {
    console.log(
      `\n  Not confirmed yet — expected for a fresh upload. The receipt is saved, so the\n` +
        `  id cannot be lost. Re-run until it prints ✅ CONFIRMED:\n` +
        `     npx tsx src/_arweave-verify.ts ${id}\n` +
        `  DO NOT record this URL in config.ts or metadata.json before then.\n`,
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
