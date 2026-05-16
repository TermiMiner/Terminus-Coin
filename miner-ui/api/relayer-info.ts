import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Redis } from "@upstash/redis";

const MAX_TOPUPS_PER_WALLET = parseInt(process.env.MAX_TOPUPS_PER_WALLET ?? "1");
const MAX_DAILY_LAMPORTS    = parseInt(process.env.MAX_DAILY_LAMPORTS    ?? "1000000000");

// Accept either Vercel KV's legacy env names or Upstash Marketplace's native names.
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   ?? process.env.KV_REST_API_URL   ?? "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
const kv = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

/**
 * GET /api/relayer-info[?wallet=<pubkey>]
 * Returns the relayer's pubkey + balance, plus (when KV is configured) the
 * remaining daily-spend headroom and per-wallet topup quota for the caller.
 * No secrets exposed.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const rpc = (process.env.RPC_URL || "https://api.devnet.solana.com").trim();
    const raw = process.env.RELAYER_SECRET_KEY;
    if (!raw) throw new Error("RELAYER_SECRET_KEY env var not set");
    const relayer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw.trim())));
    const conn = new Connection(rpc, "confirmed");
    const balance = await conn.getBalance(relayer.publicKey);

    const out: Record<string, unknown> = {
      pubkey: relayer.publicKey.toBase58(),
      balance,
    };

    if (kv) {
      // Daily-cap headroom (shared across topup + relay)
      const todayKey = `relayer:spend:${new Date().toISOString().slice(0, 10)}`;
      const todaySpent = Number((await kv.get<number>(todayKey)) ?? 0);
      out.dailyCap = MAX_DAILY_LAMPORTS;
      out.dailySpent = todaySpent;
      out.dailyRemaining = Math.max(0, MAX_DAILY_LAMPORTS - todaySpent);

      // Per-wallet topup quota (if ?wallet=<pubkey> provided)
      const walletQuery = (Array.isArray(req.query.wallet) ? req.query.wallet[0] : req.query.wallet) ?? "";
      if (walletQuery) {
        try {
          new PublicKey(walletQuery); // validate
          const walletKey = `topup:wallet:${walletQuery}`;
          const used = Number((await kv.get<number>(walletKey)) ?? 0);
          out.wallet = {
            address: walletQuery,
            topupsUsed: used,
            topupsMax: MAX_TOPUPS_PER_WALLET,
            topupsRemaining: Math.max(0, MAX_TOPUPS_PER_WALLET - used),
          };
        } catch {
          // invalid pubkey, just omit
        }
      }
    } else {
      out.kvEnabled = false;
      // Diagnostic: which Redis-flavored env vars did Vercel actually inject?
      // (Names only — values would leak the connection secret.)
      out.envVarsSeen = Object.keys(process.env).filter((k) =>
        /REDIS|UPSTASH|KV_/i.test(k)
      );
    }

    res.setHeader("Cache-Control", "public, max-age=15");
    return res.status(200).json(out);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "failed" });
  }
}
