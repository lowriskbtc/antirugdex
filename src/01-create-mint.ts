/**
 * Creates the Token-2022 mint: transfer fee (see config.ts) + on-chain metadata, then mints
 * the full supply to the deployer and revokes mint authority.
 *
 *   npx tsx src/01-create-mint.ts                 # dry run, prints the plan
 *   $env:CONFIRM='yes'; npx tsx src/01-create-mint.ts
 *
 * Extension init order is load-bearing. Everything except metadata must be
 * initialized BEFORE InitializeMint; metadata must come AFTER.
 *
 * ⚠️ **The instructions are NOT built in this file.** They live in
 * [mint-core.ts](mint-core.ts), which has no environment access, so the browser launcher on
 * the site builds the identical mint. Change what a launch deploys THERE, never here — most
 * of these authorities are frozen at creation, and `withdrawWithheldAuthority` can never be
 * changed by any instruction at all.
 *
 * This file owns only: config, the dry-run plan, sending, and the mint record.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import path from "path";
import { planMint, buildMintTxs, UNCAPPED_FEE, type MintParams } from "./mint-core.js";
import { TOKEN, ADDITIONAL_METADATA, POST_LOCK_METADATA } from "./config.js";
import {
  connection, loadKeypair, send, explorer, saveMint, fmt, CLUSTER, mainnetGuard,
  envForCluster,
  assertUriServesJson, IS_MAINNET, MINT_FILE, nextMintRollPath,
} from "./lib.js";

async function main() {
  mainnetGuard("create a mint and spend");

  // The URI is baked in at creation and becomes immutable the moment you
  // revoke the metadata update authority. Check it serves real JSON now — a
  // parked domain answers 200 with an HTML lander, so nothing else catches it.
  try {
    await assertUriServesJson(TOKEN.uri);
    console.log(`  metadata URI OK: ${TOKEN.uri}`);
  } catch (e) {
    console.error(`\n${(e as Error).message}\n`);
    // exitCode + return, not exit() — exiting while fetch's keep-alive socket
    // is open trips a libuv assertion that reads like a crash.
    if (IS_MAINNET) { process.exitCode = 1; return; }
    console.warn(`  Continuing anyway because this is devnet.\n`);
  }

  const conn = connection();
  const payer = loadKeypair("DEPLOYER_KEYPAIR");

  // Treasury receives the harvested tax. Keep it separate from the deployer.
  const treasury = envForCluster("TREASURY_PUBKEY")
    ? new PublicKey(envForCluster("TREASURY_PUBKEY")!)
    : payer.publicKey;

  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;

  console.log(`\n=== Creating ${TOKEN.symbol} on ${CLUSTER} ===`);
  console.log(`  deployer : ${payer.publicKey.toBase58()}`);
  console.log(`  treasury : ${treasury.toBase58()}`);
  console.log(`  mint     : ${mint.toBase58()}`);

  const bal = await conn.getBalance(payer.publicKey);
  console.log(`  balance  : ${(bal / 1e9).toFixed(4)} SOL`);

  // ---- rent sizing -------------------------------------------------------
  // Sized in mint-core.planMint from the UNION of launch pairs and the pairs 05 writes
  // later — see the postLockMetadata docstring there for why the ~28 extra bytes are
  // deliberate and what breaks without them.
  const params: MintParams = {
    name: TOKEN.name,
    symbol: TOKEN.symbol,
    uri: TOKEN.uri,
    decimals: TOKEN.decimals,
    totalSupply: TOKEN.totalSupply,
    feeBasisPoints: TOKEN.feeBasisPoints,
    maximumFee: TOKEN.maximumFee,
    payer: payer.publicKey,
    treasury,
    additionalMetadata: [...ADDITIONAL_METADATA],
    postLockMetadata: [...POST_LOCK_METADATA],
  };
  const plan = await planMint(conn, params, mint);
  const { ata, supply, mintLen, metadataLen, rentLamports: lamports } = plan;
  console.log(`  rent     : ${(lamports / 1e9).toFixed(6)} SOL (${mintLen}+${metadataLen} bytes)`);

  // ---- the plan ----------------------------------------------------------
  // Everything above and below is computed before anything is sent, so the dry
  // run reports the real numbers. The one value that is NOT real in a dry run
  // is the mint address: the keypair is generated per invocation and discarded
  // here. Rent is unaffected — pack(metadata) encodes the pubkey as a fixed 32
  // bytes, so the sizes and lamports hold whichever key the real run draws.
  const uncapped = TOKEN.maximumFee === UNCAPPED_FEE;

  console.log(`  supply   : ${fmt(supply, TOKEN.decimals)} ${TOKEN.symbol} -> ${ata.toBase58()}`);
  console.log(`  fee      : ${TOKEN.feeBasisPoints} bps, ${uncapped ? "uncapped" : `max ${TOKEN.maximumFee}`}`);
  console.log(`  authorities the mint ends this script with:`);
  console.log(`    mint             REVOKED — same tx as the mint-to, so supply can never be inflated`);
  console.log(`    freeze           NEVER SET — this is the honeypot vector`);
  console.log(`    transferFeeConfig ${payer.publicKey.toBase58()}  (deployer; 05 revokes it)`);
  console.log(`    withdrawWithheld  ${treasury.toBase58()}  (treasury; FIXED AT CREATION)`);
  console.log(`    metadataUpdate    ${payer.publicKey.toBase58()}  (deployer; 05 can revoke it)`);

  // Named here rather than only at save time: saveMint runs after both sends,
  // so by the time it reports a roll the run is already unwindable. The record
  // is what the 2026-08-09 accident actually destroyed.
  const rollTarget = nextMintRollPath();
  console.log(`  record   : ${path.basename(MINT_FILE)}${
    rollTarget ? ` — the existing one rolls to ${path.basename(rollTarget)}` : " (new)"}`);

  // Dry run by default, matching every other write script here. 01 was the
  // exception until 2026-08-09, when a run expected to print a plan instead
  // created a mint and overwrote mint.devnet.json.
  //
  // Asymmetry worth knowing: mainnetGuard above already exits unless
  // CONFIRM=yes, so on mainnet this gate is a pass-through and there is no
  // plan step. The dry run is a devnet affordance, by construction.
  if (process.env.CONFIRM !== "yes") {
    console.log(`\n  DRY RUN — nothing sent, nothing spent. Set CONFIRM=yes to create the mint.`);
    console.log(`  IRREVERSIBLE once it runs: a mint address exists forever, and`);
    console.log(`  withdrawWithheldAuthority is fixed at creation — no instruction can ever`);
    console.log(`  change it, so a wrong treasury above can only be fixed by re-minting.`);
    console.log(`  The mint address above — and the deployer ATA derived from it — belong to`);
    console.log(`  a keypair thrown away when this dry run ends. The real run draws a`);
    console.log(`  different pair, so don't publish or record either of them.\n`);
    return;
  }

  // Checked after the gate on purpose: a dry run should still print the whole
  // plan from an unfunded deployer, which is exactly when you want to read it.
  if (bal < 0.02e9) throw new Error("Deployer needs at least ~0.02 SOL.");

  // ---- create + initialize ----------------------------------------------
  // Both instruction lists come from mint-core, unchanged, so the browser launcher deploys
  // a byte-identical mint. They are SEQUENTIAL: tx2 mints into an ATA for a mint tx1
  // creates, so tx1 must confirm first.
  const { createIxs, supplyIxs } = buildMintTxs(params, plan);

  await send(conn, createIxs, [payer, mintKp], "mint created");
  await send(conn, supplyIxs, [payer], "supply minted + mint authority revoked");

  saveMint({
    cluster: CLUSTER,
    mint: mint.toBase58(),
    deployer: payer.publicKey.toBase58(),
    treasury: treasury.toBase58(),
    deployerAta: ata.toBase58(),
    decimals: TOKEN.decimals,
    supply: supply.toString(),
    feeBasisPoints: TOKEN.feeBasisPoints,
  });

  console.log(`\n  ${fmt(supply, TOKEN.decimals)} ${TOKEN.symbol} -> ${ata.toBase58()}`);
  console.log(`  ${explorer(mint)}`);
  console.log(`\nNext: npm run verify   (then test-tax on devnet)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
