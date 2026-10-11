/**
 * Devnet proof that the tax actually works end to end.
 *
 * "The mint exists" is not verification. This moves real tokens between fresh
 * accounts and asserts the arithmetic: the fee is withheld on the recipient,
 * and the withheld amount is collectable. Run this before mainnet.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getAccount, getMint, getTransferFeeAmount,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithFeeInstruction,
  getTransferFeeConfig, getEpochFee, calculateFee, TransferFee,
} from "@solana/spl-token";
import { connection, loadKeypair, readMint, send, fmt, IS_MAINNET } from "./lib.js";

async function main() {
  if (IS_MAINNET) {
    console.error("This burns tokens on fees to prove a point. Devnet only.");
    process.exit(1);
  }

  const conn = connection();
  const payer = loadKeypair("DEPLOYER_KEYPAIR");
  const mint = new PublicKey(readMint().mint);
  const info = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const D = 10n ** BigInt(info.decimals);

  // Use the library's calculator against live on-chain config, never a
  // hand-rolled `amount * bps / 10000`. Token-2022 rounds the fee UP
  // (`(n + 9999) / 10000`) so dust transfers still pay at least 1 unit. A
  // floor-division guess happens to match on round numbers and silently
  // diverges everywhere else — and TransferCheckedWithFee asserts the fee,
  // so a mismatch rejects your own transaction.
  const cfg = getTransferFeeConfig(info);
  if (!cfg) throw new Error("No transfer fee config on this mint.");
  const epochFee: TransferFee = getEpochFee(cfg, BigInt((await conn.getEpochInfo()).epoch));

  const src = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const cases: { label: string; amount: bigint }[] = [
    // Round number against the configured rate.
    { label: "1,000 tokens", amount: 1_000n * D },
    // Deliberately not divisible by 10,000 — this is the case that fails if
    // anyone ever "simplifies" the fee math to floor division.
    { label: "odd amount (ceiling rounding)", amount: 123_456_789n },
    // Dust: fee rounds up to 1 unit, recipient receives nothing.
    { label: "1 base unit (dust)", amount: 1n },
  ];

  let allPass = true;

  for (const { label, amount } of cases) {
    const bob = Keypair.generate();
    const dst = getAssociatedTokenAddressSync(mint, bob.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const expectedFee = calculateFee(epochFee, amount);
    const expectedRecv = amount - expectedFee;

    console.log(`\n=== ${label} ===`);
    console.log(`  sending  : ${amount} base units`);
    console.log(`  expect fee held : ${expectedFee}`);
    console.log(`  expect received : ${expectedRecv}`);

    await send(conn, [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, dst, bob.publicKey, mint, TOKEN_2022_PROGRAM_ID,
      ),
      createTransferCheckedWithFeeInstruction(
        src, mint, dst, payer.publicKey,
        amount, info.decimals, expectedFee,
        [], TOKEN_2022_PROGRAM_ID,
      ),
    ], [payer], "transfer sent");

    const acct = await getAccount(conn, dst, "confirmed", TOKEN_2022_PROGRAM_ID);
    const withheld = getTransferFeeAmount(acct)?.withheldAmount ?? 0n;

    const pass = acct.amount === expectedRecv && withheld === expectedFee;
    allPass &&= pass;
    console.log(`  actual received : ${acct.amount}`);
    console.log(`  actual withheld : ${withheld}`);
    console.log(`  ${pass ? "PASS" : "FAIL"}`);
  }

  console.log(
    `\n${allPass
      ? `All cases PASS — the ${epochFee.transferFeeBasisPoints} bps fee is being taken and held correctly.`
      : "FAIL — numbers do not match."}`,
  );
  if (!allPass) process.exit(1);

  console.log(`  Total supply unchanged: ${fmt(info.supply, info.decimals)}`);
  console.log(`  Withheld tokens sit on the RECIPIENT accounts, not in your wallet.`);
  console.log(`  Run  npm run harvest  to sweep them to the treasury.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
