/**
 * AntiRugDex grader — CLI shell.
 *
 *   npx tsx src/grade.ts <mint>
 *   npx tsx src/grade.ts <mint> --pool <poolId>
 *   npx tsx src/grade.ts <mint> --program <programId>
 *   npx tsx src/grade.ts <mint> --json | --html out.html
 *   npx tsx src/grade.ts <mint> --mainnet|--devnet [--rpc <url>]
 *
 * ⚠️ **The checks themselves are NOT in this file.** They live in
 * [grade-core.ts](grade-core.ts), which has no `process`, no `fs` and no `lib.js`, so the
 * web grader on the site runs the identical code. Add a check there, never here — a rule
 * implemented twice is a rule that will eventually disagree with itself, and this grader's
 * whole value is that its answer is the same answer everywhere.
 *
 * This file owns only: argv, cluster/RPC selection, and text output.
 *
 * REQUIRES A KEYED RPC for holder concentration. getTokenLargestAccounts is refused by
 * every free public endpoint tried (api.mainnet-beta and api.devnet return 429 even with
 * backoff; publicnode returns 403). Without a key that row reports FLAGGED / NOT CHECKED
 * rather than silently omitting itself:
 *
 *     npx tsx src/grade.ts <mint> --mainnet --rpc https://...your-key...
 *
 * Verified 2026-08-07 on a keyed endpoint, both directions:
 *   BONK  -> 7.68% largest / 24.00% top-5   -> no flag   (correct)
 *   ARD   -> 99.89% largest                 -> FLAGGED   (correct)
 * Pool vaults are excluded from the figures, so burned LP does not read as a whale.
 */
import { PublicKey } from "@solana/web3.js";
import { CpmmPoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import {
  grade, renderReportHtml, CANNOT_VERIFY, type Row, type DecodedPool,
} from "./grade-core.js";

// CLUSTER is read at module-load time in lib.ts, so the flags have to be applied to
// process.env BEFORE that import happens — hence the dynamic import inside main(). Nobody
// should have to edit a dotfile to point a read-only tool at a different network.
const argv = process.argv.slice(2);
if (argv.includes("--mainnet")) process.env.CLUSTER = "mainnet";
if (argv.includes("--devnet")) process.env.CLUSTER = "devnet";
const rpcFlag = argv.includes("--rpc") ? argv[argv.indexOf("--rpc") + 1] : undefined;
if (rpcFlag) {
  process.env.RPC_URL_MAINNET = rpcFlag;
  process.env.RPC_URL_DEVNET = rpcFlag;
}

const flagValue = (name: string) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;

async function main() {
  const { connection, explorer, CLUSTER } = await import("./lib.js");
  const poolArg = flagValue("--pool");
  const programArg = flagValue("--program");
  const htmlArg = flagValue("--html");
  const asJson = argv.includes("--json");

  const consumed = new Set([rpcFlag, poolArg, programArg, htmlArg].filter(Boolean) as string[]);
  const arg = argv.find((a) => !a.startsWith("--") && !consumed.has(a));
  if (!arg) {
    console.error(
      `usage: npx tsx src/grade.ts <mint-address> [--json]\n` +
      `  reads ${CLUSTER}; set CLUSTER=mainnet in .env for mainnet`,
    );
    process.exit(1);
  }

  const conn = connection();
  const mint = new PublicKey(arg);

  const rows = await grade(conn, mint, {
    poolId: poolArg ? new PublicKey(poolArg) : undefined,
    programId: programArg ? new PublicKey(programArg) : undefined,
    // The Raydium SDK is injected rather than imported by the core, so the browser bundle
    // does not have to carry it. See the DecodedPool docstring in grade-core.ts.
    decodePool: (data) => CpmmPoolInfoLayout.decode(data as Buffer) as unknown as DecodedPool,
  });

  // ---- output -------------------------------------------------------------
  if (htmlArg) {
    (await import("node:fs")).writeFileSync(
      htmlArg, renderReportHtml(mint.toBase58(), CLUSTER, rows),
    );
    console.log(`wrote ${htmlArg}`);
    return;
  }

  if (asJson) {
    console.log(JSON.stringify({ mint: mint.toBase58(), cluster: CLUSTER, rows }, null, 2));
    return;
  }

  const flagged = rows.filter((r) => r.level === "FLAGGED");
  const verified = rows.filter((r) => r.level === "VERIFIED");
  const info_ = rows.filter((r) => r.level === "INFO");

  console.log(`\n=== ${mint.toBase58()} (${CLUSTER}) ===`);
  console.log(explorer(mint));

  const show = (r: Row, tag: string) => {
    console.log(`  ${tag}  ${r.key.padEnd(26)} ${r.value}`);
    if (r.note) console.log(`         ${r.note}`);
  };

  if (flagged.length) {
    console.log(`\n-- FLAGGED (${flagged.length}) --`);
    flagged.forEach((r) => show(r, "!!"));
  }
  console.log(`\n-- VERIFIED (${verified.length}) --`);
  verified.forEach((r) => show(r, "ok"));
  console.log(`\n-- FACTS (no judgement) --`);
  info_.forEach((r) => show(r, "  "));

  // The bucket that makes the report honest. On-chain config cannot see any of this, and a
  // grader that omits it implies the launch is clean when it has only been checked for the
  // things that happen to be readable. Shared with the HTML report so the two cannot drift.
  console.log(`\n-- CANNOT BE VERIFIED ON CHAIN, BY ANYONE --`);
  for (const s of CANNOT_VERIFY) console.log(`  ??  ${s}`);
  console.log(
    `      A bad concentration number proves concentration; a good one proves nothing —\n` +
    `      300 wallets held by one person reports as perfect distribution.`,
  );

  console.log(
    `\n-- verdict --\n` +
    (flagged.length === 0
      ? `  No flagged risks in what CAN be read on chain.\n` +
        `  That is NOT the same as safe — read the cannot-verify list above.`
      : `  ${flagged.length} flagged risk${flagged.length > 1 ? "s" : ""} above.\n` +
        `  Read them individually; some may be deliberate and disclosed by the team.`) + `\n`,
  );
}

main().catch((e) => { console.error(`\n${(e as Error).message}\n`); process.exitCode = 1; });
