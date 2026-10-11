/**
 * A thin client for the sale program, driven by the generated IDL at runtime.
 *
 * The project's first rule is "read chain, never config" — a verifier that quotes a
 * constant is not a verifier. The same idea applies here: this file does not restate the
 * program's account ordering, discriminators, seeds or constants. It reads them out of
 * `idl/sale.json`, which `anchor build` generates from the Rust. Get the order of `claim`'s
 * eleven accounts wrong by hand and the failure is an opaque constraint error; derive it
 * from the IDL and it cannot be wrong.
 *
 * `@coral-xyz/anchor` would do this too, but it is a large dependency whose TS package
 * version has to agree with an anchor-cli 1.x IDL, and the program only has nine
 * instructions with almost no arguments. This is the smaller, auditable option.
 *
 * ⚠️ **The IDL can go stale and nothing else will notice.** `cargo build-sbf` does NOT
 * emit one — only `anchor build` does. On 2026-08-08 `target/idl/sale.json` was still the
 * Anchor counter-template scaffold, describing an `initialize` instruction that did not
 * exist, a day after the real program was written. Run `npm run sync-idl` after any
 * instruction or state change. `assertIdlMatchesChain` is the backstop.
 */

import {
  AccountMeta,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// IDL
// ---------------------------------------------------------------------------

export type IdlType = string | { defined: { name: string } } | Record<string, unknown>;

interface IdlField {
  name: string;
  type: IdlType;
}
interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
}
interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccountItem[];
  args: IdlField[];
}
interface Idl {
  address: string;
  metadata: { name: string; spec: string };
  instructions: IdlInstruction[];
  accounts: { name: string; discriminator: number[] }[];
  types: { name: string; type: { kind: string; fields?: IdlField[]; variants?: { name: string }[] } }[];
  constants: { name: string; type: string; value: string }[];
  errors: { code: number; name: string; msg: string }[];
}

export const IDL_PATH =
  process.env.SALE_IDL_PATH ?? path.join(process.cwd(), "idl", "sale.json");

let cached: Idl | undefined;

export function idl(): Idl {
  if (cached) return cached;
  if (!fs.existsSync(IDL_PATH))
    throw new Error(
      `No IDL at ${IDL_PATH}.\n` +
        `  Run: npm run sync-idl   (copies it out of the WSL Anchor workspace)\n` +
        `  If that fails, the IDL has never been generated: cargo build-sbf does not\n` +
        `  emit one. Run anchor-build-devnet.sh inside WSL first.`,
    );
  const parsed = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as Idl;
  // A scaffold IDL parses perfectly and describes the wrong program. Name the symptom.
  if (!parsed.instructions?.some((i) => i.name === "initialize_sale"))
    throw new Error(
      `${IDL_PATH} has no initialize_sale instruction — this is the Anchor template\n` +
        `  scaffold, not the sale program. Regenerate with anchor-build-devnet.sh.`,
    );
  cached = parsed;
  return parsed;
}

export function programId(): PublicKey {
  return new PublicKey(idl().address);
}

/** A constant as declared in the Rust, not re-typed here. */
export function idlConstant(name: string): string {
  const c = idl().constants.find((x) => x.name === name);
  if (!c) throw new Error(`IDL has no constant ${name}`);
  return c.value;
}

export function jitoMarker(): PublicKey {
  return new PublicKey(idlConstant("JITO_DONT_FRONT"));
}

/** Seed constants are emitted as a JS-array literal string, e.g. "[115, 97, 108, 101]". */
function seed(name: string): Buffer {
  return Buffer.from(JSON.parse(idlConstant(name)) as number[]);
}

/** Maps a program error code back to its name, so failures are readable. */
export function errorName(code: number): string | undefined {
  return idl().errors.find((e) => e.code === code)?.name;
}

/**
 * The one check that catches a stale IDL: the program it describes must be the program
 * that is actually deployed, and that program must exist and be executable.
 *
 * It cannot catch an IDL that is stale in its *instructions* while keeping the same
 * address — which is exactly the failure that happened on 2026-08-08 — so `npm run
 * sync-idl` after every build remains the real defence.
 */
export async function assertIdlMatchesChain(conn: Connection): Promise<void> {
  const id = programId();
  const info = await conn.getAccountInfo(id);
  if (!info)
    throw new Error(
      `The IDL names program ${id.toBase58()}, which does not exist on this cluster.\n` +
        `  Deploy it first (deploy-devnet.sh in the WSL workspace), or you are pointed\n` +
        `  at the wrong cluster.`,
    );
  if (!info.executable)
    throw new Error(`${id.toBase58()} exists but is not executable.`);
}

// ---------------------------------------------------------------------------
// PDAs — seeds come from the IDL constants, never retyped
// ---------------------------------------------------------------------------

export function salePda(tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seed("SALE_SEED"), tokenMint.toBuffer()],
    programId(),
  );
}

export function solVaultPda(sale: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seed("SOL_VAULT_SEED"), sale.toBuffer()],
    programId(),
  );
}

export function commitPda(sale: PublicKey, bidder: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seed("COMMIT_SEED"), sale.toBuffer(), bidder.toBuffer()],
    programId(),
  );
}

// ---------------------------------------------------------------------------
// Borsh — only the primitives this program actually uses
// ---------------------------------------------------------------------------

class Reader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}
  u8(): number {
    return this.buf.readUInt8(this.off++);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.off);
    this.off += 8;
    return v;
  }
  pubkey(): PublicKey {
    const v = new PublicKey(this.buf.subarray(this.off, this.off + 32));
    this.off += 32;
    return v;
  }
  skip(n: number) {
    this.off += n;
  }
}

function typeName(t: IdlType): string {
  if (typeof t === "string") return t;
  const d = (t as { defined?: { name: string } }).defined;
  if (d) return `defined:${d.name}`;
  throw new Error(`Unsupported IDL type: ${JSON.stringify(t)}`);
}

/**
 * Decodes an account by walking the IDL's field list, so a field added in Rust appears
 * here the moment the IDL is re-synced. Hardcoded byte offsets would silently misread
 * every field after an insertion — and this program's `Sale` layout changed twice in one
 * day while it was being built.
 */
function decodeStruct(name: string, r: Reader): Record<string, unknown> {
  const t = idl().types.find((x) => x.name === name);
  if (!t?.type.fields) throw new Error(`IDL has no struct ${name}`);
  const out: Record<string, unknown> = {};
  for (const f of t.type.fields) {
    const tn = typeName(f.type);
    switch (tn) {
      case "pubkey":
        out[f.name] = r.pubkey();
        break;
      case "u64":
        out[f.name] = r.u64();
        break;
      case "i64":
        out[f.name] = r.i64();
        break;
      case "u16":
        out[f.name] = r.u16();
        break;
      case "u8":
        out[f.name] = r.u8();
        break;
      case "bool":
        out[f.name] = r.bool();
        break;
      default: {
        if (!tn.startsWith("defined:")) throw new Error(`Unhandled field type ${tn}`);
        const inner = idl().types.find((x) => x.name === tn.slice("defined:".length));
        if (inner?.type.kind !== "enum")
          throw new Error(`Only fieldless enums are supported, not ${tn}`);
        // A fieldless Borsh enum is a single u8 variant index.
        out[f.name] = inner.type.variants![r.u8()].name;
      }
    }
  }
  return out;
}

function accountDiscriminator(name: string): Buffer {
  const a = idl().accounts.find((x) => x.name === name);
  if (!a) throw new Error(`IDL has no account ${name}`);
  return Buffer.from(a.discriminator);
}

async function fetchAccount<T>(
  conn: Connection,
  address: PublicKey,
  name: string,
): Promise<T | undefined> {
  const info = await conn.getAccountInfo(address);
  if (!info) return undefined;
  if (!info.owner.equals(programId()))
    throw new Error(
      `${address.toBase58()} is not owned by the sale program (owner ${info.owner.toBase58()}).`,
    );
  const disc = accountDiscriminator(name);
  if (!info.data.subarray(0, 8).equals(disc))
    throw new Error(
      `${address.toBase58()} is not a ${name}: discriminator mismatch.\n` +
        `  If the program was redeployed after a state change, re-run npm run sync-idl.`,
    );
  const r = new Reader(info.data);
  r.skip(8);
  return decodeStruct(name, r) as T;
}

export interface Sale {
  authority: PublicKey;
  token_mint: PublicKey;
  token_vault: PublicKey;
  sol_vault: PublicKey;
  seed_destination: PublicKey;
  price_lamports: bigint;
  supply_for_sale: bigint;
  hard_cap_lamports: bigint;
  floor_lamports: bigint;
  min_bid_lamports: bigint;
  total_committed: bigint;
  total_claimed_tokens: bigint;
  total_accepted_lamports: bigint;
  claim_count: bigint;
  commitment_count: bigint;
  open_ts: bigint;
  close_ts: bigint;
  absolute_deadline: bigint;
  pool_deadline: bigint;
  extension_count: number;
  status: "Bidding" | "Succeeded" | "Failed";
  pool_created: boolean;
  total_swept_lamports: bigint;
  unsold_burned: boolean;
  pool: PublicKey;
  pool_open_time: bigint;
  decimals: number;
  bump: number;
  sol_vault_bump: number;
}

export interface Commitment {
  sale: PublicKey;
  bidder: PublicKey;
  amount: bigint;
  tokens_claimed: bigint;
  lamports_refunded: bigint;
  claimed: boolean;
  bump: number;
}

export function fetchSale(conn: Connection, address: PublicKey) {
  return fetchAccount<Sale>(conn, address, "Sale");
}

export function fetchCommitment(conn: Connection, address: PublicKey) {
  return fetchAccount<Commitment>(conn, address, "Commitment");
}

// ---------------------------------------------------------------------------
// Instruction building
// ---------------------------------------------------------------------------

class Writer {
  private parts: Buffer[] = [];
  u64(v: bigint | number): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    this.parts.push(b);
    return this;
  }
  i64(v: bigint | number): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v));
    this.parts.push(b);
    return this;
  }
  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/**
 * Builds an instruction from the IDL: the account list order, and each account's writable
 * and signer flags, come straight from the generated artifact.
 *
 * Accounts the IDL pins to a fixed address (the system program, the instructions sysvar,
 * the `jitodontfront` marker) are filled in automatically, so callers only supply the ones
 * that actually vary. Anything still missing is named explicitly rather than producing a
 * runtime constraint error nobody can read.
 */
export function buildIx(
  name: string,
  accounts: Record<string, PublicKey>,
  data: Buffer = Buffer.alloc(0),
): TransactionInstruction {
  const ix = idl().instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`IDL has no instruction ${name}`);

  const keys: AccountMeta[] = ix.accounts.map((a) => {
    const supplied = accounts[a.name];
    const pinned = a.address ? new PublicKey(a.address) : undefined;
    const pubkey = supplied ?? pinned;
    if (!pubkey)
      throw new Error(
        `Instruction ${name} needs account "${a.name}" and none was supplied.\n` +
          `  Expected order: ${ix.accounts.map((x) => x.name).join(", ")}`,
      );
    if (supplied && pinned && !supplied.equals(pinned))
      throw new Error(
        `Instruction ${name}: account "${a.name}" is pinned to ${pinned.toBase58()} ` +
          `but ${supplied.toBase58()} was supplied.`,
      );
    return { pubkey, isWritable: a.writable === true, isSigner: a.signer === true };
  });

  return new TransactionInstruction({
    programId: programId(),
    keys,
    data: Buffer.concat([Buffer.from(ix.discriminator), data]),
  });
}

export interface SaleParams {
  price_lamports: bigint;
  supply_for_sale: bigint;
  hard_cap_lamports: bigint;
  floor_lamports: bigint;
  min_bid_lamports: bigint;
  close_ts: bigint;
  absolute_deadline: bigint;
  pool_deadline: bigint;
}

/** Field order follows the IDL's own `SaleParams` definition rather than this file. */
export function encodeSaleParams(p: SaleParams): Buffer {
  const t = idl().types.find((x) => x.name === "SaleParams");
  if (!t?.type.fields) throw new Error("IDL has no SaleParams");
  const w = new Writer();
  for (const f of t.type.fields) {
    const v = (p as unknown as Record<string, bigint>)[f.name];
    if (v === undefined) throw new Error(`SaleParams is missing ${f.name}`);
    typeName(f.type) === "i64" ? w.i64(v) : w.u64(v);
  }
  return w.build();
}

export function encodeU64(v: bigint | number): Buffer {
  return new Writer().u64(v).build();
}

export const SYSTEM_PROGRAM = SystemProgram.programId;
