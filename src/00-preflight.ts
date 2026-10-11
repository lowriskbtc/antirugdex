/**
 * Validates .env before you spend anything. Run this before `npm run create`.
 *
 * The check that matters most: TREASURY_PUBKEY must match the keypair in
 * WITHHELD_AUTHORITY_KEYPAIR. That pubkey becomes withdrawWithheldAuthority at
 * mint creation and can never be changed — a mismatch means every fee you ever
 * collect is stranded, and no later script can repair it.
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN } from "./config.js";
import {
  connection, loadKeypair, loadKeypairFromPath, assertUriServesJson,
  assertClusterMatchesRpc, classifyUri, envForCluster, CLUSTER, IS_MAINNET,
} from "./lib.js";

let fail = 0, warn = 0;
const ok = (m: string) => console.log(`  PASS  ${m}`);
const bad = (m: string) => { console.log(`  FAIL  ${m}`); fail++; };
const meh = (m: string) => { console.log(`  WARN  ${m}`); warn++; };

console.log(`\n=== preflight: ${TOKEN.symbol} on ${CLUSTER} ===\n`);

// ---- env hygiene ---------------------------------------------------------
const rpc = envForCluster("RPC_URL") ?? "";
if (/YOUR_KEY|<|>/.test(rpc)) bad(`RPC_URL still contains a placeholder: ${rpc}`);
else if (IS_MAINNET && rpc.includes("api.mainnet-beta.solana.com"))
  meh(`RPC_URL is the public endpoint — it will rate-limit you out of your own launch`);
else if (!rpc) meh(`RPC_URL unset, falling back to a public endpoint`);
else ok(`RPC_URL set`);

// The endpoint must actually be on the cluster we claim. Genesis hash is the
// only unspoofable identifier — a URL string proves nothing, and CLUSTER=devnet
// is what disables mainnetGuard, so a mismatch here is the dangerous direction.
try {
  await assertClusterMatchesRpc();
  ok(`RPC endpoint is genuinely on ${CLUSTER} (genesis hash verified)`);
} catch (e) {
  bad((e as Error).message.split("\n")[0] + ` — see below`);
  console.log((e as Error).message.split("\n").slice(1).join("\n"));
}

// ---- deployer ------------------------------------------------------------
let deployer;
try {
  deployer = loadKeypair("DEPLOYER_KEYPAIR");
  ok(`deployer keypair loads: ${deployer.publicKey.toBase58()}`);
} catch (e) {
  bad((e as Error).message);
}

// ---- treasury / withdraw authority --------------------------------------
const treasuryRaw = (envForCluster("TREASURY_PUBKEY") ?? "").trim();
let treasury: PublicKey | null = null;

if (!treasuryRaw) {
  meh(`TREASURY_PUBKEY unset — fees will be collectable only by the deployer key`);
  if (deployer) treasury = deployer.publicKey;
} else if (/[<>]/.test(treasuryRaw)) {
  bad(`TREASURY_PUBKEY still has angle brackets: ${treasuryRaw}`);
} else {
  try {
    treasury = new PublicKey(treasuryRaw);
    ok(`TREASURY_PUBKEY is a valid address: ${treasury.toBase58()}`);
  } catch {
    bad(`TREASURY_PUBKEY is not a valid base58 address: ${treasuryRaw}`);
  }
}

const authPath = envForCluster("WITHHELD_AUTHORITY_KEYPAIR");
if (authPath && treasury) {
  try {
    const authKp = loadKeypairFromPath(authPath, "WITHHELD_AUTHORITY_KEYPAIR");
    if (authKp.publicKey.equals(treasury)) {
      ok(`withdraw authority keypair matches TREASURY_PUBKEY`);
    } else {
      bad(
        `MISMATCH — TREASURY_PUBKEY is ${treasury.toBase58()} but\n` +
        `        ${authPath} holds ${authKp.publicKey.toBase58()}.\n` +
        `        Creating the mint like this strands every fee permanently.`,
      );
    }
  } catch (e) {
    bad((e as Error).message);
  }
} else if (treasury && deployer && !treasury.equals(deployer.publicKey)) {
  bad(`TREASURY_PUBKEY differs from the deployer but WITHHELD_AUTHORITY_KEYPAIR is unset — you could never withdraw fees.`);
}

if (treasury && deployer && treasury.equals(deployer.publicKey) && IS_MAINNET)
  meh(`treasury == deployer: one hot key controls deployment AND all fee revenue`);

// ---- metadata URI --------------------------------------------------------
try {
  await assertUriServesJson(TOKEN.uri);
  ok(`metadata URI serves valid JSON: ${TOKEN.uri}`);
} catch (e) {
  bad((e as Error).message.split("\n")[0]);
}

// Serving valid JSON is not the same as being immutable, and the check above cannot tell
// them apart — a rented domain passes it every time. Revoking the metadata authority
// locks the POINTER, not the CONTENT, so an HTTPS URI leaves whoever holds that domain in
// control of what every wallet displays, forever. Same rule as grade.ts, imported rather
// than restated so the two cannot drift.
const uriClass = classifyUri(TOKEN.uri);
if (uriClass.ok) ok(`metadata URI is immutable: ${uriClass.kind}`);
else
  meh(
    `metadata URI is NOT content-addressed — ${uriClass.kind}.\n` +
    `        It serves JSON today, which is why the check above passed. That says\n` +
    `        nothing about tomorrow: revoking the metadata authority locks the pointer,\n` +
    `        not the content. Move it to Arweave or IPFS before minting on mainnet.`,
  );

// ---- chain ---------------------------------------------------------------
//
// TWO balance questions, deliberately separate rows.
//
//   1. "will the mint transaction succeed" — a 0.03 SOL threshold. That is this script's
//      original contract and it is a real question.
//   2. "can you finish the launch" — everything from the program deploy to the pool seed.
//
// Conflating them is how the deployer's 0.0567 SOL printed PASS / `Ready to mint` while
// being ~4.6 SOL short of what the launch actually consumes. Running out between opening
// the sale and proving the pool is the worst case in the whole sequence: bidders' money is
// in the vault and the only honest exit is fail-on-missing-pool plus refunds.
// Each line carries `spent()` — "has this already been paid for?" A budget row that keeps
// demanding SOL you correctly spent is worse than no row at all: it would FAIL at exactly
// the moment you are about to mint, having just deployed the program, and tell you to top
// up 2.5 SOL that is sitting in ProgramData rent. Same reason the deploy check runs FIRST.
//
// This budget answers "can you START the launch", not "where are you in it". Only the
// program deploy clears itself; once you are past launch step 7 the `pool seed` line still
// asks for 2 SOL you have already committed to the pool, so a FAIL from here mid-launch is
// not evidence of a real shortfall. Run it before step 0b and believe it; after that, the
// runbook in NEXT-SESSION.md is the authority on what is still owed.
interface BudgetLine {
  item: string;
  sol: number;
  note: string;
  spent?: () => boolean;
}

// The sale program is deployed to DEVNET only, and it was built with `--features devnet`,
// which swaps in the devnet Raydium CPMM id. A mainnet launch needs its own build and its
// own deploy — there was no step for it anywhere in the runbook, which is why its ~2.5 SOL
// was missing from every funding figure ever written for this project. This row exists so
// the gap is loud rather than discovered at launch step 4 with a mint already frozen.
let programDeployed = false;
if (IS_MAINNET) {
  try {
    const conn = connection();
    const { programId } = await import("./sale-client.js");
    const pid = programId();
    const info = await conn.getAccountInfo(pid);
    programDeployed = info?.executable === true;
    if (programDeployed) ok(`sale program is deployed on mainnet: ${pid.toBase58()}`);
    else
      bad(
        `sale program ${pid.toBase58()} is NOT deployed on mainnet.\n` +
        `        11-sale-init.ts and every settlement script would fail. It must be rebuilt\n` +
        `        WITHOUT --features devnet (a devnet build carries the devnet Raydium CPMM id\n` +
        `        and would reject the real pool) and deployed with the same program keypair.`,
      );
  } catch (e) {
    meh(`could not check the mainnet sale program: ${(e as Error).message.split("\n")[0]}`);
  }
}

const LAUNCH_BUDGET: BudgetLine[] = [
  { item: "sale program deploy", sol: 2.50, note: "357,992-byte artifact; devnet cost 2.49", spent: () => programDeployed },
  { item: "mint creation rent",  sol: 0.0051, note: "measured on devnet under the Arweave URI" },
  { item: "sale account rents",  sol: 0.006278, note: "MEASURED — Sale PDA 336B + sol_vault 0B + token vault 182B, identical across three settled devnet sales (npx tsx src/_launch-rent.ts)" },
  { item: "Raydium create fee",  sol: 0.15,   note: "verified against Raydium's mainnet CPMM configs 2026-08-11" },
  { item: "pool account rents",  sol: 0.040208, note: "MEASURED off the devnet pool — the 4,075-byte observation account is 0.0293 of it (npx tsx src/_launch-rent.ts)" },
  { item: "pool seed",           sol: 2.00,   note: "fronted by you; sweep_proceeds only reimburses AFTER the pool is proven" },
  { item: "tx fees + priority",  sol: 0.01,   note: "the one irreducible estimate here — priority fees depend on congestion on the day" },
];

if (deployer) {
  try {
    const conn = connection();
    const bal = await conn.getBalance(deployer.publicKey);
    const sol = bal / 1e9;
    const need = IS_MAINNET ? 0.03 : 0.02;
    if (sol >= need) ok(`deployer balance: ${sol.toFixed(4)} SOL (enough for the mint transaction)`);
    else bad(`deployer balance ${sol.toFixed(4)} SOL — needs at least ${need} SOL`);

    if (IS_MAINNET) {
      const remaining = LAUNCH_BUDGET.filter((b) => !b.spent?.());
      const total = remaining.reduce((a, b) => a + b.sol, 0);
      const show = () => {
        for (const b of LAUNCH_BUDGET) {
          const done = b.spent?.() ?? false;
          console.log(
            `          ${done ? "    —     " : `${b.sol.toFixed(4)} SOL`}  ${b.item}` +
            `${done ? "  — already done, excluded" : b.note ? `  — ${b.note}` : ""}`,
          );
        }
      };
      if (sol >= total) {
        ok(`deployer covers the rest of the launch: ${sol.toFixed(4)} of ${total.toFixed(4)} SOL still needed`);
      } else {
        bad(
          `deployer cannot finish the launch — ${sol.toFixed(4)} SOL against ${total.toFixed(4)} still needed\n` +
          `        (short by ${(total - sol).toFixed(4)} SOL). Breakdown:`,
        );
        show();
        console.log(
          `        Fund the deployer BEFORE the program deploy, not before creating the pool.\n` +
          `        Running dry between opening the sale and proving the pool leaves bidders'\n` +
          `        SOL in the vault with refunds as the only exit.`,
        );
      }
    }
  } catch (e) {
    bad(`could not reach RPC: ${(e as Error).message.slice(0, 90)}`);
  }
}

// ---- verdict -------------------------------------------------------------
//
// "Ready" has a narrow meaning and it has been misread before. This script answers "will
// the mint transaction succeed", not "is this a configuration we want frozen forever".
// Those differ most exactly where it matters: a rented-domain metadata URI passes every
// check here and is still the one thing blocking mainnet. `grade.ts` answers the second
// question, so on mainnet the verdict points at it rather than implying a green light.
console.log(
  `\n${fail === 0
    ? `Mint transaction will go through${warn ? ` — but ${warn} warning${warn > 1 ? "s" : ""} above` : ""}. ` +
      `Next: ${IS_MAINNET ? `$env:CONFIRM = 'yes'; npm run create` : `npm run create`}`
    : `${fail} blocking problem${fail > 1 ? "s" : ""} — fix before spending anything.`}\n`,
);
if (fail === 0 && IS_MAINNET)
  console.log(
    `  That is all this says. It is NOT "the configuration is safe to freeze" — run the\n` +
    `  grader for that, and it is the actual gate:\n` +
    `      npx tsx src/grade.ts <mint>\n`,
  );
if (fail > 0) process.exitCode = 1;
