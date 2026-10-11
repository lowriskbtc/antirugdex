# AntiRugDex

[![CI](https://github.com/lowriskbtc/antirugdex/actions/workflows/ci.yml/badge.svg)](https://github.com/lowriskbtc/antirugdex/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-Anchor_1.1-000000?logo=rust&logoColor=white)
![Solana](https://img.shields.io/badge/Solana-devnet_verified-9945FF?logo=solana&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Verifiable token launches on Solana. AntiRugDex is a small launchpad built so that every promise a launch makes can be checked on chain: a Token-2022 fee token whose fee is locked, a one-shot sale program that seeds a Raydium pool and burns the LP, and a public grader that checks any mint against those rules.

| Part | Where | What it does |
|---|---|---|
| **ARD fee token** | `src/00-07` | Creates a Token-2022 mint with a 0.25% transfer fee, verifies it, harvests fees, and locks the authorities down |
| **Sale program** | `sale/` (Rust, Anchor 1.1) | One-shot fair sale: bids, finalize, pro-rata claims and refunds, proceeds sweep, pool marking. Undersubscribed and oversubscribed paths both proven on devnet |
| **Sale client** | `src/10-19`, `src/sale-client.ts` | Drives the sale end to end against the program's IDL (`idl/sale.json`) |
| **Website** | `site/` | Landing page, a devnet launcher, and a **grader** that rates any mint's rug risk from on-chain data |
| **Design notes** | `docs/` | The sale program's design, the anti-bundling design, and the devnet results write-ups |

**Status:** feature-complete and verified end to end on devnet (see `docs/RESULTS-2026-08-09.md`). The mainnet steps are in the token guide below under "Going to mainnet".

**Safety:** keypairs are never committed. The `.gitignore` blocks every wallet and program keypair, including `sale/target/deploy/sale-keypair.json` (the program's upgrade identity). Configure your own in `.env` (see `.env.example`).

## Development

```bash
npm ci
npm run typecheck        # TypeScript
npm run build:web        # rebuild site/grader.js and site/launcher.js
```

The Rust program builds and tests inside WSL or Linux with the Solana toolchain (`sale/run-tests.sh` runs `cargo build-sbf` then `cargo test`; the integration tests load the built program into LiteSVM). See `docs/TOOLCHAIN-2026-08-07.md`.

---

# ARD fee token guide

A Token-2022 mint with a **1% transfer fee that is locked on-chain and cannot be changed by anyone, including you.**

No program deploy, no Anchor, no Rust. The Token-2022 program is already on mainnet; you are just configuring a mint on top of it. Total mainnet cost is roughly **0.01 SOL** — the rest of your budget stays available for liquidity and the launchpad itself.

---

## The one thing to decide before you spend anything

On Solana, a buy/sell tax means **Token-2022 + the TransferFee extension**. There is no other way. That choice determines where your token can trade:

| Venue | Token-2022 transfer fee |
|---|---|
| Raydium **CPMM** (Standard AMM) | Supported |
| Meteora **DAMM v2** | Supported, permissionless |
| Orca Whirlpools | Supported |
| Jupiter routing | Routes it, flags the fee in the UI |
| Raydium **AMM v4** | **Not supported** |
| pump.fun bonding curve | **Not available** — it mints its own token, you can't bring your own |

**So the default memecoin launch path is closed to you.** You are seeding your own pool on Raydium CPMM or Meteora DAMM v2. That is a real decision, not a detail — make it now rather than after the mint exists.

Many CEXs also decline Token-2022 fee tokens. If a listing is part of the plan, verify with them first.

---

## The tax applies to *every* transfer

TransferFee has **no whitelist**. There is no "exempt the LP" or "exempt the team wallet." Every movement of this token is taxed 1%:

- A buy is taxed. A sell is taxed. A round trip costs ~2% on top of pool fees.
- **Seeding the pool is taxed.** Send 1,000,000 and the pool receives 990,000. Gross up your intended amount by `÷ 0.99` if you want the pool to land on a round number.
- Wallet-to-wallet transfers between your own addresses are taxed.

The one extension that *could* whitelist is TransferHook — and DEXs reject it. This tradeoff is not avoidable.

## Collected fees do not appear in your wallet

Withheld fees accumulate on each **recipient token account**, including the pool's. Collecting is two steps, both in `npm run harvest`:

1. `harvestWithheldTokensToMint` — permissionless, sweeps holder accounts → mint
2. `withdrawWithheldTokensFromMint` — authority-only, mint → treasury

Skip this and the 1% is taken from your users and earns you nothing. Run it on a schedule once you have volume.

**Discovery is the fragile part, and it already failed once.** Finding which accounts hold withheld fees needs an unindexed `getProgramAccounts` scan over all of Token-2022. The public Solana RPC **rejects this outright** — confirmed on devnet, not hypothetical:

> `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb excluded from account secondary indexes; this RPC method unavailable for key`

Most free and starter tiers behave the same way. **Do not let the scan be the only path to your money.** Pass accounts directly — the pool account holds the large majority of fees and you will know its address:

```bash
npm run harvest -- <poolTokenAccount>
```

This path is what was used to verify collection on devnet, and it's the one to rely on in production. If you have lost track of which accounts hold fees, `src/_recover.ts` reconstructs them from transaction signatures.

## Never hand-roll the fee math

Token-2022 rounds fees **up**: `(amount × bps + 9999) / 10000`, so dust transfers still pay at least 1 unit. The obvious `amount * bps / 10000` is floor division and diverges on any amount not divisible by 10,000 — verified: at 100 bps, `123456789` should be `1234568` but floor gives `1234567`. Because `TransferCheckedWithFee` *asserts* the fee, that mismatch rejects your own transaction. Always use `calculateFee(getEpochFee(cfg, epoch), amount)` from `@solana/spl-token` against live on-chain config. `03-test-tax.ts` includes odd-amount and dust cases specifically so this can't regress silently.

---

## Setup

> **Shell note.** Commands below are one per line so they work in both shells. Windows PowerShell 5.1 has **no `&&`** — chain with `;` instead (`cd foo; npm run x`). It also has no inline env-var prefix: use `$env:VAR = 'value'` on its own line or before a `;`.

```bash
cd antirugdex
cp .env.example .env
```

Generate a devnet key (no Solana CLI needed):

```bash
npx tsx src/00-keygen.ts ./deployer-devnet.json
```

Fund it — if the faucet rate-limits you, use https://faucet.solana.com with the printed pubkey:

```bash
npx tsx src/_airdrop.ts
```

## Run it on devnet, in order

On devnet `create` is dry-run by default — it prints the mint plan (rent, supply, all four
authorities, and which `mint.<cluster>.runN.json` the current record would roll to) and
spends nothing. `CONFIRM=yes` is what actually creates the mint. On **mainnet there is no
plan step in either direction**: without `CONFIRM=yes` the mainnet guard refuses outright,
and with it the run goes straight to spending.

```bash
npm run create
```

```bash
$env:CONFIRM = 'yes'; npm run create
```

(PowerShell form — see the env-var note below for Git Bash, and clear `$env:CONFIRM`
afterwards so a later command can't fire unguarded.)

```bash
npm run verify
```

```bash
npm run test-tax
```

`test-tax` is the one that matters. It moves 1,000 tokens between fresh accounts and asserts the recipient received exactly 990 and exactly 10 was withheld. If that passes, the tax works. "The mint exists" proves nothing.

```bash
npm run harvest
```

Then confirm the withheld tokens actually landed in the treasury.

## Going to mainnet

1. **Host the metadata.** ✅ **Done 2026-08-06**, and **moved to Arweave 2026-08-10.** `TOKEN.uri` is now `https://arweave.net/qrkpjUD2wcssICS3-KfYtRIPA9deUQGlSkFgWOrFtwA` (block 1,977,494), with the image at `Uxq3lWkihOoFGy8ZmCIDGiq_wOs3ivjVfazJVj7AhpU` (block 1,976,347) — content-addressed, so neither can be changed by anyone, including us. The `antirugdex.com` copies remain live and byte-identical to `site/`, but nothing depends on them now.

   Deployed as a **Cloudflare Worker with static assets** (project `soft-king-c03a`), not Pages — the dashboard defaults to Workers now, and it serves static files identically. The `site/` folder is what gets dragged in. Preview locally first:

   ```bash
   npx tsx src/_serve.ts
   ```

   Two things that bit us and will bite again on any redeploy:

   - The domain came from GoDaddy, so the apex carried GoDaddy parking A records (`15.197.148.33`, `3.33.130.190`). Cloudflare refuses to attach a custom domain over externally-managed records — delete those two **A** records first, keep `_dmarc` and `www`.
   - Cloudflare returns **HTTP 200 for its parking page**, so a status-code check passes on a completely broken setup. Always verify the body:

   ```bash
   npx tsx src/_uricheck.ts
   ```

   `npm run create` and `npm run preflight` both run that check and **refuse to proceed on mainnet** if it fails. Note Cloudflare injects its bot-management script into HTML responses — harmless, and it does not touch the JSON or PNG.

   Note that `metadata.json` deliberately does **not** claim the authorities are revoked — it's uploaded before `05` runs, so that claim would be false for the window in between. It says "verify on-chain" instead, which is both true at every moment and a better pitch. Resist the urge to "fix" this.
2. Install the Solana CLI and generate the mainnet key **yourself** — do not reuse the devnet key, and do not let any tool generate the key that will hold real value:
   ```bash
   solana-keygen new -o ./deployer-mainnet.json
   ```
3. Fund it with **~4.75 SOL** — not the ~0.05 this line used to say. That figure only ever covered the mint transaction; the launch also pays ~2.5 SOL of rent to deploy the sale program, fronts a 2 SOL pool seed the raise cannot fund (`sweep_proceeds` requires a proven pool, so reimbursement comes last), and pays Raydium's 0.15 SOL create-pool fee. `CLUSTER=mainnet npm run preflight` prints the itemised budget and fails on the total. Then set a real RPC (Helius/Triton — the public endpoint will drop your mint transaction) and `CLUSTER=mainnet` in `.env`.
4. **Decide the treasury before you create the mint.** `withdrawWithheldAuthority` is set at creation and `05` never changes it. It must be able to produce a signature — a **plain keypair** or a **Token-2022 native multisig**. A **Squads vault will not work**: it's a PDA with no private key, so `04-harvest.ts` could never complete the withdraw and every collected fee would strand on the mint. For Squads custody, use a cold keypair here and forward tokens to the vault afterwards. See `.env.example`.
5. **Run the preflight.** It validates `.env` before anything costs money — placeholder RPC keys, malformed addresses, insufficient balance, a dead metadata URI, and most importantly that `WITHHELD_AUTHORITY_KEYPAIR` actually matches `TREASURY_PUBKEY`. That last one cannot be repaired after mint creation: a mismatch strands every fee you ever collect.

   ```bash
   npm run preflight
   ```

6. Every money-spending script refuses to run on mainnet unless `CONFIRM=yes` is set. **You're on PowerShell, where the bash inline-env form is a parse error:**

   ```powershell
   $env:CONFIRM = 'yes'; npm run create
   ```

   That variable persists for the rest of the shell session — clear it with `Remove-Item Env:CONFIRM` so a later command can't fire unguarded. In Git Bash the inline form works instead:

   ```bash
   CONFIRM=yes npm run create
   ```
7. Seed the pool on Raydium CPMM or Meteora DAMM v2. Remember the 1% haircut on the seed transfer — and because the fee **rounds up**, `÷ 0.99` is approximate. Compute the exact gross-up with `calculateFee` for the amount you're actually sending.
8. Lock it down (PowerShell form):

   ```powershell
   $env:CONFIRM = 'yes'; npm run lock
   ```

---

## The lockdown, and what it costs you

`npm run lock` revokes `transferFeeConfigAuthority`. **This is irreversible.**

It is also the entire differentiator. Right now, an unrevoked fee authority is a key that can raise the tax toward 100% and turn the token into a honeypot — which is exactly the thing your launchpad claims to prevent. An anti-rug brand shipping a token with a live fee authority is making a promise a stranger cannot check. Revoking it converts that promise into a fact anyone can verify in ten seconds.

`01-create-mint.ts` already handles the other two: **freeze authority is never set**, and **mint authority is revoked in the same transaction that mints the supply**, so there is no window in which the supply could be inflated.

What you give up, stated plainly:

- The lock is irreversible **in both directions**. You can never lower the fee to 0% either. If a CEX or partner later requires a zero-fee token, the answer is permanently no.
- Even without revoking, fee changes take ~2 epochs (~4 days) to activate — you could never respond quickly anyway. That delay is itself an argument for just burning the key.

Decide before you run it, not after.

### The other two authorities

Revoking the three above makes the token safe. It does not make it immutable. Two more authorities stay live by default:

- **metadata update authority** — can change name, symbol, and URI
- **metadata pointer authority** — can repoint metadata at a different account entirely

Neither can take or freeze anyone's funds, so they are a *rebrand* vector, not a rug vector. But for a token whose whole pitch is ten-second verifiability, "you can silently rename this thing" is what someone screenshots. `npm run verify` reports both honestly rather than printing a blanket all-clear. To close them too, once your URI is final and permanently hosted:

```bash
REVOKE_METADATA_AUTHORITY=yes CONFIRM=yes npm run lock
```

In Git Bash: `REVOKE_METADATA_AUTHORITY=yes CONFIRM=yes npm run lock`.

Keeping them live until the site settles is a reasonable call — just say so publicly instead of letting it be found.

### The authority that stays live on purpose

`withdrawWithheldAuthority` is never revoked, and `npm run verify` prints it with an explanation rather than leaving it as an unexplained live key. It can move **only** fees already withheld by the 1% — it cannot touch a holder's principal, mint supply, or change the rate. Revoking it would make the fee uncollectable, not safer. Expect to be asked about it; the answer is in the verify output.

---

## Files

| | |
|---|---|
| `src/config.ts` | Name, symbol, supply, fee rate. **The only file you should edit.** |
| `src/00-keygen.ts` | Keypair generator (devnet convenience) |
| `src/01-create-mint.ts` | Creates the mint, mints supply, revokes mint authority |
| `src/02-verify.ts` | Reads chain state, prints the rug-check report |
| `src/03-test-tax.ts` | Devnet: proves the 1% is taken and withheld |
| `src/04-harvest.ts` | Collects withheld fees to the treasury |
| `src/05-lock-down.ts` | Burns the fee authority — irreversible |
| `src/_airdrop.ts` | Devnet funding helper |
| `src/_rentcheck.ts` | Shows why `01` over-funds rent by 28 bytes for `05` |
| `src/_recover.ts` | Finds fee-holding accounts from tx signatures when gPA is blocked |
| `src/_uricheck.ts` | Confirms the metadata URI serves JSON, not a parking page |
| `src/_make-logo.ts` | Regenerates `site/token/ard.png` |
| `src/_serve.ts` | Serves `site/` on :8787 to preview the deploy locally |
| `site/` | **Deploy this folder** — index page + `/token/metadata.json` + `/token/ard.png` |
| `metadata.json` | Master copy; `site/token/metadata.json` is what ships |

`mint.<cluster>.json` records the mint address for scripts 02–05. **`mint.devnet.json` currently points at the second devnet mint** (`Bo5FM27U…`, fully immutable); the first (`8Roxp6qV…`, fee-locked only) is preserved in `mint.devnet.run1.json`. `verify` reads `mint.devnet.json` — swap the files if you want to inspect the other.

## Two things worth thinking about

**The optics.** A launchpad selling anti-rug credibility, funded by a taxed token, is a combination people have been burned by often enough to pattern-match on. The locked fee authority is a genuinely strong answer to that, but only if you lead with it — put the three revoked authorities and the mint address on the antirugdex.com landing page and let people verify rather than trust.

**Fees are income.** Collecting a trading tax has tax and, depending on how the token is marketed, potentially securities implications where you live. Worth an hour with an accountant before there is real volume, not after.

## Status — verified end to end on devnet

Full sequence executed against devnet on 2026-08-05. Two mints created:

| | |
|---|---|
| [`8Roxp6qV…o4ZT2`](https://solscan.io/address/8Roxp6qVeGXsLTtP6vJjbfSGeZPATn2fmxQPoNwo4ZT2?cluster=devnet) | default lockdown — fee locked, identity left mutable |
| [`Bo5FM27U…DvDSr`](https://solscan.io/address/Bo5FM27UKbaTTajXkRBFrUqv9Bdm8sv1G6MQkEbDvDSr?cluster=devnet) | `REVOKE_METADATA_AUTHORITY=yes` — fully immutable, all six checks PASS |

What the run actually proved, beyond "the mint exists":

- **Tax arithmetic, on-chain.** 1,000 tokens → 990 received / 10 withheld. Odd amount `123456789` → fee `1234568`, confirming Token-2022 rounds **up** — floor division would have given `1234567` and had the program reject the transaction. Dust (1 base unit) → fee 1, recipient receives 0.
- **Fees are collectable.** Harvested exactly `10.001234569` from three recipient accounts into the treasury. Balance moved.
- **Both lockdown paths work,** including the instruction ordering in the full-revoke path (`UpdateField` must precede the update-authority revoke).
- **The rent headroom is load-bearing.** `fee_authority: revoked` is on chain, which only succeeds because `01` over-funds by 28 bytes. Without it the lock transaction fails and takes the fee revoke with it.
- **`getProgramAccounts` is not available** on the public RPC (see harvest section above).

Cost per mint: **0.004907 SOL**. Mainnet will be the same plus priority fees.

Typechecked clean against `@solana/spl-token` 0.4.15 and `@solana/spl-token-metadata` 0.1.6.

Still untested: anything involving a real pool — LP seeding under the 1% haircut, and harvesting from a live DEX pool account. Those only exist on mainnet.
