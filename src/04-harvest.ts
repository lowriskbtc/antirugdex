/**
 * Collects the tax. Without this, the fee is taken from users and then sits
 * there uncollectable — the single most common way a Token-2022 fee token
 * quietly earns nothing.
 *
 * Withheld fees accumulate on each RECIPIENT token account (including the
 * DEX pool's). Collection is two steps:
 *   1. harvestWithheldTokensToMint  — permissionless, sweeps accounts -> mint
 *   2. withdrawWithheldTokensFromMint — authority-only, mint -> treasury
 *
 * Run this on a schedule once you have volume.
 */
import { PublicKey, Signer } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getMint, getAccount, unpackAccount, getTransferFeeAmount,
  harvestWithheldTokensToMint, withdrawWithheldTokensFromMint,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  getTransferFeeConfig,
} from "@solana/spl-token";
import {
  connection, loadKeypair, loadKeypairFromPath, readMint, send, fmt, explorer, envForCluster,
} from "./lib.js";

const CHUNK = 20; // accounts per harvest tx; more than ~25 blows the tx size limit

async function main() {
  const conn = connection();
  const rec = readMint();
  const mint = new PublicKey(rec.mint);

  const payer = loadKeypair("DEPLOYER_KEYPAIR");

  const info = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const cfg = getTransferFeeConfig(info);
  if (!cfg) throw new Error("No transfer fee config on this mint.");

  // Whoever holds withdrawWithheldAuthority must sign step 3. Two shapes work:
  //
  //   single keypair             -> authority = Keypair,        multiSigners = []
  //   Token-2022 native multisig -> authority = multisig pubkey, multiSigners = members
  //
  // A SQUADS VAULT DOES NOT WORK HERE. It is a PDA with no private key and can
  // only sign via CPI from the Squads program, so this script could never
  // complete step 3 — fees would harvest onto the mint and strand there. If you
  // want Squads custody, set withdrawWithheldAuthority to a plain cold keypair
  // and forward collected tokens to the Squads vault afterwards, or build the
  // WithdrawWithheldTokensFromMint instruction as a Squads proposal outside
  // this repo.
  // Both of these read through envForCluster. They used to read the BARE names while
  // .env only carries the suffixed ones, so on mainnet the multisig branch was invisible
  // and the else-branch loaded DEPLOYER_KEYPAIR instead of WITHHELD_AUTHORITY_KEYPAIR —
  // surfacing as "Wrong signer" naming the deployer, on the one script that collects fees.
  // Fixed 2026-08-11. envForCluster still falls back to the bare name, so nothing breaks.
  const memberPaths = (envForCluster("WITHHELD_MULTISIG_SIGNERS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  let authority: Signer | PublicKey;
  let multiSigners: Signer[] = [];

  if (memberPaths.length > 0) {
    authority = cfg.withdrawWithheldAuthority;
    multiSigners = memberPaths.map((p) => loadKeypairFromPath(p, "WITHHELD_MULTISIG_SIGNERS"));
    console.log(`Using Token-2022 native multisig ${authority.toBase58()} ` +
      `with ${multiSigners.length} member signature(s).`);
  } else {
    const kp = loadKeypair(
      envForCluster("WITHHELD_AUTHORITY_KEYPAIR") ? "WITHHELD_AUTHORITY_KEYPAIR" : "DEPLOYER_KEYPAIR",
    );
    if (!cfg.withdrawWithheldAuthority.equals(kp.publicKey)) {
      throw new Error(
        `Wrong signer. withdrawWithheldAuthority is ${cfg.withdrawWithheldAuthority.toBase58()}, ` +
          `you loaded ${kp.publicKey.toBase58()}.\n` +
          `If that address is a Token-2022 multisig, set WITHHELD_MULTISIG_SIGNERS to a\n` +
          `comma-separated list of member keypair paths. If it is a Squads vault, this\n` +
          `script cannot sign for it — see the comment above.`,
      );
    }
    authority = kp;
  }

  // ---- 1. find every account holding withheld tokens ---------------------
  // Token account layout puts `mint` at offset 0, so one memcmp finds them all
  // regardless of which extensions each account carries.
  //
  // Caveat that no typecheck will catch: this is an unindexed getProgramAccounts
  // scan over all of Token-2022. Many free and starter RPC tiers disable or
  // hard-throttle gPA. Test it against the RPC you will actually use in
  // production before you depend on this for revenue.
  //
  // Fallback: pass token account addresses as CLI args to harvest them
  // directly, no scan. The DEX pool account accrues the large majority of
  // withheld fees and you will know its address, so the scan should be an
  // optimization rather than the only path to your money.
  const explicit = process.argv.slice(2).map((a) => new PublicKey(a));

  const withFees: PublicKey[] = [];
  let pending = 0n;

  if (explicit.length > 0) {
    console.log(`\nHarvesting ${explicit.length} account(s) passed on the command line.`);
    for (const pubkey of explicit) {
      const acct = await conn.getAccountInfo(pubkey, "confirmed");
      if (!acct) { console.log(`  skip ${pubkey.toBase58()}: not found`); continue; }
      try {
        const unpacked = unpackAccount(pubkey, acct, TOKEN_2022_PROGRAM_ID);
        // unpackAccount happily decodes a Token-2022 account of a DIFFERENT
        // mint. Without this check a mistyped address reaches the harvest
        // instruction and fails the whole batch with an opaque error.
        if (!unpacked.mint.equals(mint)) {
          console.log(`  skip ${pubkey.toBase58()}: belongs to mint ${unpacked.mint.toBase58()}`);
          continue;
        }
        const held = getTransferFeeAmount(unpacked)?.withheldAmount ?? 0n;
        if (held > 0n) { withFees.push(pubkey); pending += held; }
        else console.log(`  skip ${pubkey.toBase58()}: nothing withheld`);
      } catch {
        console.log(`  skip ${pubkey.toBase58()}: not a Token-2022 token account`);
      }
    }
  } else {
    console.log(`\nScanning Token-2022 accounts for ${mint.toBase58()} ...`);
    let accounts;
    try {
      accounts = await conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
      });
    } catch (e) {
      console.error(
        `\ngetProgramAccounts failed: ${(e as Error).message}\n` +
          `Your RPC probably disallows unindexed scans. Either use an RPC that\n` +
          `permits gPA, or pass the token accounts directly:\n` +
          `  npm run harvest -- <poolTokenAccount> <otherAccount> ...\n`,
      );
      process.exit(1);
    }

    // One malformed or unexpected account must not kill the whole run.
    let skipped = 0;
    for (const { pubkey, account } of accounts) {
      try {
        const held = getTransferFeeAmount(unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID))
          ?.withheldAmount ?? 0n;
        if (held > 0n) { withFees.push(pubkey); pending += held; }
      } catch { skipped++; }
    }
    console.log(`  ${accounts.length} matching accounts, ${withFees.length} with withheld fees` +
      (skipped ? `, ${skipped} unparseable (skipped)` : ""));
  }

  console.log(`  on accounts : ${fmt(pending, info.decimals)}`);
  console.log(`  on mint     : ${fmt(cfg.withheldAmount, info.decimals)}`);

  if (pending === 0n && cfg.withheldAmount === 0n) {
    console.log(`\nNothing to collect.\n`);
    return;
  }

  // ---- 2. sweep accounts -> mint ----------------------------------------
  for (let i = 0; i < withFees.length; i += CHUNK) {
    const batch = withFees.slice(i, i + CHUNK);
    const sig = await harvestWithheldTokensToMint(
      conn, payer, mint, batch, undefined, TOKEN_2022_PROGRAM_ID,
    );
    console.log(`  harvested ${batch.length} accounts: ${explorer(sig, "tx")}`);
  }

  // ---- 3. mint -> treasury ----------------------------------------------
  const authorityPubkey = authority instanceof PublicKey ? authority : authority.publicKey;
  const treasury = new PublicKey((rec.treasury as string) ?? authorityPubkey.toBase58());
  const dst = getAssociatedTokenAddressSync(mint, treasury, false, TOKEN_2022_PROGRAM_ID);

  await send(conn, [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, dst, treasury, mint, TOKEN_2022_PROGRAM_ID,
    ),
  ], [payer], "treasury account ready");

  const before = (await getAccount(conn, dst, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

  const sig = await withdrawWithheldTokensFromMint(
    conn, payer, mint, dst, authority, multiSigners, undefined, TOKEN_2022_PROGRAM_ID,
  );
  console.log(`  withdrew to treasury: ${explorer(sig, "tx")}`);

  // The only assertion that matters: did the money actually arrive.
  const after = (await getAccount(conn, dst, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const gained = after - before;
  const mintAfter = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);

  console.log(`\n  Treasury account : ${dst.toBase58()}`);
  console.log(`  Balance          : ${fmt(before, info.decimals)} -> ${fmt(after, info.decimals)}`);
  console.log(`  Collected        : ${fmt(gained, info.decimals)}`);
  console.log(`  Left on mint     : ${fmt(getTransferFeeConfig(mintAfter)?.withheldAmount ?? 0n, info.decimals)}`);
  console.log(`\n  ${gained > 0n ? "PASS — fees are collectable and landed in the treasury." : "FAIL — nothing arrived. Check the withdraw authority."}\n`);
  if (gained === 0n) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
