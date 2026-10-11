import {
  Connection,
  Keypair,
  PublicKey,
  Signer,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import "dotenv/config";

export const CLUSTER = (process.env.CLUSTER ?? "devnet") as "devnet" | "mainnet";
export const IS_MAINNET = CLUSTER === "mainnet";

/**
 * Reads `<NAME>_DEVNET` / `<NAME>_MAINNET` first, then plain `<NAME>`.
 *
 * Added 2026-08-06. Every cluster-varying setting goes through this so that
 * flipping CLUSTER flips ALL of them together. The bug it prevents: a .env
 * configured for mainnet handing mainnet keys and a mainnet RPC to a run that
 * every log line called "devnet" — while CLUSTER=devnet simultaneously
 * disabled mainnetGuard.
 */
export function envForCluster(name: string): string | undefined {
  return process.env[`${name}_${CLUSTER.toUpperCase()}`] ?? process.env[name];
}

export function connection(): Connection {
  const url =
    envForCluster("RPC_URL") ??
    (IS_MAINNET
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com");
  if (IS_MAINNET && url.includes("api.mainnet-beta.solana.com")) {
    console.warn(
      "!  Using the public mainnet RPC. It rate-limits hard and will drop your\n" +
        "!  mint transaction at the worst moment. Set RPC_URL to a Helius/Triton\n" +
        "!  endpoint before running anything that costs money.\n",
    );
  }
  return new Connection(url, "confirmed");
}

/** Loads a `solana-keygen` JSON keypair file by path. */
export function loadKeypairFromPath(p: string, label = p): Keypair {
  const resolved = p.startsWith("~")
    ? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", p.slice(1))
    : p;
  if (!fs.existsSync(resolved))
    throw new Error(`${label} points at a file that does not exist: ${resolved}`);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Loads a `solana-keygen` JSON keypair file named by an env var.
 *
 * CLUSTER-AWARE since 2026-08-06. Prefers `<VAR>_DEVNET` / `<VAR>_MAINNET`
 * and only falls back to the bare `<VAR>`.
 *
 * Why: this used to read one bare env var regardless of cluster, so a .env
 * configured for mainnet handed the MAINNET deployer keypair to a run that
 * every log line called "devnet". Cluster and identity must not be able to
 * disagree — see assertClusterMatchesRpc for the other half.
 */
export function loadKeypair(envVar: string): Keypair {
  const suffixed = `${envVar}_${CLUSTER.toUpperCase()}`;
  const p = process.env[suffixed] ?? process.env[envVar];
  if (!p)
    throw new Error(
      `Neither ${suffixed} nor ${envVar} is set in .env (CLUSTER=${CLUSTER})`,
    );
  if (!process.env[suffixed]) {
    console.warn(
      `!  ${suffixed} not set — falling back to ${envVar} on ${CLUSTER}.\n` +
        `!  Add ${suffixed} to .env so the cluster picks the keypair.`,
    );
  }
  return loadKeypairFromPath(p, process.env[suffixed] ? suffixed : envVar);
}

/** Genesis hashes are the only unspoofable identifier of which chain you are on. */
const GENESIS: Record<string, string> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

/**
 * Confirms the RPC endpoint is actually on the cluster we think it is.
 *
 * RPC_URL overrides the cluster default unconditionally, so a mainnet
 * endpoint plus CLUSTER=devnet silently produced "devnet" logs against
 * mainnet — AND disabled mainnetGuard, which keys off CLUSTER. A URL string
 * check is not enough (endpoints are arbitrary); the genesis hash is the
 * ground truth.
 */
export async function assertClusterMatchesRpc(): Promise<void> {
  const expected = GENESIS[CLUSTER];
  if (!expected) return;
  const actual = await connection().getGenesisHash();
  if (actual !== expected) {
    const onChain =
      Object.entries(GENESIS).find(([, h]) => h === actual)?.[0] ?? "an unknown chain";
    throw new Error(
      `CLUSTER/RPC MISMATCH — refusing to continue.\n` +
        `  CLUSTER says:  ${CLUSTER}\n` +
        `  RPC is on:     ${onChain} (genesis ${actual})\n` +
        `  Set RPC_URL to a ${CLUSTER} endpoint, or fix CLUSTER.\n` +
        `  This check exists because CLUSTER=devnet also disables mainnetGuard.`,
    );
  }
}

/**
 * Confirms a metadata URI actually serves JSON before it is baked into a mint.
 *
 * A parked domain returns HTTP 200 with an HTML lander, so status-code checks
 * pass while wallets show a broken token. antirugdex.com did exactly this
 * during development. Checks the body, not the status.
 */
export async function assertUriServesJson(uri: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(uri, { redirect: "follow" });
  } catch (e) {
    throw new Error(`Metadata URI unreachable: ${uri}\n  ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`Metadata URI returned HTTP ${res.status}: ${uri}`);

  const body = await res.text();
  const ct = res.headers.get("content-type") ?? "(none)";
  if (body.trimStart().startsWith("<")) {
    throw new Error(
      `Metadata URI serves HTML, not JSON: ${uri}\n` +
        `  content-type: ${ct}\n` +
        `  body starts:  ${body.trimStart().slice(0, 80)}\n` +
        `  This is almost certainly a parked-domain or SPA fallback page. It\n` +
        `  returns HTTP 200, so a status check would have passed. Upload\n` +
        `  metadata.json before creating the mint — the URI is immutable once\n` +
        `  you revoke the metadata update authority.`,
    );
  }
  try {
    JSON.parse(body);
  } catch {
    throw new Error(`Metadata URI is not valid JSON: ${uri}\n  content-type: ${ct}`);
  }
}

/**
 * A content-addressed URI cannot be changed by anyone, ever. An HTTPS URI is only as
 * immutable as the domain registration — revoking the metadata authority locks the
 * POINTER, not the CONTENT. No other grader checks this.
 *
 * Lives here rather than in `grade.ts` because `00-preflight.ts` needs the same rule and
 * `grade.ts` runs its `main()` on import. Two tools disagreeing about what counts as
 * content-addressed is precisely the failure this check exists to prevent.
 */
// Defined in grade-core.ts and RE-EXPORTED here, not copied. grade-core.ts is the module
// with no environment access, so it is the one the browser bundle can import; lib.ts cannot
// be (it reads process.env at module load). Both 00-preflight.ts and the grader must apply
// the identical URI rule — a second copy here is exactly how they would stop doing that.
export { classifyUri, fmt } from "./grade-core.js";

/** Where the mint address is recorded after 01 runs, so 02-05 can find it. */
export const MINT_FILE = path.join(process.cwd(), `mint.${CLUSTER}.json`);

/**
 * Where an existing MINT_FILE would be rolled to, or null if there isn't one.
 *
 * Separate from saveMint so 01's dry run can PRINT the roll target without
 * performing the roll. Returns the lowest UNUSED runN, so rolling can never
 * land on — and destroy — a record an earlier roll preserved.
 */
export function nextMintRollPath(): string | null {
  if (!fs.existsSync(MINT_FILE)) return null;
  for (let n = 1; ; n++) {
    const p = path.join(process.cwd(), `mint.${CLUSTER}.run${n}.json`);
    if (!fs.existsSync(p)) return p;
  }
}

/**
 * Records the mint, rolling any existing record aside first.
 *
 * This used to writeFileSync unconditionally. Every run of 01 creates a NEW
 * address, so that overwrite destroyed the only record of the previous run —
 * including its withdrawWithheldAuthority, which is fixed at mint creation and
 * recoverable from nowhere else. It happened for real on 2026-08-09;
 * mint.devnet.run1/run2.json survive only because they were moved by hand.
 */
export function saveMint(data: Record<string, unknown>) {
  const json = JSON.stringify(data, null, 2);
  const rolled = nextMintRollPath();
  if (rolled) {
    try {
      fs.renameSync(MINT_FILE, rolled);
      console.log(`   previous record rolled to ${path.basename(rolled)}`);
    } catch (e) {
      // Callers reach here only AFTER the mint exists on chain, so failing
      // bare would leave the new record nowhere at all — the same loss this
      // function exists to prevent, one run later. Carry it in the message.
      throw new Error(
        `Could not roll ${MINT_FILE} aside to ${rolled}:\n  ${(e as Error).message}\n` +
          `  The mint was ALREADY CREATED. Move that file yourself and save this:\n${json}`,
      );
    }
  }
  fs.writeFileSync(MINT_FILE, json);
}

export function readMint(): { mint: string; [k: string]: unknown } {
  if (!fs.existsSync(MINT_FILE))
    throw new Error(`No ${MINT_FILE}. Run 01-create-mint.ts first.`);
  return JSON.parse(fs.readFileSync(MINT_FILE, "utf8"));
}

export async function send(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Signer[],
  label: string,
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`   ${label}: ${explorer(sig, "tx")}`);
  return sig;
}

export function explorer(id: string | PublicKey, kind: "tx" | "address" = "address"): string {
  const suffix = IS_MAINNET ? "" : `?cluster=${CLUSTER}`;
  return `https://solscan.io/${kind}/${id.toString()}${suffix}`;
}

// `fmt` is re-exported from grade-core.js at the top of this file, alongside classifyUri.

/** Refuses to continue on mainnet unless CONFIRM=yes is set. */
export function mainnetGuard(action: string) {
  // Belt and braces: if RPC_URL points at mainnet, demand CONFIRM even when
  // CLUSTER claims devnet. Without this, setting CLUSTER=devnet — the thing
  // that FEELS safe — is what switches the guard off.
  const rpc = envForCluster("RPC_URL") ?? "";
  const rpcLooksMainnet =
    /mainnet/i.test(rpc) || (rpc !== "" && !/devnet|testnet|localhost|127\.0\.0\.1/i.test(rpc));
  if (!IS_MAINNET && rpcLooksMainnet && process.env.CONFIRM !== "yes") {
    console.error(
      `\nREFUSING: CLUSTER=${CLUSTER} but RPC_URL does not look like devnet.\n` +
        `  RPC_URL=${rpc}\n` +
        `  This would ${action} against whatever chain that endpoint serves.\n` +
        `  Point RPC_URL at devnet, or set CONFIRM=yes if you really mean it.\n`,
    );
    process.exit(1);
  }
  if (IS_MAINNET && process.env.CONFIRM !== "yes") {
    console.error(
      `\nREFUSING: this would ${action} on MAINNET with real SOL.\n` +
        `If that is what you want, re-run with CONFIRM=yes in the environment.\n`,
    );
    process.exit(1);
  }
}
