/**
 * Checks the configured metadata URI without creating a mint.
 *
 * TWO checks, and the second one exists because the first is not enough:
 *
 *  1. assertUriServesJson — reachable, HTTP OK, not HTML, parses as JSON.
 *     Catches the Cloudflare parking page, which returns HTTP 200 with an
 *     HTML body and would fool a status-code check.
 *
 *  2. Deep-equality against the local metadata.json. Added 2026-08-06 after
 *     check 1 reported OK while the live URI was serving a stale 1% fee and
 *     config.ts had already moved to 0.25%. Shape validation cannot catch a
 *     content mismatch, and minting against metadata that contradicts the
 *     mint is exactly the screenshot this project exists to prevent.
 *
 * The URI is immutable in practice once the metadata update authority is
 * revoked, so a mismatch here is a mainnet blocker, not a warning.
 */
import fs from "node:fs";
import path from "node:path";
import { TOKEN } from "./config.js";
import { assertUriServesJson } from "./lib.js";

const LOCAL = path.join(process.cwd(), "metadata.json");

/** Stable stringify so key order never causes a false mismatch. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

try {
  await assertUriServesJson(TOKEN.uri);
  console.log(`OK   — ${TOKEN.uri} serves valid JSON.`);

  if (!fs.existsSync(LOCAL)) {
    console.warn(`WARN — ${LOCAL} not found; skipped the content comparison.`);
  } else {
    const live: any = await (await fetch(TOKEN.uri, { redirect: "follow" })).json();
    const local: any = JSON.parse(fs.readFileSync(LOCAL, "utf8"));

    if (canonical(live) !== canonical(local)) {
      const liveFee = live?.attributes?.find(
        (a: { trait_type?: string }) => a?.trait_type === "Transfer fee",
      )?.value;
      const localFee = local?.attributes?.find(
        (a: { trait_type?: string }) => a?.trait_type === "Transfer fee",
      )?.value;

      throw new Error(
        `Live metadata does NOT match local metadata.json.\n` +
          `  live  Transfer fee: ${liveFee ?? "(absent)"}\n` +
          `  local Transfer fee: ${localFee ?? "(absent)"}\n` +
          `  config.ts feeBasisPoints: ${TOKEN.feeBasisPoints} (${TOKEN.feeBasisPoints / 100}%)\n` +
          `  Redeploy site/ to Cloudflare, then re-run this check.`,
      );
    }
    console.log(`OK   — live metadata is identical to local metadata.json.`);

    // Independent of the file comparison: the published fee must match the
    // rate actually baked into the mint. Both files could agree and both be
    // wrong relative to config.ts.
    const pct = `${TOKEN.feeBasisPoints / 100}%`;
    const feeAttr = String(
      local?.attributes?.find(
        (a: { trait_type?: string }) => a?.trait_type === "Transfer fee",
      )?.value ?? "",
    );
    if (!feeAttr.includes(pct)) {
      throw new Error(
        `Metadata fee does not match config.ts.\n` +
          `  metadata says: ${feeAttr || "(no Transfer fee attribute)"}\n` +
          `  config.ts says: ${pct} (${TOKEN.feeBasisPoints} bps)\n` +
          `  Fix metadata.json AND site/token/metadata.json, then redeploy.`,
      );
    }
    console.log(`OK   — published fee matches config.ts (${pct}).`);
  }
} catch (e) {
  console.error((e as Error).message);
  // exitCode, not exit() — an abrupt exit while fetch's keep-alive socket is
  // still open trips a libuv assertion that looks like a crash.
  process.exitCode = 1;
}
