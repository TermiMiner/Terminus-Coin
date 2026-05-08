import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getRelayerKeypair, getConnection } from "./_relayer";

const TOPUP_LAMPORTS = 15_000_000;        // 0.015 SOL
const RECIPIENT_BALANCE_CAP = 8_000_000;  // refuse to top up if recipient has more than this

/**
 * POST /api/topup  { recipient: string }
 * Sends TOPUP_LAMPORTS from the shared relayer to a freshly generated burner
 * so it can pay for its bond + user_state rent on first claim.
 *
 * Anti-abuse: refuse to top up wallets that already have ≥ RECIPIENT_BALANCE_CAP
 * (so a script can't drain the relayer by repeatedly hitting this endpoint with
 * a single recipient).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { recipient } = (req.body ?? {}) as { recipient?: string };
  if (typeof recipient !== "string") {
    return res.status(400).json({ error: "recipient (base58 pubkey) required" });
  }

  let recipientKey: PublicKey;
  try { recipientKey = new PublicKey(recipient); }
  catch { return res.status(400).json({ error: "invalid pubkey" }); }

  try {
    const relayer = getRelayerKeypair();
    const conn = getConnection();

    const balance = await conn.getBalance(recipientKey);
    if (balance >= RECIPIENT_BALANCE_CAP) {
      return res.status(200).json({ skipped: true, balance, reason: "recipient already funded" });
    }

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: relayer.publicKey });
    tx.add(SystemProgram.transfer({
      fromPubkey: relayer.publicKey,
      toPubkey: recipientKey,
      lamports: TOPUP_LAMPORTS,
    }));
    tx.sign(relayer);

    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

    return res.status(200).json({ signature: sig, lamports: TOPUP_LAMPORTS });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "failed" });
  }
}
