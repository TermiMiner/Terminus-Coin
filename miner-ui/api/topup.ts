import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Redis } from "@upstash/redis";

const TOPUP_LAMPORTS = 15_000_000;        // 0.015 SOL
const RECIPIENT_BALANCE_CAP = 8_000_000;  // refuse to top up if recipient already has more

// Quotas (env overrides). Defaults are conservative — see RELAYER_OPERATOR.md.
const MAX_TOPUPS_PER_WALLET     = parseInt(process.env.MAX_TOPUPS_PER_WALLET     ?? "1");
const MAX_TOPUPS_PER_IP_PER_HR  = parseInt(process.env.MAX_TOPUPS_PER_IP_PER_HR  ?? "5");
const MAX_DAILY_LAMPORTS        = parseInt(process.env.MAX_DAILY_LAMPORTS        ?? "1000000000"); // 1 SOL

// Accept either Vercel KV's legacy env names or Upstash Marketplace's native names.
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   ?? process.env.KV_REST_API_URL   ?? "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
const kv = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

function clientIp(req: VercelRequest): string {
  const hdr = req.headers["x-forwarded-for"];
  const raw = Array.isArray(hdr) ? hdr[0] : hdr ?? "";
  return raw.split(",")[0].trim() || "unknown";
}

function todayKey(): string {
  return `relayer:spend:${new Date().toISOString().slice(0, 10)}`;
}

function hourKey(prefix: string, key: string): string {
  return `${prefix}:${key}:hour:${new Date().toISOString().slice(0, 13)}`;
}

/**
 * POST /api/topup  { recipient: string }
 *
 * Sends TOPUP_LAMPORTS from the shared relayer to a freshly generated burner
 * so it can pay for its bond + user_state rent on first claim. After this
 * one-time bootstrap, the burner self-funds tx fees from the gift.
 *
 * Hardened with three KV-backed guards:
 *   1. Per-wallet quota   — max MAX_TOPUPS_PER_WALLET grants per recipient, ever
 *   2. Per-IP rate limit  — max MAX_TOPUPS_PER_IP_PER_HR per source IP per hour
 *   3. Daily spend cap    — total relayer outflow today ≤ MAX_DAILY_LAMPORTS
 *
 * When KV env vars aren't set, the guards are SKIPPED — fine for devnet
 * testing, NOT safe for mainnet. See RELAYER_OPERATOR.md.
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

  const ip = clientIp(req);

  try {
    // ── Quota checks (only if KV is configured) ────────────────────────
    if (kv) {
      const walletKey = `topup:wallet:${recipient}`;
      const ipKey = hourKey("topup:ip", ip);
      const spendKey = todayKey();

      const [walletCount, ipCount, todaySpent] = await Promise.all([
        kv.get<number>(walletKey).then((v) => Number(v ?? 0)),
        kv.get<number>(ipKey).then((v) => Number(v ?? 0)),
        kv.get<number>(spendKey).then((v) => Number(v ?? 0)),
      ]);

      if (walletCount >= MAX_TOPUPS_PER_WALLET) {
        return res.status(429).json({
          error: `wallet quota reached (${walletCount}/${MAX_TOPUPS_PER_WALLET}) — fund your wallet manually to keep mining`,
          quota: "wallet",
        });
      }
      if (ipCount >= MAX_TOPUPS_PER_IP_PER_HR) {
        return res.status(429).json({
          error: `IP rate limit (${ipCount}/${MAX_TOPUPS_PER_IP_PER_HR} per hour) — try again later`,
          quota: "ip",
        });
      }
      if (todaySpent + TOPUP_LAMPORTS > MAX_DAILY_LAMPORTS) {
        return res.status(429).json({
          error: "relayer daily budget exhausted — try tomorrow or pay your own fees",
          quota: "daily",
          todaySpent,
          dailyCap: MAX_DAILY_LAMPORTS,
        });
      }
    }

    // ── On-chain checks ────────────────────────────────────────────────
    const rpc = (process.env.RPC_URL || "https://api.devnet.solana.com").trim();
    const raw = process.env.RELAYER_SECRET_KEY;
    if (!raw) throw new Error("RELAYER_SECRET_KEY env var not set");
    const relayer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw.trim())));
    const conn = new Connection(rpc, "confirmed");

    const balance = await conn.getBalance(recipientKey);
    if (balance >= RECIPIENT_BALANCE_CAP) {
      return res.status(200).json({ skipped: true, balance, reason: "recipient already funded" });
    }

    // ── Send ───────────────────────────────────────────────────────────
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

    // ── Record the grant (KV) ──────────────────────────────────────────
    if (kv) {
      const walletKey = `topup:wallet:${recipient}`;
      const ipKey = hourKey("topup:ip", ip);
      const spendKey = todayKey();
      await Promise.all([
        kv.incr(walletKey),
        kv.incr(ipKey).then(() => kv.expire(ipKey, 3600)),
        kv.incrby(spendKey, TOPUP_LAMPORTS).then(() => kv.expire(spendKey, 86400 * 7)), // keep history a week
      ]);
    }

    return res.status(200).json({ signature: sig, lamports: TOPUP_LAMPORTS });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "failed" });
  }
}
