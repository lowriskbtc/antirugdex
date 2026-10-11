/**
 * Proves the pool on chain — the one remaining step with a hard deadline.
 *
 *   npx tsx src/14-mark-pool.ts                     # decode + simulate, send nothing
 *   $env:CONFIRM='yes'; npx tsx src/14-mark-pool.ts
 *   ... POOL_ID=<pubkey>                            # override the pool being marked
 *
 * ## Why this is the deadline that matters
 *
 * `mark_pool_created` requires `now < pool_deadline`. Everything after it — sweep, claim,
 * burn — has no deadline at all, and once `pool_created` is true `fail_on_missing_pool` is
 * permanently blocked (it requires `!pool_created`). So the whole clock on this launch is
 * finalize -> this. After this lands, the rehearsal can take as long as it likes.
 *
 * ## Every fact is decoded from the pool account, not from pool.<cluster>.json
 *
 * The JSON file is used for exactly one thing: which pubkey to look at. Its `lpMint` is
 * compared against the mint decoded out of the pool's own bytes and disagreement is fatal —
 * "read chain, never config" applies hardest to the account whose whole job is to be the
 * evidence.
 *
 * ## It always simulates first
 *
 * The program pins the CPMM owner to a `#[cfg(feature = "devnet")]` constant, and this
 * project has already been bitten once by a devnet-vs-default build being deployed where
 * the other was expected. The IDL cannot settle which binary is on chain — it is generated
 * from a build, not read from the cluster. Simulation asks the deployed program directly,
 * costs nothing, and names the exact `SaleError` instead of leaving a failed send to be
 * interpreted.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import {
  assertClusterMatchesRpc,
  CLUSTER,
  connection,
  explorer,
  loadKeypair,
  mainnetGuard,
  readMint,
  send,
} from "./lib.js";
import { buildIx, errorName, fetchSale, idlConstant, salePda } from "./sale-client.js";

// Byte offsets into Raydium's `PoolState`. These are NOT in the IDL — they are plain
// `pub const`s in constants.rs, not `#[constant]`, because they describe someone else's
// account. Mirrored here deliberately; the decode below is checked against the program's
// own reading of the same bytes by the simulation, which is what makes the mirror safe.
const POOL_STATE_LEN = 637;
const POOL_STATE_DISCRIMINATOR = Buffer.from([0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46]);
const OFF_POOL_CREATOR = 40;
const OFF_LP_MINT = 136;
const OFF_TOKEN_0_MINT = 168;
const OFF_TOKEN_1_MINT = 200;
const OFF_OPEN_TIME = 373;

function pk(data: Buffer, off: number): PublicKey {
  return new PublicKey(data.subarray(off, off + 32));
}

/** Pulls the program error code out of a simulation result, if there is one. */
function customCode(err: unknown): number | undefined {
  const ie = (err as { InstructionError?: [number, unknown] })?.InstructionError;
  const custom = (ie?.[1] as { Custom?: number })?.Custom;
  return typeof custom === "number" ? custom : undefined;
}

async function main() {
  await assertClusterMatchesRpc();
  mainnetGuard("mark a pool as created");
  const conn = connection();

  const mint = new PublicKey(readMint().mint);
  const [sale] = salePda(mint);

  const s = await fetchSale(conn, sale);
  if (!s) throw new Error(`No sale at ${sale.toBase58()}`);

  const poolFile = path.join(process.cwd(), `pool.${CLUSTER}.json`);
  let poolId = process.env.POOL_ID;
  let recordedLpMint: string | undefined;
  if (!poolId) {
    if (!fs.existsSync(poolFile))
      throw new Error(`No ${poolFile} and no POOL_ID set — nothing to mark.`);
    const j = JSON.parse(fs.readFileSync(poolFile, "utf8"));
    poolId = j.poolId as string;
    recordedLpMint = j.lpMint as string;
  }
  const pool = new PublicKey(poolId!);

  const info = await conn.getAccountInfo(pool);
  if (!info) throw new Error(`Pool ${pool.toBase58()} does not exist on ${CLUSTER}.`);

  console.log(`\nMark pool created — ${CLUSTER}`);
  console.log(`  sale        : ${sale.toBase58()}  (${s.status})`);
  console.log(`  pool        : ${pool.toBase58()}  ${explorer(pool)}`);

  // ---- the five things the handler checks, decoded here so a failure is readable ----
  const expectedOwner = new PublicKey(idlConstant("RAYDIUM_CPMM_PROGRAM"));
  const data = info.data;
  const creator = data.length >= POOL_STATE_LEN ? pk(data, OFF_POOL_CREATOR) : undefined;
  const lpMint = data.length >= POOL_STATE_LEN ? pk(data, OFF_LP_MINT) : undefined;
  const token0 = data.length >= POOL_STATE_LEN ? pk(data, OFF_TOKEN_0_MINT) : undefined;
  const token1 = data.length >= POOL_STATE_LEN ? pk(data, OFF_TOKEN_1_MINT) : undefined;
  const openTime =
    data.length >= POOL_STATE_LEN ? data.readBigUInt64LE(OFF_OPEN_TIME) : 0n;

  const lpSupply = lpMint
    ? BigInt((await conn.getTokenSupply(lpMint)).value.amount)
    : undefined;

  const ok = (b: boolean) => (b ? "ok  " : "FAIL");
  console.log(`\n  DECODED FROM THE POOL ACCOUNT — the handler reads these same bytes`);
  console.log(`  ${ok(info.owner.equals(expectedOwner))} owner        : ${info.owner.toBase58()}`);
  console.log(`       expected     : ${expectedOwner.toBase58()}  (IDL RAYDIUM_CPMM_PROGRAM)`);
  console.log(`  ${ok(data.length === POOL_STATE_LEN)} length       : ${data.length}  (expected ${POOL_STATE_LEN})`);
  console.log(`  ${ok(data.subarray(0, 8).equals(POOL_STATE_DISCRIMINATOR))} discriminator: ${data.subarray(0, 8).toString("hex")}`);
  console.log(`  ${ok(!!creator && creator.equals(s.authority))} pool_creator : ${creator?.toBase58()}`);
  console.log(`       sale.authority: ${s.authority.toBase58()}`);
  console.log(`  ${ok(!!token0 && !!token1 && (token0.equals(mint) || token1.equals(mint)))} mint pair    : token_0 ${token0?.toBase58()}`);
  console.log(`                       token_1 ${token1?.toBase58()}`);
  console.log(`       sale token   : ${mint.toBase58()}`);
  console.log(`  ${ok(lpSupply === 0n)} lp_mint      : ${lpMint?.toBase58()}   supply ${lpSupply}`);
  console.log(`  ${ok(openTime <= BigInt(s.pool_deadline))} open_time    : ${new Date(Number(openTime) * 1000).toISOString()}`);
  console.log(`       pool_deadline: ${new Date(Number(s.pool_deadline) * 1000).toISOString()}`);
  console.log(
    `       claims open  : ${openTime <= BigInt(Math.floor(Date.now() / 1000)) ? "immediately — open_time is already past" : "when open_time arrives"}`,
  );

  // The recorded file is evidence about the pool, so it has to agree with the pool.
  if (recordedLpMint && lpMint && recordedLpMint !== lpMint.toBase58())
    throw new Error(
      `${poolFile} records lpMint ${recordedLpMint} but the pool account says ` +
        `${lpMint.toBase58()}.\n  The file is describing a different pool. Refusing to mark.`,
    );
  if (!lpMint) throw new Error("Pool account is too short to decode — not a PoolState.");

  const now = Math.floor(Date.now() / 1000);
  const secondsLeft = Number(s.pool_deadline) - now;
  console.log(`\n  pool deadline in : ${secondsLeft}s  (${(secondsLeft / 60).toFixed(1)} min)`);
  if (s.pool_created) throw new Error(`Already marked: pool ${s.pool.toBase58()}.`);
  if (s.status !== "Succeeded")
    throw new Error(`Sale is ${s.status} — mark_pool_created requires Succeeded. Finalize first.`);
  if (secondsLeft <= 0)
    throw new Error("Pool deadline has passed — PoolDeadlinePassed. The refund path owns this now.");

  const payer = loadKeypair("DEPLOYER_KEYPAIR");
  const ix = buildIx("mark_pool_created", { sale, pool, lp_mint: lpMint });
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ix];

  // ---- simulate against the DEPLOYED program, always ----
  const tx = new Transaction().add(...ixs);
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  const sim = await conn.simulateTransaction(tx, [payer]);
  if (sim.value.err) {
    const code = customCode(sim.value.err);
    console.error(`\n  SIMULATION FAILED — nothing was sent.`);
    console.error(`  error : ${JSON.stringify(sim.value.err)}`);
    if (code !== undefined)
      console.error(`  which is: ${errorName(code) ?? `unknown code ${code}`}`);
    console.error(`  logs  :\n${(sim.value.logs ?? []).map((l) => `    ${l}`).join("\n")}`);
    if (errorName(code ?? -1) === "PoolWrongOwner")
      console.error(
        `\n  PoolWrongOwner means the DEPLOYED binary was built without --features devnet,\n` +
          `  so it is pinned to the mainnet CPMM id. The fix is a devnet rebuild + redeploy\n` +
          `  (anchor-build-devnet.sh), not a new pool.`,
      );
    process.exit(1);
  }
  console.log(`\n  simulation OK against the deployed program.`);
  console.log(`  units consumed : ${sim.value.unitsConsumed}`);

  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — simulated only, nothing sent. Re-run with CONFIRM=yes.\n`);
    return;
  }

  console.log(`\n-> mark_pool_created (fee paid by ${payer.publicKey.toBase58()})`);
  await send(conn, ixs, [payer], "mark_pool_created");

  const after = await fetchSale(conn, sale);
  console.log(`\n  pool_created   : ${after!.pool_created}`);
  console.log(`  pool           : ${after!.pool.toBase58()}`);
  console.log(`  pool_open_time : ${new Date(Number(after!.pool_open_time) * 1000).toISOString()}`);
  console.log(`\n  fail_on_missing_pool is now permanently blocked. The clock is off.\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
