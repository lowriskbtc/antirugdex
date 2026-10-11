/**
 * Browser entry for the web grader. Bundled to site/grader.js by `npm run build:web`.
 *
 * It contains NO checks. Every rule comes from src/grade-core.ts, the same module the CLI
 * runs, so a token graded here and graded by `npx tsx src/grade.ts` cannot disagree. If you
 * find yourself adding a condition to this file, it belongs in grade-core.ts instead.
 *
 * ⚠️ RPC REALITY, and it is visible to users rather than hidden. This page calls a PUBLIC
 * endpoint directly from the browser, because a keyed endpoint in client-side JavaScript is
 * a published key. Public endpoints refuse `getTokenLargestAccounts`, so the holder
 * concentration row will render as FLAGGED / NOT CHECKED here far more often than in the
 * CLI. That is rule 5 working, not a defect: "we could not read it" must never render as
 * "we read it and it was fine". The page says so in as many words.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { grade, renderReportBody, REPORT_CSS } from "../src/grade-core.js";

// The report's stylesheet ships with the renderer rather than being copied into the page,
// for the same reason the checks do: one definition. It is inserted as the FIRST child of
// <head> so the page's own palette overrides win on equal specificity — the site is dark
// with green accents, the standalone CLI report is light/dark auto, and both use the same
// markup underneath.
const style = document.createElement("style");
style.textContent = REPORT_CSS;
document.head.insertBefore(style, document.head.firstChild);

// Measured from a browser on 2026-08-11, not assumed:
//   devnet  api.devnet.solana.com       — works, except getTokenLargestAccounts (429)
//   mainnet api.mainnet-beta.solana.com — 403 "Access forbidden" on EVERY call, including
//                                          getAccountInfo. Not a rate limit; browser
//                                          origins are refused outright.
// So the mainnet default cannot grade anything at all, and the page has to say so and
// offer the fix rather than presenting a dropdown option that always fails.
const RPCS: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

const RPC_KEY = "antirugdex.rpc";

/**
 * Genesis hashes, same values lib.ts checks against.
 *
 * 🔴 A custom endpoint SILENTLY OVERRIDES the cluster dropdown, which makes the dropdown a
 * claim rather than a fact — paste a mainnet URL, leave the selector on devnet, and the page
 * queries mainnet while labelling the report "devnet". Observed 2026-08-11: a mainnet Helius
 * URL against a devnet mint produced "No account ... on this cluster", which reads as "this
 * token does not exist" when the truth was "you are looking at the wrong chain."
 *
 * This repo has already paid for this exact confusion once — a .env configured for mainnet
 * handed mainnet keys and a mainnet RPC to runs that every log line called devnet, and
 * CLUSTER=devnet was itself what disabled mainnetGuard. The fix there is the fix here:
 * verify the GENESIS HASH, which a URL string cannot fake.
 */
const GENESIS: Record<string, string> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

/** Throws unless the endpoint really is on the cluster the dropdown claims. */
async function assertClusterMatches(conn: Connection, cluster: string): Promise<void> {
  const actual = await conn.getGenesisHash();
  const expected = GENESIS[cluster];
  if (actual === expected) return;
  const onChain =
    Object.entries(GENESIS).find(([, h]) => h === actual)?.[0] ?? "an unknown chain";
  throw new Error(
    `That endpoint is on ${onChain}, but the selector says ${cluster}. ` +
      `Switch the selector to ${onChain}, or clear the RPC field to use the public ` +
      `${cluster} endpoint. (Reports are labelled with the cluster, so grading across a ` +
      `mismatch would produce a mislabelled report rather than an error.)`,
  );
}

/** A user-supplied endpoint beats the public default. Never bake a key into the bundle. */
function rpcFor(cluster: string): string {
  const custom = ($<HTMLInputElement>("rpc").value || "").trim();
  return custom || RPCS[cluster];
}

/**
 * Public endpoints fail in two distinct ways and the difference is actionable, so the page
 * explains rather than surfacing a raw JSON-RPC error string.
 */
function explainRpcError(msg: string, cluster: string, usingCustom: boolean): string {
  if (/\b403\b|Access forbidden/i.test(msg)) {
    return usingCustom
      ? `Your endpoint refused the request (403). Check the URL and that the key is valid ` +
        `for ${cluster} — a mainnet key will not serve devnet, and vice versa.`
      : `The public ${cluster} endpoint refuses browser requests (403). ` +
        `This is not a rate limit and waiting will not help — open “Advanced” and paste your ` +
        `own RPC URL (Helius, Triton and QuickNode all have free tiers that work from a browser).`;
  }
  if (/\b429\b|Too Many Requests/i.test(msg)) {
    return usingCustom
      ? `Your endpoint rate-limited this request (429).`
      : `The public ${cluster} endpoint rate-limited this request (429). ` +
        `Open “Advanced” and paste your own RPC URL for a reliable read.`;
  }
  return msg;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function setStatus(msg: string, kind: "" | "err" = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = kind;
}

async function run() {
  const raw = $<HTMLInputElement>("mint").value.trim();
  const cluster = $<HTMLSelectElement>("cluster").value;
  const out = $("report");

  if (!raw) return setStatus("Enter a mint address.", "err");

  let mint: PublicKey;
  try {
    mint = new PublicKey(raw);
  } catch {
    return setStatus(`"${raw}" is not a valid Solana address.`, "err");
  }

  out.innerHTML = "";
  setStatus(`Reading ${cluster} accounts…`);
  $<HTMLButtonElement>("go").disabled = true;

  const endpoint = rpcFor(cluster);
  const usingCustom = endpoint !== RPCS[cluster];
  // Persist the endpoint locally so it is not retyped. localStorage only — it never leaves
  // the browser, and it is the user's own key, not one shipped in the bundle.
  try {
    localStorage.setItem(RPC_KEY, $<HTMLInputElement>("rpc").value.trim());
  } catch { /* private browsing — not worth failing the grade over */ }

  try {
    const conn = new Connection(endpoint, "confirmed");
    // Before reading anything: prove the endpoint is on the cluster the selector claims.
    // Cheap (one call), and it converts a mislabelled report into a clear instruction.
    if (usingCustom) await assertClusterMatches(conn, cluster);
    const poolRaw = $<HTMLInputElement>("pool").value.trim();
    const rows = await grade(conn, mint, {
      poolId: poolRaw ? new PublicKey(poolRaw) : undefined,
      // No decodePool in the browser build: it would pull the whole Raydium SDK into a
      // static page. grade-core emits an explicit NOT CHECKED row when a pool is asked for
      // without a decoder, rather than quietly skipping the liquidity checks.
    });
    out.innerHTML = renderReportBody(mint.toBase58(), cluster, rows);
    // Always say which endpoint produced the report. Provenance is the point of the tool.
    setStatus(usingCustom
      ? `Read via your own endpoint — confirmed on ${cluster} by genesis hash.`
      : `Read via the public ${cluster} endpoint.`);
  } catch (e) {
    setStatus(explainRpcError((e as Error).message, cluster, usingCustom), "err");
  } finally {
    $<HTMLButtonElement>("go").disabled = false;
  }
}

$("go").addEventListener("click", run);
for (const id of ["mint", "pool", "rpc"]) {
  $(id).addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") run();
  });
}

try {
  const saved = localStorage.getItem(RPC_KEY);
  if (saved) {
    $<HTMLInputElement>("rpc").value = saved;
    // Open the disclosure so a saved endpoint is visible rather than silently in effect —
    // the user should be able to see which endpoint produced a report.
    ($("advanced") as HTMLDetailsElement).open = true;
  }
} catch { /* private browsing */ }

// Deep-linkable: /grade.html?mint=…&cluster=devnet grades on load, so a report can be
// linked to directly — which is the whole point of publishing one.
const params = new URLSearchParams(location.search);
const qMint = params.get("mint");
if (qMint) {
  $<HTMLInputElement>("mint").value = qMint;
  const qCluster = params.get("cluster");
  if (qCluster && qCluster in RPCS) $<HTMLSelectElement>("cluster").value = qCluster;
  const qPool = params.get("pool");
  if (qPool) $<HTMLInputElement>("pool").value = qPool;
  run();
}
