/**
 * Creates the Raydium CPMM pool — with trading DISABLED until a future time.
 *
 *   npx tsx src/06-create-pool.ts                 # dry run, prints the plan
 *   $env:CONFIRM='yes'; npx tsx src/06-create-pool.ts
 *
 * Runs on BOTH clusters as of 2026-08-11. The mainnet path was previously refused, but the
 * refusal hid a worse problem: the Raydium program id, the fee account and the SDK's
 * `cluster` were all hardcoded to devnet, so lifting the guard alone would have pointed a
 * mainnet transaction at a devnet program. All three are branches now.
 *
 * Env knobs:
 *   POOL_ARD=1000000     tokens of ARD to seed (whole tokens)
 *   POOL_SOL=0.1         SOL to seed
 *   POOL_OPEN_IN=7200    seconds until trading opens (default 2h)
 *
 * 🔴 THE DEFAULT POOL_OPEN_IN DOES NOT WORK against the default sale grace periods.
 * `mark_pool_created` requires `open_time <= pool_deadline`, and with every default
 * `pool_deadline = close_ts + 7200` while `open_time = close_ts + 7200 + eps`. As of
 * 2026-08-11 this script reads the live Sale account and REFUSES rather than creating a
 * pool that can never be proven — but pass POOL_OPEN_IN explicitly anyway (3600).
 *
 * WHY open_time MATTERS — this is the load-bearing piece of the launch
 * sequence. Raydium CPMM enforces it in swap_base_input.rs:
 *
 *     if !pool_state.get_status_by_bit(PoolStatusBitIndex::Swap)
 *        || block_timestamp < pool_state.open_time { return NotApproved }
 *
 * and LP tokens are minted to the creator at initialize, NOT deferred to the
 * first trade. So we can create the pool, seed it, BURN the LP, and publish
 * every address — while trading is provably impossible. The configuration is
 * final and auditable before anyone can act on it. That window is the product.
 *
 * ORDERING (do not rearrange):
 *   settle -> THIS -> burn LP -> publish -> open_time passes -> claims open
 * Claims must come last: with zero circulating supply nobody can squat a
 * competing pool, and the only possible first trade is a buy.
 *
 * THE 0.25% HAIRCUT: seeding is an ordinary transfer, so the pool vault
 * receives 0.9975x what we send. The real opening price must be computed from
 * POST-fee vault balances, never from the amounts passed in here.
 */
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  Raydium, TxVersion, DEVNET_PROGRAM_ID, CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC, getCpmmPdaAmmConfigId,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import fs from "fs";
import path from "path";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint, getTransferFeeConfig,
} from "@solana/spl-token";
import { connection, loadKeypair, readMint, explorer, fmt, CLUSTER, IS_MAINNET } from "./lib.js";
import { salePda, fetchSale } from "./sale-client.js";

const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

const ARD_AMOUNT = BigInt(process.env.POOL_ARD ?? "1000000");
const SOL_AMOUNT = Number(process.env.POOL_SOL ?? "0.1");
const OPEN_IN = Number(process.env.POOL_OPEN_IN ?? "7200");

async function main() {
  const conn = connection();
  const owner = loadKeypair("DEPLOYER_KEYPAIR");
  const mintAddr = new PublicKey(readMint().mint);

  const info = await getMint(conn, mintAddr, "confirmed", TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(info);
  const bps = fee?.newerTransferFee.transferFeeBasisPoints ?? 0;

  const ardRaw = ARD_AMOUNT * 10n ** BigInt(info.decimals);
  const solRaw = BigInt(Math.round(SOL_AMOUNT * 1e9));

  // What the pool will ACTUALLY receive after the transfer fee. Token-2022
  // rounds the fee UP, so this is ceil-based, not amount*0.9975.
  const haircut = (bps * Number(ardRaw)) / 10000;
  const ardCredited = ardRaw - BigInt(Math.ceil(haircut));

  const openAt = Math.floor(Date.now() / 1000) + OPEN_IN;

  // ---- the pool_deadline guard -------------------------------------------
  //
  // `mark_pool_created` hard-requires BOTH `now < pool_deadline` (line 74) and
  // `open_time <= pool_deadline` (line 129). Nothing here used to know that, so the
  // default POOL_OPEN_IN (7200) against the default grace periods (3600 + 3600) produced
  // a pool that can NEVER be proven: the pool can only be created after `finalize`, i.e.
  // at close_ts + eps, making open_time = close_ts + 7200 + eps > pool_deadline. Step 9
  // fails with OpenTimeTooLate, the sale drops to the refund path, and the seed is
  // already committed to a pool. That combination has never been run and does not work.
  //
  // This reads the deadline off the live Sale account rather than recomputing it, so it
  // cannot drift from what the program will actually check. No sale (a bare pool test, or
  // a rehearsal before initialize) degrades to a warning, never a throw.
  let blocker: string | null = null;
  let deadlineNote: string[] = [];
  try {
    const [saleAddr] = salePda(mintAddr);
    const sale = await fetchSale(conn, saleAddr);
    if (!sale) {
      deadlineNote = [
        `  pool deadline  : NOT CHECKED — no Sale account at ${saleAddr.toBase58()}`,
        `                   Fine for a standalone pool test. If a sale is supposed to exist,`,
        `                   this pool can never be proven by 14-mark-pool.ts.`,
      ];
    } else {
      const deadline = Number(sale.pool_deadline);
      const now = Math.floor(Date.now() / 1000);
      const maxOpenIn = deadline - now;
      deadlineNote = [
        `  pool deadline  : ${new Date(deadline * 1000).toISOString()}  (sale ${saleAddr.toBase58()})`,
        maxOpenIn > 0
          ? `  margin         : open_time is ${deadline - openAt}s inside the deadline; ` +
            `max POOL_OPEN_IN right now is ${maxOpenIn}s`
          : `  margin         : NONE — the deadline is ${-maxOpenIn}s in the past`,
      ];
      if (now >= deadline) {
        blocker =
          `pool_deadline has already passed (${new Date(deadline * 1000).toISOString()}).\n` +
          `  14-mark-pool.ts requires now < pool_deadline, so this pool could never be proven.\n` +
          `  The sale's only remaining path is 19-fail-pool.ts and refunds. Do NOT seed a pool.`;
      } else if (openAt > deadline) {
        blocker =
          `open_time ${new Date(openAt * 1000).toISOString()} is AFTER pool_deadline ` +
          `${new Date(deadline * 1000).toISOString()}.\n` +
          `  14-mark-pool.ts requires open_time <= pool_deadline and would fail with\n` +
          `  OpenTimeTooLate — the pool becomes unprovable and the seed is stranded in it\n` +
          `  while the sale drops to the refund path.\n` +
          `  Re-run with POOL_OPEN_IN at most ${maxOpenIn} (leave slack for burn-LP + mark).`;
      } else if (maxOpenIn - OPEN_IN < 600) {
        deadlineNote.push(
          `  ⚠  under 10 min of slack between open_time and pool_deadline. Burning the LP`,
          `     and running 14-mark-pool.ts both have to land in that window.`,
        );
      }
    }
  } catch (e) {
    deadlineNote = [
      `  pool deadline  : NOT CHECKED — ${(e as Error).message.split("\n")[0]}`,
      `                   (rule 3: a check that could not run is flagged, never silent)`,
    ];
  }

  console.log(`\n=== Raydium CPMM pool for ${mintAddr.toBase58()} on ${CLUSTER} ===\n`);
  console.log(`  seeding ARD    : ${fmt(ardRaw, info.decimals)}`);
  console.log(`  fee haircut    : ${bps} bps -> pool actually receives ${fmt(ardCredited, info.decimals)}`);
  console.log(`  seeding SOL    : ${SOL_AMOUNT}`);
  console.log(`  nominal price  : ${(Number(solRaw) / Number(ardRaw)).toExponential(6)} SOL/ARD`);
  console.log(`  REAL price     : ${(Number(solRaw) / Number(ardCredited)).toExponential(6)} SOL/ARD  <-- post-fee, this is the one to publish`);
  console.log(`  trading opens  : ${new Date(openAt * 1000).toISOString()}  (in ${OPEN_IN}s)`);
  for (const line of deadlineNote) console.log(line);
  console.log(`  owner          : ${owner.publicKey.toBase58()}`);

  const bal = await conn.getBalance(owner.publicKey);
  console.log(`  owner SOL      : ${(bal / 1e9).toFixed(4)}`);

  // Printed in the dry run too — the dry run is what gets read before CONFIRM=yes, and
  // this failure is only recoverable before the seed moves.
  if (blocker) {
    console.error(`\n  REFUSING: ${blocker}\n`);
    process.exit(1);
  }

  // ---- which Raydium, and which fee tier ---------------------------------
  //
  // This script used to hardcode the DEVNET program id, the DEVNET fee account and
  // `cluster: "devnet"`, with the mainnet refusal below as the only thing standing between
  // that and a mainnet transaction aimed at a devnet program. Removing the guard alone
  // would have been actively dangerous; all three had to become branches. 2026-08-11.
  const programId = IS_MAINNET
    ? CREATE_CPMM_POOL_PROGRAM
    : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;
  const poolFeeAccount = IS_MAINNET
    ? CREATE_CPMM_POOL_FEE_ACC
    : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC;

  // Owner's call, 2026-08-11: the 0.50% trade tier, not Raydium's 0.25% default.
  //
  // Mainnet serves 19 configs and THREE of them are 0.50% (`tradeFeeRate = 5000`, per 1e6).
  // They are identical except for `creatorFeeRate`: index 4 = 500, index 10 = 4000,
  // index 15 = 7500 — and only index 4 has `showWithUI: true`. Index 4's 500 is the SAME
  // creator rate as Raydium's default index 0, so choosing it changes the trade fee and
  // nothing else. Pinned by index, never by `feeConfigs[0]`: the API returns them unordered
  // (index 0 came back first, but index 17 came back tenth), so position is not identity.
  //
  // ⚠️ What `creatorFeeRate` actually does on CPMM is NOT established from primary sources
  // here. It is pinned at the default value rather than resolved, which is why this choice
  // is safe without resolving it — but if it routes claimable fees to the pool creator,
  // that is a disclosure item for our own grader ("LP burned vs LP locked" is already a row
  // it checks). Do not assume; read it off the AmmConfig account before launch.
  const MAINNET_AMM_CONFIG_INDEX = 4;

  const raydium = await Raydium.load({
    connection: conn,
    owner,
    cluster: IS_MAINNET ? "mainnet" : "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
  });

  const feeConfigs = await raydium.api.getCpmmConfigs().catch(() => []);
  let feeConfig: any = IS_MAINNET
    ? feeConfigs.find((c: any) => c.index === MAINNET_AMM_CONFIG_INDEX)
    : feeConfigs[0];
  if (!feeConfig)
    throw new Error(
      IS_MAINNET
        ? `Raydium's API did not return CPMM config index ${MAINNET_AMM_CONFIG_INDEX}. ` +
          `Do NOT fall back to another index — the fee tier is a launch parameter.`
        : "could not load a CPMM fee config from the API",
    );
  // The API does not serve devnet configs, so the id it returns is the mainnet one. Derive
  // the config PDA from whichever program we are actually talking to.
  feeConfig.id = getCpmmPdaAmmConfigId(programId, feeConfig.index).publicKey.toBase58();

  console.log(
    `\n  amm_config     : index ${feeConfig.index}  ` +
    `trade ${(Number(feeConfig.tradeFeeRate) / 10000).toFixed(2)}%  ` +
    `creator ${feeConfig.creatorFeeRate}  ${feeConfig.id}`,
  );
  if (IS_MAINNET) {
    console.log(
      `  create fee     : ${Number(feeConfig.createPoolFee) / 1e9} SOL to Raydium`,
    );
    console.log(
      `  round trip     : ~${(Number(feeConfig.tradeFeeRate) / 10000 + bps / 100).toFixed(2)}% ` +
      `one way (swap + ARD's ${bps} bps transfer fee) — the number to disclose`,
    );
  }

  if (process.env.CONFIRM !== "yes") {
    console.log(`\n  DRY RUN — set CONFIRM=yes to actually create the pool.\n`);
    return;
  }

  if (IS_MAINNET) {
    // This is the single most expensive irreversible step in the launch and the one whose
    // parameters get frozen into a pool nobody can withdraw from afterwards. Restate them
    // where they cannot be scrolled past.
    console.log(
      `\n  ############ MAINNET ############\n` +
      `  Creating a REAL pool with REAL money. The LP is burned immediately after, which\n` +
      `  makes the seed unrecoverable by anyone including you — that is the point.\n` +
      `    seed        ${SOL_AMOUNT} SOL + ${fmt(ardRaw, info.decimals)} ARD\n` +
      `    amm_config  index ${feeConfig.index} (${(Number(feeConfig.tradeFeeRate) / 10000).toFixed(2)}% trade fee)\n` +
      `    open_time   ${new Date(openAt * 1000).toISOString()}\n` +
      `  Ctrl-C now if any line above is not what you published.\n`,
    );
  }

  console.log(`\n  creating pool...`);
  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId,
    poolFeeAccount,
    mintA: {
      address: mintAddr.toBase58(),
      decimals: info.decimals,
      programId: TOKEN_2022_PROGRAM_ID.toBase58(),
    },
    mintB: {
      address: WSOL.toBase58(),
      decimals: 9,
      programId: TOKEN_PROGRAM_ID.toBase58(),
    },
    mintAAmount: new BN(ardRaw.toString()),
    mintBAmount: new BN(solRaw.toString()),
    startTime: new BN(openAt),
    feeConfig,
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  });

  const { txId } = await execute({ sendAndConfirm: true });
  const addrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(extInfo.address)) addrs[k] = String(v);

  console.log(`\n  pool created: ${explorer(txId, "tx")}`);
  for (const [k, v] of Object.entries(addrs)) console.log(`  ${k.padEnd(22)} ${v}`);

  const out = path.join(process.cwd(), `pool.${CLUSTER}.json`);
  fs.writeFileSync(out, JSON.stringify({
    cluster: CLUSTER, mint: mintAddr.toBase58(), txId, openAt,
    openAtIso: new Date(openAt * 1000).toISOString(),
    seededArdRaw: ardRaw.toString(), ardCreditedRaw: ardCredited.toString(),
    seededSolRaw: solRaw.toString(), feeBps: bps,
    ammConfigIndex: feeConfig.index, ammConfigId: feeConfig.id,
    tradeFeeRate: feeConfig.tradeFeeRate, creatorFeeRate: feeConfig.creatorFeeRate,
    cpmmProgram: programId.toBase58(),
    ...addrs,
  }, null, 2));
  console.log(`\n  wrote ${out}`);
  console.log(`\n  NEXT: burn the LP, then verify trading is blocked until ${new Date(openAt * 1000).toISOString()}\n`);
}

main().catch((e) => { console.error(`\n${(e as Error).message}\n`); process.exitCode = 1; });
