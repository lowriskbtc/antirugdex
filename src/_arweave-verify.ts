/**
 * Proves a Turbo/Irys upload is permanently on Arweave. Read-only.
 *
 *   npx tsx src/_arweave-verify.ts <tx-id>
 *   npx tsx src/_arweave-verify.ts            # checks every id in arweave-receipts.json
 *
 * ## Read this before changing the check — it has been wrong twice
 *
 * This project has now shipped two different broken permanence checks, and both failed the
 * same way: they could not distinguish "not yet" from "never".
 *
 * 1. **2026-08-07 — `GET /<id>` returns 200.** The Irys upload never resolved there, and the
 *    404 was read as "be patient". Two days lost.
 * 2. **2026-08-09 — `GET /tx/<id>/status` returns 200.** Written to fix (1). It is *also*
 *    wrong, in the opposite direction: `/tx/*` serves **layer-1 transactions only**. Turbo
 *    and Irys both upload **bundled data items**, which are not L1 transactions and never
 *    appear there. The endpoint returns 404 forever, so the ✅ it waited for could not print.
 *    A day was lost to a file that said "this 404 is the good kind, just wait".
 *
 * A data item's id is 43 chars for BOTH networks, so **length is not a discriminator**. The
 * 44-char Irys id was an anomaly, not the rule. Do not reintroduce that test as a gate.
 *
 * ## What actually proves permanence
 *
 * A bundled data item is permanent when the **bundle** carrying it is mined into an Arweave
 * block. So ask the index, not the L1 endpoint:
 *
 *   1. `POST /graphql  transactions(ids:[id])` — is the item indexed, and what is it
 *      `bundledIn`? An unknown item is not on Arweave, whatever a gateway serves.
 *   2. `GET /tx/<bundleId>/status` — the bundle IS an L1 transaction, so this one is
 *      meaningful. It must carry a `block_height` and confirmations.
 *   3. `GET /<id>` and hash the bytes against the local source file. "Arweave has a
 *      transaction" and "the bytes are the file we meant" are separate claims.
 *
 * Note what is deliberately NOT proof: `GET /<id>` returning 200 on its own. Turbo's receipt
 * lists `fastFinalityIndexes`, and those gateways serve the bytes from cache *before* the
 * bundle is mined. A 200 there is a CDN hit, not a permanence guarantee.
 *
 * Exits non-zero unless every id is confirmed, so it can gate a script.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARWEAVE = "https://arweave.net";

/**
 * Turbo's own view of an upload. Used for DIAGNOSTICS ONLY — never as a pass condition.
 *
 * It answers "which bundle did we put your item in", which is exactly the question the
 * canonical index cannot answer until it has unbundled that bundle. A 50 MB bundle can be
 * mined for a while before arweave.net finishes indexing its contents, and without this the
 * script reports a bare PENDING that looks identical to a failed upload.
 *
 * It is not proof because it is the uploader vouching for itself — the same category of
 * evidence as the receipt, which this project has already learned not to trust. The gate
 * stays on the independent index.
 */
const TURBO_STATUS = "https://upload.ardrive.io/v1/tx";

/**
 * Arweave forks are shallow and rare, but a URI baked into a mint is frozen forever, so
 * don't call a transaction final the block it lands in.
 */
const MIN_CONFIRMATIONS = 5;

export type Receipt = { id: string; file?: string };

type Indexed = {
  bundledIn: string | null;
  blockHeight: number | null;
  size: number | null;
  owner: string | null;
};

/** Step 1 — is the data item known to Arweave's index at all? */
async function graphql(id: string): Promise<Indexed | null> {
  const query = `{ transactions(ids:["${id}"]) { edges { node {
        id owner { address } data { size } bundledIn { id } block { height }
      } } } }`;

  const r = await fetch(`${ARWEAVE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`arweave.net/graphql returned HTTP ${r.status}`);

  const j: any = await r.json();
  if (j.errors) throw new Error(`graphql: ${JSON.stringify(j.errors).slice(0, 200)}`);

  const node = j?.data?.transactions?.edges?.[0]?.node;
  if (!node) return null;

  return {
    bundledIn: node.bundledIn?.id ?? null,
    blockHeight: node.block?.height ?? null,
    size: node.data?.size != null ? Number(node.data.size) : null,
    owner: node.owner?.address ?? null,
  };
}

/** Step 2 — the bundle is a real L1 transaction, so /tx/<id>/status means something here. */
async function l1Status(
  txid: string,
): Promise<{ code: number; height?: number; confirmations?: number; body: string }> {
  const r = await fetch(`${ARWEAVE}/tx/${txid}/status`);
  const body = (await r.text()).trim();
  if (r.status !== 200) return { code: r.status, body };
  try {
    const j = JSON.parse(body);
    return {
      code: 200,
      height: j.block_height,
      confirmations: j.number_of_confirmations,
      body,
    };
  } catch {
    return { code: 200, body };
  }
}

/** Diagnostic only — see TURBO_STATUS. Never gates a pass. */
async function turboView(id: string): Promise<{ status: string; bundleId?: string } | null> {
  try {
    const r = await fetch(`${TURBO_STATUS}/${id}/status`);
    if (!r.ok) return null;
    const j: any = await r.json();
    return { status: String(j.status ?? "?"), bundleId: j.bundleId ?? undefined };
  } catch {
    return null; // Turbo being unreachable must never turn a verification into an error.
  }
}

/** Step 3 — the bytes served must be the bytes we meant to freeze. */
async function bytesMatchLocal(
  id: string,
  localFile: string | undefined,
): Promise<{ ok: boolean; note: string }> {
  const r = await fetch(`${ARWEAVE}/${id}`, { redirect: "follow" });
  if (!r.ok) return { ok: false, note: `gateway will not serve the data (HTTP ${r.status})` };

  const served = Buffer.from(await r.arrayBuffer());
  const servedHash = createHash("sha256").update(served).digest("hex");

  if (!localFile) {
    return { ok: true, note: `${served.length} bytes, sha256 ${servedHash.slice(0, 16)}… (no local file recorded to compare)` };
  }

  const abs = path.resolve(process.cwd(), localFile);
  if (!fs.existsSync(abs)) {
    return { ok: true, note: `${served.length} bytes, sha256 ${servedHash.slice(0, 16)}… (local ${localFile} is gone; cannot compare)` };
  }

  const localHash = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  if (localHash !== servedHash) {
    return {
      ok: false,
      note:
        `SERVED BYTES DO NOT MATCH ${localFile}\n` +
        `       served sha256 ${servedHash}\n` +
        `       local  sha256 ${localHash}`,
    };
  }
  return { ok: true, note: `${served.length} bytes, sha256 matches ${localFile}` };
}

/**
 * Exported so `_arweave-upload.ts` calls THIS, rather than keeping a second copy of the
 * decision table. The second copy is what went stale last time.
 */
export async function check(rec: Receipt): Promise<boolean> {
  const { id, file } = rec;
  console.log(`\n  ${id}${file ? `   (${file})` : ""}`);

  const idx = await graphql(id);

  // ---- not in the index: either freshly posted, or it was never Arweave at all ----
  if (!idx) {
    const st = await l1Status(id);
    console.log(`  graphql             -> not indexed`);
    console.log(`  GET /tx/<id>/status -> HTTP ${st.code}`);
    if (st.code === 400) {
      console.log(`  ${st.body.slice(0, 120)}`);
      console.log(
        `  🔴 NOT ON ARWEAVE, AND NEVER WILL BE. The id is not even Arweave-shaped —\n` +
          `     this is how the 2026-08-07 Irys upload failed. Re-upload via Turbo.`,
      );
      return false;
    }

    // Say WHY it is pending, so this state is distinguishable from a dead upload without
    // waiting hours to find out. Diagnostic only — still returns false either way.
    const t = await turboView(id);
    if (t) {
      console.log(`  turbo says          -> ${t.status}, bundle ${t.bundleId?.slice(0, 12)}…`);
      if (t.bundleId) {
        const b = await l1Status(t.bundleId);
        if (b.code === 200 && b.height != null) {
          console.log(
            `  that bundle         -> MINED at block ${b.height.toLocaleString()}, ${b.confirmations?.toLocaleString()} confirmations\n` +
              `  ⏳ PENDING on the INDEX, not on Arweave. The carrying bundle is already mined;\n` +
              `     arweave.net has not finished unbundling it yet (large bundles take a while).\n` +
              `     This will clear on its own. Re-run.`,
          );
          return false;
        }
        console.log(`  that bundle         -> not mined yet (HTTP ${b.code})`);
      }
    }

    console.log(
      `  ⏳ PENDING — posted but not yet indexed. Re-run in a few minutes.\n` +
        `     If this persists for hours, treat it as failed and re-upload.`,
    );
    return false;
  }

  console.log(`  graphql             -> indexed, owner ${idx.owner?.slice(0, 12)}…, ${idx.size ?? "?"} bytes`);

  // ---- the L1 transaction that actually carries it ----
  const l1id = idx.bundledIn ?? id;
  const kind = idx.bundledIn ? `bundle ${idx.bundledIn.slice(0, 12)}…` : `direct L1 tx`;
  const st = await l1Status(l1id);
  console.log(`  ${idx.bundledIn ? "bundledIn" : "L1 tx    "}           -> ${kind}`);
  console.log(`  GET /tx/<l1>/status -> HTTP ${st.code}${st.height ? `  block ${st.height.toLocaleString()}, ${st.confirmations?.toLocaleString()} confirmations` : ""}`);

  if (st.code !== 200 || st.height == null) {
    console.log(
      `  ⏳ PENDING — indexed but the carrying transaction is not mined yet.\n` +
        `     This is the one case where waiting is genuinely correct.`,
    );
    return false;
  }

  if ((st.confirmations ?? 0) < MIN_CONFIRMATIONS) {
    console.log(
      `  ⏳ SHALLOW — mined, but only ${st.confirmations} confirmation(s). Want ≥ ${MIN_CONFIRMATIONS}\n` +
        `     before freezing this URL into a mint. Re-run shortly.`,
    );
    return false;
  }

  // ---- the bytes ----
  const b = await bytesMatchLocal(id, file);
  console.log(`  GET /<id>           -> ${b.note}`);
  if (!b.ok) {
    console.log(`  🔴 DATA MISMATCH — do not record this URL.`);
    return false;
  }

  console.log(`  ✅ CONFIRMED — mined into Arweave block ${st.height.toLocaleString()}, bytes verified.`);
  console.log(`     ${ARWEAVE}/${id}`);
  return true;
}

async function main() {
  const arg = process.argv[2];
  let recs: Receipt[];

  if (arg) {
    recs = [{ id: arg }];
  } else {
    const f = path.join(process.cwd(), "arweave-receipts.json");
    if (!fs.existsSync(f))
      throw new Error(`No id given and no ${f}. Usage: npx tsx src/_arweave-verify.ts <tx-id>`);
    recs = (JSON.parse(fs.readFileSync(f, "utf8")) as Receipt[]).map((r) => ({
      id: r.id,
      file: r.file,
    }));
    if (!recs.length) throw new Error(`${f} has no receipts in it.`);
  }

  console.log(`\nArweave verification — ${recs.length} id(s)`);
  let allOk = true;
  for (const r of recs) allOk = (await check(r)) && allOk;

  console.log(
    allOk
      ? `\nAll confirmed. These URLs are safe to record.\n`
      : `\nNot all confirmed — do NOT record an unconfirmed id in config.ts or metadata.json.\n`,
  );
  if (!allOk) process.exitCode = 1;
}

// Only run as a CLI. Importing this module (see `_arweave-upload.ts`) must not trigger a
// full receipts sweep as a side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`\n${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
