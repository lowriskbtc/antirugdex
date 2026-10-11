/**
 * Browser entry for the devnet launcher. Bundled to site/launcher.js by `npm run build:web`.
 *
 * It builds NO instructions of its own — everything comes from src/mint-core.ts, the module
 * 01-create-mint.ts also uses, so a token launched here is byte-identical to one launched
 * from the CLI. Most of what a mint deploys is frozen at creation and
 * `withdrawWithheldAuthority` can never be changed by any instruction, so two
 * implementations would mean two ways to permanently strand a token's fees.
 *
 * 🔴 DEVNET ONLY, ENFORCED BY GENESIS HASH — not by a dropdown, a hostname, or a boolean.
 *
 * This session proved twice over that a cluster selector is a claim rather than a fact: a
 * custom RPC silently overrode the grader's selector, and before that a `.env` handed
 * mainnet keys to runs every log line called devnet. In a *grader* that produces a
 * mislabelled report. In a *launcher* it produces an irreversible mainnet mint with
 * `withdrawWithheldAuthority` frozen to whatever happened to be in the form. So the check
 * runs before anything is built AND again immediately before each send — the endpoint can
 * change between page load and click, because the user can edit the field.
 *
 * The CLI has three independent layers here (`mainnetGuard`, `CONFIRM=yes`, and a
 * cluster-suffixed `.env`). A browser has none of them, so the genesis check carries the
 * whole weight and is deliberately paranoid.
 */
import {
  Connection, Keypair, PublicKey, Transaction, type TransactionInstruction,
} from "@solana/web3.js";
import {
  planMint, buildMintTxs, validateMintParams, UNCAPPED_FEE, type MintParams,
} from "../src/mint-core.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEFAULT_RPC = "https://api.devnet.solana.com";
const RPC_KEY = "antirugdex.rpc";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Minimal injected-wallet shape. Avoids pulling React + wallet-adapter into a static page. */
interface InjectedWallet {
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}
function getWallet(): InjectedWallet | null {
  const w = window as unknown as { phantom?: { solana?: InjectedWallet }; solana?: InjectedWallet };
  return w.phantom?.solana ?? w.solana ?? null;
}

let wallet: InjectedWallet | null = null;
let walletPubkey: PublicKey | null = null;

/**
 * Fingerprint of the form at the moment a preview succeeded.
 *
 * Two jobs. It enforces preview-before-create *without disabling the button* — a disabled
 * button swallows clicks silently and reads as broken, which is exactly how this was
 * reported on 2026-08-11. And it invalidates when any field changes, so you cannot preview
 * one token and create a different one; the treasury in particular is frozen at creation, so
 * "the plan I read" and "the transaction I signed" have to be the same thing.
 */
let previewedFingerprint: string | null = null;

function setStatus(msg: string, kind: "" | "err" | "ok" = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = kind;
}

function log(html: string) {
  const el = $("log");
  el.insertAdjacentHTML("beforeend", `<div class="step">${html}</div>`);
  el.scrollTop = el.scrollHeight;
}

const esc = (x: string) =>
  x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function rpcUrl(): string {
  return ($<HTMLInputElement>("rpc").value || "").trim() || DEFAULT_RPC;
}

/**
 * The load-bearing check. Throws unless the endpoint is genuinely devnet.
 * Called before building and again before every send.
 */
async function assertDevnet(conn: Connection): Promise<void> {
  const actual = await conn.getGenesisHash();
  if (actual === DEVNET_GENESIS) return;
  throw new Error(
    `REFUSING: that endpoint is not devnet (genesis ${actual.slice(0, 12)}…). ` +
      `This launcher is devnet-only. A mint is irreversible and its ` +
      `withdrawWithheldAuthority can never be changed, so it will not build a transaction ` +
      `against any other chain.`,
  );
}

function readForm(): { params: Omit<MintParams, "payer" | "treasury">; treasuryRaw: string } {
  const uncapped = $<HTMLInputElement>("uncapped").checked;
  return {
    treasuryRaw: $<HTMLInputElement>("treasury").value.trim(),
    params: {
      name: $<HTMLInputElement>("name").value.trim(),
      symbol: $<HTMLInputElement>("symbol").value.trim(),
      uri: $<HTMLInputElement>("uri").value.trim(),
      decimals: Number($<HTMLInputElement>("decimals").value),
      totalSupply: BigInt($<HTMLInputElement>("supply").value.replace(/[^0-9]/g, "") || "0"),
      feeBasisPoints: Number($<HTMLInputElement>("fee").value),
      maximumFee: uncapped ? UNCAPPED_FEE : BigInt($<HTMLInputElement>("maxfee").value || "0"),
      additionalMetadata: [],
      // Reserve rent headroom for the pair 05-lock-down.ts writes later. Without it, a
      // future lock breaks rent-exemption and fails, taking the fee-authority revoke with
      // it. Costs ~0.0002 SOL now and cannot be added afterwards.
      postLockMetadata: [["fee_authority", "revoked"]],
    },
  };
}

/** Everything that must not change between reading the plan and signing it. */
function formFingerprint(): string {
  const { params, treasuryRaw } = readForm();
  return JSON.stringify({
    ...params,
    totalSupply: params.totalSupply.toString(),
    maximumFee: params.maximumFee.toString(),
    treasuryRaw,
    rpc: rpcUrl(),
    wallet: walletPubkey?.toBase58() ?? null,
  });
}

async function preview(): Promise<boolean> {
  previewedFingerprint = null;
  $("result").innerHTML = "";
  $("log").innerHTML = "";
  try {
    const { params, treasuryRaw } = readForm();
    const errs = validateMintParams(params);
    if (treasuryRaw) {
      try { new PublicKey(treasuryRaw); } catch { errs.push("Treasury is not a valid address."); }
    }
    if (!walletPubkey) errs.push("Connect a wallet first — it pays rent and receives the supply.");
    if (errs.length) { setStatus(errs.join(" "), "err"); return false; }

    const conn = new Connection(rpcUrl(), "confirmed");
    setStatus("Checking the endpoint really is devnet…");
    await assertDevnet(conn);

    const payer = walletPubkey!;
    const treasury = treasuryRaw ? new PublicKey(treasuryRaw) : payer;
    const full: MintParams = { ...params, payer, treasury };
    // A throwaway key, purely to size the plan. pack() encodes the pubkey as a fixed 32
    // bytes, so rent and lengths hold for whichever key the real run draws.
    const plan = await planMint(conn, full, Keypair.generate().publicKey);
    const bal = await conn.getBalance(payer);

    $("result").innerHTML = `
      <h3>Plan — nothing sent, nothing spent</h3>
      <table class="plan">
        <tr><td>payer</td><td class="mono">${esc(payer.toBase58())}</td></tr>
        <tr><td>treasury</td><td class="mono">${esc(treasury.toBase58())}</td></tr>
        <tr><td>balance</td><td>${(bal / 1e9).toFixed(4)} SOL</td></tr>
        <tr><td>rent</td><td>${(plan.rentLamports / 1e9).toFixed(6)} SOL (${plan.mintLen}+${plan.metadataLen} bytes)</td></tr>
        <tr><td>supply</td><td>${params.totalSupply.toLocaleString()} ${esc(params.symbol)} (${params.decimals} decimals)</td></tr>
        <tr><td>fee</td><td>${params.feeBasisPoints} bps${plan.uncapped ? ", uncapped" : `, max ${params.maximumFee}`}</td></tr>
      </table>
      <h3>Authorities the mint ends with</h3>
      <table class="plan">
        <tr><td>mint</td><td><b>REVOKED</b> — same transaction as the mint-to, so supply can never be inflated</td></tr>
        <tr><td>freeze</td><td><b>NEVER SET</b> — this is the honeypot vector</td></tr>
        <tr><td>transferFeeConfig</td><td class="mono">${esc(payer.toBase58())}</td></tr>
        <tr><td>withdrawWithheld</td><td class="mono">${esc(treasury.toBase58())} <b>— FIXED AT CREATION, unchangeable</b></td></tr>
        <tr><td>metadataUpdate</td><td class="mono">${esc(payer.toBase58())}</td></tr>
      </table>`;
    previewedFingerprint = formFingerprint();
    setStatus("Plan looks valid. Read the treasury line before creating — it can never be changed.", "ok");
    return true;
  } catch (e) {
    setStatus((e as Error).message, "err");
    return false;
  }
}

async function sendTx(
  conn: Connection,
  ixs: TransactionInstruction[],
  payer: PublicKey,
  extraSigner: Keypair | null,
  label: string,
): Promise<string> {
  await assertDevnet(conn); // again, immediately before signing
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;
  if (extraSigner) tx.partialSign(extraSigner);
  const signed = await wallet!.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  log(`✅ ${esc(label)} — <a href="https://solscan.io/tx/${sig}?cluster=devnet" target="_blank" rel="noopener">${sig.slice(0, 20)}…</a>`);
  return sig;
}

async function create() {
  // Preview-before-create, enforced here rather than by disabling the button. If the plan
  // on screen does not match the form (never previewed, or edited since), run the preview
  // and stop — the second click is the confirmation. Every click produces a visible result.
  if (previewedFingerprint !== formFingerprint()) {
    const stale = previewedFingerprint !== null;
    const ok = await preview();
    if (ok) {
      setStatus(
        (stale
          ? "The form changed since the last preview, so the plan was rebuilt. "
          : "Plan built. ") +
        "Read it above — the treasury line can never be changed — then click " +
        "“Create the mint” again to confirm.",
        "",
      );
    }
    return;
  }

  $<HTMLButtonElement>("create").disabled = true;   // only while sending, to stop double-submit
  $("log").innerHTML = "";
  try {
    const { params, treasuryRaw } = readForm();
    const conn = new Connection(rpcUrl(), "confirmed");
    await assertDevnet(conn);

    const payer = walletPubkey!;
    const treasury = treasuryRaw ? new PublicKey(treasuryRaw) : payer;
    const mintKp = Keypair.generate();
    const full: MintParams = { ...params, payer, treasury };
    const plan = await planMint(conn, full, mintKp.publicKey);
    const { createIxs, supplyIxs } = buildMintTxs(full, plan);

    setStatus("Transaction 1 of 2 — creating the mint. Approve in your wallet.");
    log(`mint address will be <span class="mono">${esc(mintKp.publicKey.toBase58())}</span>`);
    await sendTx(conn, createIxs, payer, mintKp, "mint created");

    // Deliberately NOT signed together with tx1: tx2 mints into an ATA for a mint tx1
    // creates, so it cannot even be built validly until tx1 confirms.
    setStatus("Transaction 2 of 2 — minting supply and revoking mint authority. Approve again.");
    await sendTx(conn, supplyIxs, payer, null, "supply minted + mint authority revoked");

    const mintStr = mintKp.publicKey.toBase58();
    const record = JSON.stringify({
      cluster: "devnet",
      mint: mintStr,
      deployer: payer.toBase58(),
      treasury: treasury.toBase58(),
      deployerAta: plan.ata.toBase58(),
      decimals: params.decimals,
      supply: plan.supply.toString(),
      feeBasisPoints: params.feeBasisPoints,
    }, null, 2);

    $("result").innerHTML = `
      <h3>Launched</h3>
      <p><a class="big" href="/grade.html?mint=${mintStr}&cluster=devnet">Grade it now &rarr;</a></p>
      <p>The grader will flag it for a live <b>fee rate authority</b> until you run
         <span class="mono">npm run lock</span>, and for <b>100% holder concentration</b>
         until the supply is actually distributed. Both are true readings, not bugs.</p>
      <h3>The CLI does not know about this token</h3>
      <p>Every <span class="mono">1x-*</span> script resolves its target through
         <span class="mono">mint.devnet.json</span>, and this launcher cannot write your
         filesystem. To lock or harvest it from the CLI, save this over that file — it will
         overwrite the current record, so roll the old one aside first if you still need it:</p>
      <pre id="record">${esc(record)}</pre>
      <button id="copy" type="button">Copy JSON</button>`;
    $("copy").addEventListener("click", () => {
      navigator.clipboard.writeText(record);
      setStatus("Copied. Paste into mint.devnet.json.", "ok");
    });
    setStatus("Done — the mint exists and its supply is fixed forever.", "ok");
  } catch (e) {
    const msg = (e as Error).message;
    setStatus(msg, "err");
    log(
      `❌ ${esc(msg)}<br><br>If the FIRST transaction succeeded and the second did not, the ` +
      `mint exists, holds no supply, and still has a live mint authority. That is ` +
      `recoverable — but only with the mint address logged above. Copy it before leaving.`,
    );
  } finally {
    $<HTMLButtonElement>("create").disabled = false;
  }
}

/**
 * Connect feedback goes NEXT TO the connect button, not into #status at the bottom of the
 * page. Reported 2026-08-11 as "the connect button doesn't click": it did, and it set an
 * error — roughly 800px below the control that produced it, so the page looked dead. A
 * message the user cannot see is the same as no message.
 */
function setWalletMsg(html: string, kind: "" | "err" | "ok" = "") {
  const el = $("walletmsg");
  el.innerHTML = html;
  el.className = kind;
}

async function connect() {
  wallet = getWallet();
  if (!wallet) {
    return setWalletMsg(
      "No Solana wallet detected in this browser. This page needs a wallet extension such " +
      "as <a href=\"https://phantom.app/\" target=\"_blank\" rel=\"noopener\">Phantom</a>. " +
      "If you have one installed, check it is enabled for this site, then reload. " +
      "It must also be switched to <b>devnet</b> in the wallet's own network setting.",
      "err",
    );
  }
  try {
    setWalletMsg("Approve the connection request in your wallet…");
    const res = await wallet.connect();
    walletPubkey = new PublicKey(res.publicKey.toBase58());
    $("wallet").textContent = walletPubkey.toBase58();
    $("connect").textContent = "Connected";
    setWalletMsg(
      "Connected. If your wallet is not on <b>devnet</b>, it will refuse to sign — this page " +
      "only ever builds devnet transactions.",
      "ok",
    );
    setStatus("Fill the form, then preview the plan.", "ok");
  } catch (e) {
    setWalletMsg(esc((e as Error).message), "err");
  }
}

$("connect").addEventListener("click", connect);
$("preview").addEventListener("click", preview);
$("create").addEventListener("click", create);
$<HTMLInputElement>("uncapped").addEventListener("change", () => {
  $<HTMLInputElement>("maxfee").disabled = $<HTMLInputElement>("uncapped").checked;
});

try {
  const saved = localStorage.getItem(RPC_KEY);
  if (saved) $<HTMLInputElement>("rpc").value = saved;
} catch { /* private browsing */ }
