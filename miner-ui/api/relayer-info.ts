import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, Keypair } from "@solana/web3.js";

/**
 * GET /api/relayer-info
 * Returns the relayer's public key and current SOL balance. No secrets.
 * Used by the frontend to detect whether shared-relayer mode is configured
 * and to display the operator's funding pool.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const rpc = (process.env.RPC_URL || "https://api.devnet.solana.com").trim();
    const raw = process.env.RELAYER_SECRET_KEY;
    if (!raw) throw new Error("RELAYER_SECRET_KEY env var not set");
    const arr = JSON.parse(raw.trim());
    const relayer = Keypair.fromSecretKey(new Uint8Array(arr));
    const conn = new Connection(rpc, "confirmed");
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
