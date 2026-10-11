/**
 * Single source of truth for the token. Change it HERE, nowhere else.
 * Every value below is baked into the mint at creation and most are
 * irreversible once 05-lock-down.ts runs.
 */
export const TOKEN = {
  name: "AntiRugDex",
  symbol: "ARD",

  // Off-chain JSON, on Arweave — content-addressed, so the URL is derived from
  // the file's own bytes and cannot resolve to anything else. Confirmed
  // 2026-08-10: data item qrkpjUD2… in bundle ZeLE1BZC…, mined into Arweave
  // block 1,977,494, served bytes sha256-identical to metadata.json.
  //
  // Why this had to move off antirugdex.com: revoking the metadata authority
  // locks the POINTER, not the CONTENT. While this was an HTTPS URL on a domain
  // we rent, whoever controlled the domain controlled what every wallet and
  // explorer displayed for ARD — forever, including after a lapse or a lost
  // Cloudflare account. "Metadata immutable" is close to worthless against an
  // HTTPS pointer, and it is a grader row we were failing ourselves.
  //
  // The image inside this JSON is on Arweave too (Uxq3lWki…). Order mattered:
  // permanent metadata pointing at a mutable image is half a fix.
  //
  // Changing this affects the NEXT mint only. grade.ts reads the URI off the
  // mint account on chain, so mints created before this keep the old URL.
  // Verify any change with: npx tsx src/_arweave-verify.ts
  uri: "https://arweave.net/qrkpjUD2wcssICS3-KfYtRIPA9deUQGlSkFgWOrFtwA",

  decimals: 9,
  totalSupply: 1_000_000_000n, // whole tokens, before decimals

  /**
   * The tax. 25 bps = 0.25%. Applied by the Token-2022 program to EVERY
   * transfer of this mint — buys, sells, LP seeding, wallet-to-wallet.
   * There is no whitelist (see README).
   *
   * Reduced from 100 bps on 2026-08-06. At 1% the fee taxed vault funding,
   * pool seeding and every payout; suppressed the trading volume it was
   * taxing; and made arriving with 100 wallets ~2000x cheaper than splitting
   * an allocation afterwards. 25 bps is near a normal DEX fee tier.
   *
   * What the reduction does NOT fix, at any non-zero rate:
   *   - Holders still cannot close their token accounts. Any fee leaves a
   *     withheld balance and CloseAccount fails with
   *     AccountHasWithheldTransferFees. Ship a harvest-then-close flow;
   *     HarvestWithheldTokensToMint is permissionless so holders self-serve.
   *   - Lending markets and some routers reject fee-on-transfer mints
   *     categorically, not by rate.
   * Only a zero fee removes those. See GAMEPLAN.md D2.
   */
  feeBasisPoints: 25,

  /**
   * Per-transfer fee ceiling in base units. u64::MAX = uncapped, which is
   * what makes it a true 0.25% at every trade size. A low cap here is a
   * classic soft-rug tell (whales pay ~0%), so leave it uncapped — it is
   * also a row our own grader flags.
   */
  maximumFee: (1n << 64n) - 1n,
} as const;

/**
 * Extra keys written into the on-chain metadata, visible in every explorer.
 *
 * These do NOT go in via InitializeMetadata — that instruction only carries
 * name/symbol/uri. 01 writes each pair with a separate UpdateField
 * instruction in the same transaction.
 *
 * Nothing here may assert a state that is not yet true. "fee authority
 * revoked" belongs in 05, after the revoke actually lands — on an anti-rug
 * token, on-chain metadata that is false for even a few minutes is precisely
 * what someone screenshots.
 */
export const ADDITIONAL_METADATA: [string, string][] = [
  ["website", "https://antirugdex.com"],
  ["transfer_fee_bps", String(TOKEN.feeBasisPoints)],
];

/** Written by 05-lock-down.ts, only once the revoke has succeeded. */
export const POST_LOCK_METADATA: [string, string][] = [
  ["fee_authority", "revoked"],
];
