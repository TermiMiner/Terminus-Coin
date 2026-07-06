// TERM sweep — move mined TERM out of the (hot) mining wallet to a real wallet
// you control, WITHOUT exporting the private key. See docs/term-sweep-scope.md.
//
// TERM is a CLASSIC SPL token (Tokenkeg…, 6 decimals, no token-2022 extensions),
// so this is a plain transferChecked. Phase 1: manual, liquid balance only.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { confirmOrCheckLanded } from "./confirmTx";
import type { MinerWallet } from "./burnerWallet";

export const TERM_DECIMALS = 6;

// Rough SOL the source must hold: tx fee + (dest ATA rent only if it must be
// created). The UI uses this to gate Send so a near-empty gasless burner gets a
// clear message instead of a failed send.
export const SWEEP_FEE_LAMPORTS = 5_000;
export const ATA_RENT_LAMPORTS = 2_039_280; // classic SPL token ATA rent-exempt min

/**
 * Parse a user-typed TERM amount (plain decimal, ≤6 places) to raw u64 units,
 * WITHOUT float error — parses the string directly. Returns null for anything
 * that isn't a plain non-negative decimal with ≤6 fractional digits (rejects
 * "1e3", "0x10", negatives, >6 decimals, blanks, junk). Callers reject `<= 0n`.
 * Using Number()*1e6 would drift (e.g. 0.29*1e6 = 289999.9999…) and could round
 * an amount up past the balance — string parsing is exact.
 */
export function parseTermAmount(input: string): bigint | null {
  const t = input.trim();
  if (t === "" || t === "." || !/^\d*\.?\d*$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > TERM_DECIMALS) return null;
  return BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, TERM_DECIMALS));
}

/**
 * Validate a sweep destination. Returns a human reason if it's unsafe, else null.
 * The critical guard: a user pasting a TOKEN ACCOUNT (e.g. their TERM ATA)
 * instead of their wallet address would otherwise send into an ATA-of-an-ATA and
 * lose the funds. We also block sending to self.
 */
export async function validateSweepDestination(
  connection: Connection,
  dest: PublicKey,
  source: PublicKey,
): Promise<string | null> {
  if (dest.equals(source)) return "That's this wallet — pick a different destination.";
  const info = await connection.getAccountInfo(dest);
  if (info && (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    return "That looks like a token account, not a wallet. Paste your wallet's address (it owns the token account), not the token account itself.";
  }
  // Off-curve = a program / multisig (e.g. Squads) address, not a normal wallet.
  // getAssociatedTokenAddressSync would throw TokenOwnerOffCurveError on it, so
  // reject up front with a clear message instead of a cryptic crash. Phase 1
  // sends only to normal wallets.
  if (!PublicKey.isOnCurve(dest.toBytes())) {
    return "That's an off-curve address (a program or multisig / Squads vault), not a normal wallet. Send TERM to a self-custody wallet (Phantom / Solflare / Ledger), then move it from there.";
  }
  // null (unfunded wallet) or system-owned (normal wallet) → allowed.
  return null;
}

/** Does the destination already have a TERM token account? (UI: estimate SOL need.) */
export async function destNeedsAta(
  connection: Connection,
  mint: PublicKey,
  dest: PublicKey,
): Promise<boolean> {
  const destAta = getAssociatedTokenAddressSync(mint, dest);
  const info = await connection.getAccountInfo(destAta);
  return !info;
}

/**
 * Sweep `amountRaw` (6-dec raw units) of TERM from `wallet` to `dest`.
 * Creates the destination's TERM ATA if missing (payer = wallet). The wallet
 * signs locally and pays its own fee — no relayer. Returns the tx signature.
 */
export async function sweepTerm(
  connection: Connection,
  wallet: MinerWallet,
  mint: PublicKey,
  dest: PublicKey,
  amountRaw: bigint,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
  if (amountRaw <= 0n) throw new Error("Amount must be greater than 0");
  const owner = wallet.publicKey;

  const srcAta = getAssociatedTokenAddressSync(mint, owner);
  const destAta = getAssociatedTokenAddressSync(mint, dest);

  const tx = new Transaction();
  // Create the destination ATA if it doesn't exist yet. Idempotent → a no-op
  // (no extra rent) if the recipient already has a TERM account.
  if (await destNeedsAta(connection, mint, dest)) {
    tx.add(createAssociatedTokenAccountIdempotentInstruction(owner, destAta, dest, mint));
  }
  tx.add(
    createTransferCheckedInstruction(srcAta, mint, destAta, owner, amountRaw, TERM_DECIMALS),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;

  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction((signed as Transaction).serialize());
  await confirmOrCheckLanded(connection, sig, blockhash, lastValidBlockHeight);
  return sig;
}
