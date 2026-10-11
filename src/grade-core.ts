/**
 * The grader's logic, with NO environment access — no `process`, no `fs`, no `lib.js`.
 *
 * Extracted from grade.ts on 2026-08-11 so the browser and the CLI run the SAME code.
 * That constraint is the whole point of this file: a web grader that reimplemented these
 * checks would drift from the CLI, and the drift would show up as the web page calling a
 * token safe that the CLI flags. This repo has paid for that failure mode more than once
 * (the hardcoded "1%" fee string, the stale IDL, the `lp_supply` field that reads correct
 * and is not).
 *
 * `lib.ts` cannot be imported here: it reads `process.env` at module load, which throws in
 * a browser. So the two pure helpers the grader needs — `classifyUri` and `fmt` — are
 * DEFINED here and re-exported by `lib.ts`, rather than copied. One definition, two callers
 * (00-preflight.ts applies the identical URI rule).
 *
 * DESIGN RULES, learned the hard way on our own token:
 *
 *  1. Read CHAIN state, never config. A verifier that quotes a constant is not a verifier —
 *     ours printed "1%" for a week after the mint moved to 0.25%.
 *  2. No pass/fail badge. VERIFIED / FLAGGED / INFO, plus a cannot-verify list.
 *  3. Never call a third-party API. Accounts are the ground truth.
 *  4. Report deliberate-and-disclosed separately from unsafe.
 *  5. A check that could not run is FLAGGED, never silent.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint, getTransferFeeConfig,
  getMetadataPointerState, getTokenMetadata, getPermanentDelegate,
  getDefaultAccountState, getTransferHook, getMintCloseAuthority,
  AccountState,
} from "@solana/spl-token";

export type Level = "VERIFIED" | "FLAGGED" | "INFO";
export interface Row { level: Level; key: string; k?: string; value: string; note?: string }

/** Is a metadata URI content-addressed, i.e. immutable by construction? */
export function classifyUri(uri: string): { ok: boolean; kind: string } {
  const u = uri.trim().toLowerCase();
  if (u.startsWith("ipfs://") || /\/ipfs\/[a-z0-9]{46,}/i.test(u))
    return { ok: true, kind: "IPFS (content-addressed)" };
  if (u.includes("arweave.net/") || u.startsWith("ar://"))
    return { ok: true, kind: "Arweave (permanent)" };
  if (u.startsWith("data:")) return { ok: true, kind: "inline data URI" };
  if (u.startsWith("http://")) return { ok: false, kind: "plain HTTP (not even TLS)" };
  if (u.startsWith("https://")) return { ok: false, kind: "HTTPS pointer on a rented domain" };
  return { ok: false, kind: "unrecognised scheme" };
}

/** Formats base units as a human amount. */
export function fmt(raw: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = raw / d;
  const frac = (raw % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole.toLocaleString()}.${frac}` : whole.toLocaleString();
}

export function explorerUrl(
  id: string | PublicKey,
  cluster: string,
  kind: "tx" | "address" = "address",
): string {
  const suffix = cluster === "mainnet" ? "" : `?cluster=${cluster}`;
  return `https://solscan.io/${kind}/${id.toString()}${suffix}`;
}

/**
 * The bucket that makes the report honest. On-chain config cannot see any of this, and a
 * grader that omits it implies a launch is clean when it has only been checked for the
 * things that happen to be readable.
 */
export const CANNOT_VERIFY: string[] = [
  "who controls the wallets holding supply — the figures above measure ADDRESSES, not people",
  "off-chain agreements: OTC deals, market-maker terms, promised lockups",
  "whether team allocations sit in ordinary-looking wallets",
  "whether holders were funded from one source (CEX withdrawals break the trail)",
  "coordinated selling planned between separate wallets",
  "anything promised in a roadmap, Discord, or on a website",
];

const isNull = (k?: PublicKey | null) => !k || k.equals(PublicKey.default);

/**
 * Decoded Raydium CPMM pool state, in the shape `grade` needs.
 *
 * Injected rather than imported so this module does not depend on the Raydium SDK — the
 * CLI passes a decoder built on `CpmmPoolInfoLayout`, and a caller that does not need pool
 * checks (or cannot afford the bundle) passes nothing and gets an honest "not checked" row
 * instead of a silently missing one.
 */
export interface DecodedPool {
  mintA: PublicKey; mintB: PublicKey;
  vaultA: PublicKey; vaultB: PublicKey;
  mintLp: PublicKey;
  mintDecimalA: number; mintDecimalB: number;
  openTime: number | bigint;
  status: number | bigint;
}
export type PoolDecoder = (data: Uint8Array) => DecodedPool;

export interface GradeOptions {
  poolId?: PublicKey;
  programId?: PublicKey;
  decodePool?: PoolDecoder;
  /** Injected so tests and the browser can drive the clock. */
  now?: () => number;
}

export async function grade(
  conn: Connection,
  mint: PublicKey,
  opts: GradeOptions = {},
): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (level: Level, key: string, value: string, note?: string) =>
    rows.push({ level, key, value, note });
  const nowMs = opts.now ?? (() => Date.now());

  // Which token program owns it? Determines which extensions can exist at all.
  const acct = await conn.getAccountInfo(mint, "confirmed");
  if (!acct) throw new Error(`No account at ${mint.toBase58()} on this cluster`);
  const is2022 = acct.owner.equals(TOKEN_2022_PROGRAM_ID);
  const prog = is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  if (!is2022 && !acct.owner.equals(TOKEN_PROGRAM_ID))
    throw new Error(`${mint.toBase58()} is not a token mint (owner ${acct.owner.toBase58()})`);

  const info = await getMint(conn, mint, "confirmed", prog);

  // ---- supply -------------------------------------------------------------
  add(isNull(info.mintAuthority) ? "VERIFIED" : "FLAGGED",
    "mint authority",
    isNull(info.mintAuthority) ? "revoked" : info.mintAuthority!.toBase58(),
    isNull(info.mintAuthority) ? "supply cannot be inflated" : "CAN MINT UNLIMITED NEW SUPPLY");

  add(isNull(info.freezeAuthority) ? "VERIFIED" : "FLAGGED",
    "freeze authority",
    isNull(info.freezeAuthority) ? "null" : info.freezeAuthority!.toBase58(),
    isNull(info.freezeAuthority) ? "no account can be frozen" : "CAN FREEZE ANY HOLDER'S WALLET");

  add("INFO", "supply", `${fmt(info.supply, info.decimals)} (${info.decimals} decimals)`);
  add("INFO", "token program", is2022 ? "Token-2022" : "SPL Token (legacy)");

  if (is2022) {
    // ---- transfer fee -----------------------------------------------------
    const fee = getTransferFeeConfig(info);
    if (!fee) {
      add("VERIFIED", "transfer fee", "none", "no fee on transfers");
    } else {
      const cur = fee.newerTransferFee;
      const bps = cur.transferFeeBasisPoints;
      const uncapped = cur.maximumFee >= (1n << 64n) - 1n;

      add(bps > 500 ? "FLAGGED" : "INFO", "transfer fee rate",
        `${bps} bps (${bps / 100}%)`,
        bps > 500 ? "above 5% — unusually high" : undefined);

      // A nominal rate with a low cap is a fake fee: whales pay ~0%. Every other checklist
      // reads the rate and stops.
      //
      // But only when a rate EXISTS. Caught by testing against PYUSD, which has rate 0 and
      // cap 0 — flagging that as "whales pay less" was a false positive on a token with no
      // fee at all. A grader that cries wolf on a regulated stablecoin gets closed and
      // never opened again.
      if (bps === 0) {
        add("VERIFIED", "maximum fee", "n/a — fee rate is 0");
      } else {
        add(uncapped ? "VERIFIED" : "FLAGGED", "maximum fee",
          uncapped ? "uncapped (true % at every size)" : cur.maximumFee.toString(),
          uncapped ? undefined : "CAPPED — large trades pay far less than the headline rate");
      }

      add(isNull(fee.transferFeeConfigAuthority) ? "VERIFIED" : "FLAGGED",
        "fee rate authority",
        isNull(fee.transferFeeConfigAuthority) ? "revoked" : fee.transferFeeConfigAuthority!.toBase58(),
        isNull(fee.transferFeeConfigAuthority) ? "rate locked forever" : "CAN RAISE THE FEE TOWARD 100%");

      // Distinct from the rate authority. Most checklists omit it entirely.
      add(isNull(fee.withdrawWithheldAuthority) ? "VERIFIED" : "INFO",
        "withheld-fee authority",
        isNull(fee.withdrawWithheldAuthority) ? "revoked" : fee.withdrawWithheldAuthority!.toBase58(),
        isNull(fee.withdrawWithheldAuthority)
          ? "collected fees are unclaimable by anyone"
          : "can take accumulated fees — CANNOT touch holder balances or the rate");

      add("INFO", "fees withheld on mint", fmt(fee.withheldAmount, info.decimals));
      add("INFO", "holders can close accounts",
        bps > 0 ? "NO — any non-zero fee blocks CloseAccount" : "yes",
        bps > 0 ? "AccountHasWithheldTransferFees; needs a harvest-then-close flow" : undefined);
    }

    // ---- the extensions nobody checks -------------------------------------
    let permDelegate: PublicKey | null = null;
    try { permDelegate = getPermanentDelegate(info)?.delegate ?? null; } catch { /* absent */ }
    add(isNull(permDelegate) ? "VERIFIED" : "FLAGGED", "permanent delegate",
      isNull(permDelegate) ? "none" : permDelegate!.toBase58(),
      isNull(permDelegate) ? undefined
        : "CAN TRANSFER OR BURN ANY HOLDER'S TOKENS WITHOUT THEIR SIGNATURE");

    let frozenByDefault = false;
    try { frozenByDefault = getDefaultAccountState(info)?.state === AccountState.Frozen; } catch { /* absent */ }
    add(frozenByDefault ? "FLAGGED" : "VERIFIED", "default account state",
      frozenByDefault ? "FROZEN" : "initialized",
      frozenByDefault
        ? "new buyers' accounts are unusable until an authority thaws them"
        : undefined);

    let hook: PublicKey | null = null;
    try { hook = getTransferHook(info)?.programId ?? null; } catch { /* absent */ }
    add(isNull(hook) ? "VERIFIED" : "FLAGGED", "transfer hook",
      isNull(hook) ? "none" : hook!.toBase58(),
      isNull(hook) ? undefined : "ARBITRARY CODE RUNS ON EVERY TRANSFER — can block transfers");

    let closeAuth: PublicKey | null = null;
    try { closeAuth = getMintCloseAuthority(info)?.closeAuthority ?? null; } catch { /* absent */ }
    add(isNull(closeAuth) ? "VERIFIED" : "FLAGGED", "mint close authority",
      isNull(closeAuth) ? "none" : closeAuth!.toBase58(),
      isNull(closeAuth) ? undefined : "the mint account itself can be closed");

    // ---- identity ---------------------------------------------------------
    const ptr = getMetadataPointerState(info);
    const md = await getTokenMetadata(conn, mint, "confirmed", prog);
    if (md) {
      add("INFO", "name / symbol", `${md.name} / ${md.symbol}`);
      const cls = classifyUri(md.uri);
      add(cls.ok ? "VERIFIED" : "FLAGGED", "metadata URI", `${cls.kind}`,
        cls.ok
          ? "content cannot be changed by anyone"
          : `${md.uri} — revoking the metadata authority locks the POINTER, not the CONTENT. ` +
            `If this domain lapses, whoever buys it controls what every wallet displays.`);
      add(isNull(md.updateAuthority) ? "VERIFIED" : "INFO", "metadata authority",
        isNull(md.updateAuthority) ? "revoked" : md.updateAuthority!.toBase58(),
        isNull(md.updateAuthority) ? undefined : "name/symbol/uri can still change — rebrand vector, not a rug vector");
      add(isNull(ptr?.authority) ? "VERIFIED" : "INFO", "metadata pointer authority",
        isNull(ptr?.authority) ? "revoked" : ptr!.authority!.toBase58(),
        isNull(ptr?.authority) ? undefined : "metadata can be repointed elsewhere");
      for (const [k, v] of md.additionalMetadata ?? []) add("INFO", `field: ${k}`, v);
    } else {
      add("INFO", "metadata", "none found via Token-2022 metadata extension");
    }
  }

  // Accounts we can identify by role, so the holder section does not report pool liquidity
  // or a burn address as if it were a whale.
  const known = new Map<string, string>();

  // ---- Raydium CPMM pool --------------------------------------------------
  if (opts.poolId) {
    const poolId = opts.poolId;
    if (!opts.decodePool) {
      // Rule 5: say we could not check, never omit the row.
      add("FLAGGED", "pool", "NOT CHECKED — no pool decoder available in this build",
        "Run the CLI grader with --pool to include liquidity and LP-burn checks.");
    } else {
      const pAcct = await conn.getAccountInfo(poolId, "confirmed");
      if (!pAcct) {
        add("INFO", "pool", `no account at ${poolId.toBase58()}`);
      } else {
        const s = opts.decodePool(pAcct.data);

        // Raydium canonically SORTS the mint pair, so the vault that holds the token being
        // graded is whichever side matches — never assume vaultA. Getting this backwards
        // inverts every price the grader prints.
        const aIsGraded = new PublicKey(s.mintA).equals(mint);
        const gradedVault = aIsGraded ? s.vaultA : s.vaultB;
        const quoteVault = aIsGraded ? s.vaultB : s.vaultA;
        const quoteMint = aIsGraded ? s.mintB : s.mintA;
        const quoteDec = aIsGraded ? s.mintDecimalB : s.mintDecimalA;

        const gv = await conn.getTokenAccountBalance(new PublicKey(gradedVault));
        const qv = await conn.getTokenAccountBalance(new PublicKey(quoteVault));

        add("INFO", "pool id", poolId.toBase58());
        add("INFO", "pool pair", `${mint.toBase58().slice(0, 8)}… / ${new PublicKey(quoteMint).toBase58().slice(0, 8)}…`);

        // LP supply zero means the tokens were destroyed and no claim exists. A non-zero
        // supply held somewhere is NOT the same as burned — on some venues "permanently
        // locked" liquidity still pays claimable fees to a pre-assignable address.
        const lpMint = new PublicKey(s.mintLp);
        const lp = await getMint(conn, lpMint, "confirmed", TOKEN_PROGRAM_ID);
        const burned = lp.supply === 0n;
        add(burned ? "VERIFIED" : "FLAGGED", "LP token supply",
          burned ? "0 — burned" : lp.supply.toString(),
          burned
            ? "liquidity is permanently unwithdrawable by anyone, including the team"
            : "LP TOKENS STILL EXIST — whoever holds them can withdraw the liquidity. " +
              "'Locked' is not 'burned': locked LP can still pay claimable fees to an assignable address.");

        // The LP mint authority is the pool's own PDA on every AMM. That is how deposits
        // and withdrawals work. Flagging it would be a false positive.
        add("INFO", "LP mint authority",
          lp.mintAuthority?.toBase58() ?? "null",
          "expected to be the pool PDA on any AMM — not a rug vector");

        const openTime = Number(s.openTime);
        const nowSec = Math.floor(nowMs() / 1000);
        add("INFO", "trading opens",
          openTime === 0 ? "immediately (open_time = 0)"
            : `${new Date(openTime * 1000).toISOString()} (${nowSec >= openTime ? "OPEN NOW" : `${openTime - nowSec}s away`})`,
          openTime > nowSec
            ? "pool is published but untradeable — configuration is final and auditable before anyone can act on it"
            : undefined);

        // Price MUST come from post-fee vault balances. A fee-on-transfer mint means the
        // pool received less than was sent, so any price computed from the seeded amounts
        // is wrong and publicly falsifiable.
        const gradedUi = Number(gv.value.amount) / 10 ** info.decimals;
        const quoteUi = Number(qv.value.amount) / 10 ** quoteDec;
        add("INFO", "pool reserves",
          `${gradedUi.toLocaleString()} graded / ${quoteUi.toLocaleString()} quote`);
        add("INFO", "price (from vaults)",
          gradedUi > 0 ? `${(quoteUi / gradedUi).toExponential(6)} quote per token` : "n/a",
          "derived from actual post-fee vault balances, not from seeded amounts");
        add("INFO", "pool status bits", String(s.status));
        known.set(String(gradedVault), "pool liquidity");
        known.set(String(quoteVault), "pool liquidity (quote)");
      }
    }
  }

  // ---- holder concentration ------------------------------------------------
  // The row buyers most want and least often get. Under a pro-rata sale this is the ONLY
  // remaining amplifier of first-mover value: a holder with 0.5% selling first is noise, a
  // holder with 30% selling first is an event.
  //
  // Hard limit, stated in the cannot-verify list rather than hidden: this measures
  // ADDRESSES, not people. One person holding 300 wallets reports as perfect distribution.
  try {
    // getTokenLargestAccounts is a heavy RPC call and public endpoints 429 on it routinely.
    // Retry with backoff rather than reporting "unavailable" on the first refusal — a
    // missing concentration row reads as "we checked and it was fine", the opposite of true.
    let largest: Awaited<ReturnType<typeof conn.getTokenLargestAccounts>> | undefined;
    for (let i = 0; i < 4; i++) {
      try { largest = await conn.getTokenLargestAccounts(mint, "confirmed"); break; }
      catch (e) {
        if (i === 3) throw e;
        await new Promise((r) => setTimeout(r, 800 * 2 ** i));
      }
    }
    if (!largest) throw new Error("no response after retries");
    const accts = largest.value.filter((a) => BigInt(a.amount) > 0n);

    if (accts.length === 0) {
      add("INFO", "holder concentration", "no token accounts hold a balance");
    } else {
      // Resolve owners so we report wallets, not token-account addresses.
      const parsed = await conn.getMultipleParsedAccounts(
        accts.map((a) => a.address), { commitment: "confirmed" },
      );
      const owners = parsed.value.map((v: any) => v?.data?.parsed?.info?.owner as string | undefined);

      const supply = info.supply;
      const pct = (v: bigint) => supply > 0n ? Number((v * 10000n) / supply) / 100 : 0;

      const rows_ = accts.map((a, i) => ({
        acct: a.address.toBase58(),
        owner: owners[i],
        amt: BigInt(a.amount),
        role: known.get(a.address.toBase58()),
      }));

      const nonPool = rows_.filter((r) => !r.role);
      const poolHeld = rows_.filter((r) => r.role).reduce((s, r) => s + r.amt, 0n);

      const top1 = nonPool[0]?.amt ?? 0n;
      const top5 = nonPool.slice(0, 5).reduce((s, r) => s + r.amt, 0n);
      const top10 = nonPool.slice(0, 10).reduce((s, r) => s + r.amt, 0n);

      add(pct(top1) >= 20 ? "FLAGGED" : "INFO", "largest single holder",
        `${pct(top1).toFixed(2)}% of supply`,
        pct(top1) >= 20
          ? `one address can move the price alone — ${nonPool[0]?.owner ?? nonPool[0]?.acct}`
          : undefined);

      // The note names the REAL number of addresses, not "five". On a pre-distribution
      // token there is often exactly one holder, and "sits in five addresses" then states a
      // count that does not exist — small, but this report's credibility rests on never
      // saying more than it read.
      const n5 = Math.min(5, nonPool.length);
      add(pct(top5) >= 50 ? "FLAGGED" : "INFO", "top 5 holders",
        `${pct(top5).toFixed(2)}% of supply`,
        pct(top5) >= 50
          ? `majority of supply sits in ${n5} address${n5 === 1 ? "" : "es"}`
          : undefined);

      add("INFO", "top 10 holders", `${pct(top10).toFixed(2)}% of supply`);
      if (poolHeld > 0n)
        add("INFO", "in pool liquidity", `${pct(poolHeld).toFixed(2)}% of supply`,
          "excluded from the concentration figures above — it is liquidity, not a holder");

      add("INFO", "holders sampled", `${accts.length} largest accounts (RPC returns at most 20)`,
        "not a full holder count — small holders are invisible to this method");
    }
  } catch (e) {
    // Public RPCs refuse getTokenLargestAccounts to anonymous callers — verified 429 on both
    // api.devnet and api.mainnet-beta, even with backoff. Say so plainly: a vague failure
    // here reads as "checked, nothing found", the exact false reassurance this tool prevents.
    const rateLimited = /429|Too Many Requests|rate/i.test((e as Error).message);
    add("FLAGGED", "holder concentration",
      rateLimited ? "NOT CHECKED — RPC refused the request" : "NOT CHECKED — RPC error",
      rateLimited
        ? "Public endpoints do not serve getTokenLargestAccounts. Re-run with " +
          "--rpc <your-endpoint> (Helius/Triton/QuickNode free tiers all work). " +
          "This row is UNKNOWN, not clean — do not read its absence as safe."
        : (e as Error).message.slice(0, 120));
  }

  // ---- program upgrade authority ------------------------------------------
  // For any launch that ships its own program (a sale, a vesting contract, a staking pool).
  // Every safety argument about that program's code assumes the DEPLOYED BYTECODE is the
  // bytecode that was reviewed. An upgrade authority can replace all of it in one
  // transaction — including the refund path — while the program holds user funds.
  if (opts.programId) {
    const pid = opts.programId;
    const pAcct = await conn.getAccountInfo(pid, "confirmed");
    if (!pAcct) {
      add("INFO", "program", `no account at ${pid.toBase58()}`);
    } else if (!pAcct.executable) {
      add("FLAGGED", "program", "account is not executable", "this address is not a program");
    } else {
      const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111";
      if (pAcct.owner.toBase58() !== LOADER_V3) {
        // Loaded by a non-upgradeable loader: the bytecode is frozen by the loader itself,
        // which is the strongest possible state.
        add("VERIFIED", "program upgradeable", "no — non-upgradeable loader",
          `owner ${pAcct.owner.toBase58()} — bytecode cannot be replaced`);
      } else {
        // Program account = 4-byte enum + 32-byte ProgramData address.
        const pdAddr = new PublicKey(pAcct.data.subarray(4, 36));
        const pd = await conn.getAccountInfo(pdAddr, "confirmed");
        if (!pd) {
          add("INFO", "program upgradeable", "ProgramData account not found");
        } else {
          // ProgramData = 4-byte enum + 8-byte slot + 1-byte Option + 32-byte authority.
          const hasAuth = pd.data[12] === 1;
          const auth = hasAuth ? new PublicKey(pd.data.subarray(13, 45)) : null;
          add(hasAuth ? "FLAGGED" : "VERIFIED", "program upgradeable",
            hasAuth ? `YES — ${auth!.toBase58()}` : "no — authority revoked (immutable)",
            hasAuth
              ? "this key can replace the entire program in one transaction, including any " +
                "refund or withdrawal path, while the program holds user funds. Every safety " +
                "claim about this code is really a claim about trusting that key."
              : "deployed bytecode is frozen — what was audited is what runs");
          add("INFO", "last deployed slot", String(new DataView(
            pd.data.buffer, pd.data.byteOffset + 4, 8).getBigUint64(0, true)));
        }
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Rendering — shared by the CLI's --html flag and the web page
// ---------------------------------------------------------------------------

export const REPORT_CSS = `
:root{--bg:#fff;--fg:#111;--mut:#666;--line:#e5e5e5;--bad:#b3261e;--good:#186a3b;--card:#fafafa}
@media(prefers-color-scheme:dark){:root{--bg:#0e0e10;--fg:#eee;--mut:#999;--line:#2a2a2e;--bad:#f2b8b5;--good:#7ddba3;--card:#161619}}
*{box-sizing:border-box}body{margin:0;padding:2rem 1rem;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:820px;margin:0 auto}
h1{font-size:1.25rem;margin:0 0 .25rem;font-weight:650}
.addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;color:var(--mut);word-break:break-all}
.summary{margin:1.25rem 0;padding:.9rem 1rem;border-radius:10px;background:var(--card);border:1px solid var(--line)}
h2{font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;margin:1.75rem 0 .5rem;color:var(--mut);font-weight:650}
h2 .n{opacity:.6;font-weight:400}
.row{display:grid;grid-template-columns:minmax(150px,210px) 1fr;gap:.75rem;padding:.6rem 0;border-top:1px solid var(--line)}
@media(max-width:560px){.row{grid-template-columns:1fr;gap:.15rem}}
.k{color:var(--mut);font-size:.86rem}
.v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86rem;word-break:break-all}
.note{font-family:inherit;font-size:.84rem;color:var(--mut);margin-top:.3rem;line-height:1.45}
.flagged .v{color:var(--bad)}.verified .v{color:var(--good)}
ul{padding-left:1.1rem;margin:.4rem 0}li{margin:.3rem 0;color:var(--mut);font-size:.88rem}
footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--mut);font-size:.8rem}
`;

export const esc = (x: string) =>
  x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** The report body — everything inside .wrap. Shared by --html and the web page. */
export function renderReportBody(mintAddr: string, cluster: string, rows: Row[]): string {
  const sect = (title: string, level: Level, tone: string) => {
    const rs = rows.filter((r) => r.level === level);
    if (!rs.length) return "";
    return `<section class="${tone}"><h2>${esc(title)} <span class="n">${rs.length}</span></h2>` +
      rs.map((r) => `<div class="row"><div class="k">${esc(r.k ?? r.key)}</div>` +
        `<div class="v">${esc(r.value)}` +
        (r.note ? `<div class="note">${esc(r.note)}</div>` : "") + `</div></div>`).join("") +
      `</section>`;
  };
  const flaggedN = rows.filter((r) => r.level === "FLAGGED").length;
  return `<h1>Launch report</h1>
<div class="addr">${esc(mintAddr)} &middot; ${esc(cluster)}</div>
<div class="summary">${flaggedN === 0
    ? "<strong>No flagged risks</strong> in what can be read on chain. That is <em>not</em> the same as safe — see the bottom section."
    : `<strong>${flaggedN} flagged risk${flaggedN > 1 ? "s" : ""}.</strong> Read them individually; some may be deliberate and disclosed by the team.`}</div>
${sect("Flagged", "FLAGGED", "flagged")}
${sect("Verified", "VERIFIED", "verified")}
${sect("Facts (no judgement)", "INFO", "info")}
<h2>Cannot be verified on chain, by anyone</h2>
<ul>${CANNOT_VERIFY.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
<footer>Generated by the AntiRugDex grader from on-chain state only — no third-party APIs.
A check that could not run is reported as flagged, never omitted.</footer>`;
}

/** A complete standalone HTML document, for the CLI's --html flag. */
export function renderReportHtml(mintAddr: string, cluster: string, rows: Row[]): string {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Launch report — ${esc(mintAddr.slice(0, 8))}…</title>
<style>${REPORT_CSS}</style>
<div class="wrap">
${renderReportBody(mintAddr, cluster, rows)}
</div>`;
}
