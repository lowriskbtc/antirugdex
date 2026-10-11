/**
 * Token-2022 mint construction, with NO environment access — no `process`, no `fs`, no
 * `lib.js`. Extracted from 01-create-mint.ts on 2026-08-11 so the CLI and the browser
 * launcher build the SAME instructions.
 *
 * Same rule as grade-core.ts: if you change what a launch deploys, change it HERE. A second
 * implementation is a second set of authorities to get wrong, and every value below is
 * frozen at creation — `withdrawWithheldAuthority` can never be changed by any instruction,
 * ever, so a launcher that diverges from the CLI is a launcher that can permanently strand
 * a token's fees.
 *
 * WHAT THE RESULTING MINT LOOKS LIKE, and why:
 *   mintAuthority         revoked in tx2, same transaction as the mint-to, so there is no
 *                         window in which supply could be inflated
 *   freezeAuthority       NEVER SET — this is the honeypot vector
 *   transferFeeConfig     the payer; 05-lock-down.ts revokes it later
 *   withdrawWithheld      the treasury; FIXED AT CREATION, unchangeable afterwards
 *   metadataUpdate        the payer; 05 can revoke it
 */
import {
  PublicKey, SystemProgram, TransactionInstruction, Connection,
} from "@solana/web3.js";
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, TYPE_SIZE, LENGTH_SIZE,
  getMintLen, getAssociatedTokenAddressSync, AuthorityType,
  createInitializeTransferFeeConfigInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
} from "@solana/spl-token";
import {
  createInitializeInstruction, createUpdateFieldInstruction, pack, type TokenMetadata,
} from "@solana/spl-token-metadata";

export interface MintParams {
  name: string;
  symbol: string;
  uri: string;
  decimals: number;
  /** Whole tokens, before decimals. */
  totalSupply: bigint;
  feeBasisPoints: number;
  maximumFee: bigint;
  payer: PublicKey;
  /** Becomes withdrawWithheldAuthority. FIXED AT CREATION — no instruction can change it. */
  treasury: PublicKey;
  additionalMetadata: [string, string][];
  /**
   * Pairs that 05-lock-down.ts writes LATER. Included in rent sizing only, never written
   * here. `UpdateField`'s account list is [metadata, update_authority] — no payer, no system
   * program — so it cannot pull lamports to cover the account growing. Without this headroom
   * 05's write pushes the mint below rent-exemption and fails, taking the fee-authority
   * revoke down with it in the same transaction. Costs ~0.0002 SOL.
   */
  postLockMetadata: [string, string][];
}

export interface MintPlan {
  mint: PublicKey;
  ata: PublicKey;
  /** Base units. */
  supply: bigint;
  mintLen: number;
  metadataLen: number;
  rentLamports: number;
  uncapped: boolean;
}

export const UNCAPPED_FEE = (1n << 64n) - 1n;

/**
 * Sizes rent and derives addresses without building anything. Safe to call for a preview.
 *
 * The mint account is ALLOCATED at `mintLen` (fixed extensions only) but FUNDED for
 * `mintLen + metadataLen`; InitializeMetadata reallocs into that headroom. Underfund it and
 * the failure is opaque and lands at the last step.
 */
export async function planMint(
  conn: Connection,
  params: MintParams,
  mint: PublicKey,
): Promise<MintPlan> {
  const metadata: TokenMetadata = {
    mint,
    name: params.name,
    symbol: params.symbol,
    uri: params.uri,
    additionalMetadata: [...params.additionalMetadata, ...params.postLockMetadata],
  };
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const rentLamports = await conn.getMinimumBalanceForRentExemption(mintLen + metadataLen);

  return {
    mint,
    ata: getAssociatedTokenAddressSync(mint, params.payer, false, TOKEN_2022_PROGRAM_ID),
    supply: params.totalSupply * 10n ** BigInt(params.decimals),
    mintLen,
    metadataLen,
    rentLamports,
    uncapped: params.maximumFee === UNCAPPED_FEE,
  };
}

/**
 * TWO transactions, and they are SEQUENTIAL — not batchable and not signable together.
 *
 * Tx2's `createATA` and `mintTo` require the mint to already exist, so tx1 must be confirmed
 * before tx2 is signed. Do not ask a wallet to sign both up front: if tx1 fails you have
 * collected a signature for a transaction that can never apply, and if tx1 lands while tx2
 * does not you are left with **a mint that exists, holds no supply, and still has a live
 * mint authority** — recoverable, but only by someone holding the mint address.
 *
 * Tx1 additionally needs the generated mint keypair as a signer.
 */
export function buildMintTxs(
  params: MintParams,
  plan: MintPlan,
): { createIxs: TransactionInstruction[]; supplyIxs: TransactionInstruction[] } {
  const { mint, ata, supply, mintLen, rentLamports } = plan;

  const createIxs: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: params.payer,
      newAccountPubkey: mint,
      space: mintLen,          // NOT mintLen + metadataLen
      lamports: rentLamports,  // but funded for both
      programId: TOKEN_2022_PROGRAM_ID,
    }),

    // The tax. transferFeeConfigAuthority can later change the rate — 05 revokes it.
    // withdrawWithheldAuthority collects the tax; it is kept, and it is unchangeable.
    createInitializeTransferFeeConfigInstruction(
      mint,
      params.payer,     // transferFeeConfigAuthority -> revoked in 05
      params.treasury,  // withdrawWithheldAuthority  -> kept, FIXED AT CREATION
      params.feeBasisPoints,
      params.maximumFee,
      TOKEN_2022_PROGRAM_ID,
    ),

    // Points metadata at the mint itself — no Metaplex account needed.
    createInitializeMetadataPointerInstruction(
      mint, params.payer, mint, TOKEN_2022_PROGRAM_ID,
    ),

    createInitializeMintInstruction(
      mint,
      params.decimals,
      params.payer,  // mintAuthority -> revoked in tx2
      null,          // freezeAuthority -> NEVER set. This is the honeypot vector.
      TOKEN_2022_PROGRAM_ID,
    ),

    // Must come after InitializeMint. Carries ONLY name/symbol/uri — the instruction has no
    // additionalMetadata field, so extra pairs need their own UpdateField instructions
    // below. Silently dropping them is an easy bug to ship: rent is sized correctly either
    // way and the mint still succeeds.
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      updateAuthority: params.payer,
      mint,
      mintAuthority: params.payer,
      name: params.name,
      symbol: params.symbol,
      uri: params.uri,
    }),

    // Each pair reallocs the mint; rent above already covers it.
    //
    // This puts the transaction around 700 of the 1232-byte limit. If you add pairs or
    // lengthen the URI and this starts failing on size, the fix is moving these UpdateFields
    // into a second transaction — rent is funded either way, so nothing else changes.
    ...params.additionalMetadata.map(([field, value]) =>
      createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: params.payer,
        field,
        value,
      }),
    ),
  ];

  const supplyIxs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      params.payer, ata, params.payer, mint, TOKEN_2022_PROGRAM_ID,
    ),
    createMintToInstruction(mint, ata, params.payer, supply, [], TOKEN_2022_PROGRAM_ID),
    // Fixed supply, permanently. Same transaction as the mint-to so there is no window in
    // which the supply could be inflated.
    createSetAuthorityInstruction(
      mint, params.payer, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID,
    ),
  ];

  return { createIxs, supplyIxs };
}

/**
 * Validation shared by both front ends, so the browser cannot accept a shape the CLI would
 * reject. Returns human-readable problems; empty means OK.
 */
export function validateMintParams(p: {
  name: string; symbol: string; uri: string; decimals: number;
  totalSupply: bigint; feeBasisPoints: number;
}): string[] {
  const errs: string[] = [];
  if (!p.name.trim()) errs.push("Name is required.");
  if (!p.symbol.trim()) errs.push("Symbol is required.");
  if (p.name.length > 32) errs.push(`Name is ${p.name.length} chars; keep it under 32.`);
  if (p.symbol.length > 10) errs.push(`Symbol is ${p.symbol.length} chars; keep it under 10.`);
  if (!p.uri.trim()) errs.push("Metadata URI is required — it is baked into the mint at creation.");
  if (!Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 9)
    errs.push("Decimals must be a whole number from 0 to 9.");
  if (p.totalSupply <= 0n) errs.push("Total supply must be greater than zero.");
  // Token-2022 rejects above 10000, but the grader flags >500 as unusually high and this
  // project's own token is 25. Refusing outright would be a policy the CLI does not have.
  if (!Number.isInteger(p.feeBasisPoints) || p.feeBasisPoints < 0 || p.feeBasisPoints > 10000)
    errs.push("Transfer fee must be a whole number of basis points from 0 to 10000.");
  return errs;
}
