import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getRelayerKeypair, getConnection } from "./_relayer";

/**
 * GET /api/relayer-info
 * Returns the relayer's public key and current SOL balance. No secrets.
 * Used by the frontend to detect whether shared-relayer mode is configured
 * and to display the operator's funding pool.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const relayer = getRelayerKeypair();
    const conn = getConnection();
    const balance = await conn.getBalance(relayer.publicKey);
    res.setHeader("Cache-Control", "public, max-age=30");
    return res.status(200).json({
      pubkey: relayer.publicKey.toBase58(),
      balance,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "failed" });
  }
}
