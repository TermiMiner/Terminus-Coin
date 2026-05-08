import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Transaction } from "@solana/web3.js";
import { PROGRAM_ID, getRelayerKeypair, getConnection } from "./_relayer";

/**
 * POST /api/relay  { transaction: base64 }
 * Receives a partially-signed transaction (signed by the burner as authority),
 * adds the relayer's signature as fee_payer, and broadcasts.
 *
 * Anti-abuse: refuses to sign anything that contains instructions outside the
 * allowed program set. Effectively the relayer can ONLY pay fees for our
 * mining flow — not arbitrary Solana txs an attacker might construct.
 */

const TOKEN_PROGRAM            = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM   = "ComputeBudget111111111111111111111111111111";

const ALLOWED = new Set([
  PROGRAM_ID,
  TOKEN_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { transaction } = (req.body ?? {}) as { transaction?: string };
  if (typeof transaction !== "string") {
    return res.status(400).json({ error: "transaction (base64) required" });
  }

  try {
    const relayer = getRelayerKeypair();

    let tx: Transaction;
    try { tx = Transaction.from(Buffer.from(transaction, "base64")); }
    catch { return res.status(400).json({ error: "tx deserialise failed" }); }

    // Must explicitly name the relayer as fee payer
    if (!tx.feePayer || tx.feePayer.toBase58() !== relayer.publicKey.toBase58()) {
      return res.status(400).json({ error: "tx fee_payer must be the relayer" });
    }

    // Every top-level instruction must target an allowed program
    for (const ix of tx.instructions) {
      const pid = ix.programId.toBase58();
      if (!ALLOWED.has(pid)) {
        return res.status(400).json({ error: `disallowed program in tx: ${pid}` });
      }
    }

    // Add relayer's signature (preserves the burner's signature already on the tx)
    tx.partialSign(relayer);

    const conn = getConnection();
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    return res.status(200).json({ signature: sig });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "failed", logs: err?.logs });
  }
}
