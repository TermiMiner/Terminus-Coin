import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Redis } from "@upstash/redis";

const TOPUP_LAMPORTS = 7_500_000;         // 0.0075 SOL — covers setup + ~12h of 24/7 mining
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

  const walletKey = `topup:wallet:${recipient}`;
  const ipKey = hourKey("topup:ip", ip);
  const spendKey = todayKey();

  // Track reservations so we can roll back if anything downstream fails.
  // Each entry is { key, amount } — rollback uses incrby(key, -amount).
  const reservations: Array<{ key: string; amount: number }> = [];
  const rollback = async () => {
    if (!kv) return;
    await Promise.all(
      reservations.map((r) => kv!.incrby(r.key, -r.amount)),
    ).catch(() => { /* best-effort */ });
  };

  try {
    // ── Atomic quota reservations ──────────────────────────────────────
    // Read-then-check has a concurrent-burst race: N concurrent requests
    // all see (count < cap), all pass, all proceed. Atomic incr-then-check
    // makes overshoot structurally impossible: only the request that wins
    // the incr race gets "slot N", everyone else sees N+1 > cap and
    // rolls back.
    if (kv) {
      // 1) per-wallet quota — the main anti-Sybil defense
      const newWallet = await kv.incr(walletKey);
      reservations.push({ key: walletKey, amount: 1 });
      if (newWallet > MAX_TOPUPS_PER_WALLET) {
        await rollback();
        return res.status(429).json({
          error: `wallet quota reached (${newWallet - 1}/${MAX_TOPUPS_PER_WALLET}) — fund your wallet manually to keep mining`,
          quota: "wallet",
        });
      }

      // 2) per-IP rate limit
      const newIp = await kv.incr(ipKey);
      reservations.push({ key: ipKey, amount: 1 });
      await kv.expire(ipKey, 3600);
      if (newIp > MAX_TOPUPS_PER_IP_PER_HR) {
        await rollback();
        return res.status(429).json({
          error: `IP rate limit (${newIp - 1}/${MAX_TOPUPS_PER_IP_PER_HR} per hour) — try again later`,
          quota: "ip",
        });
      }

      // 3) daily spend cap
      const newSpend = await kv.incrby(spendKey, TOPUP_LAMPORTS);
      reservations.push({ key: spendKey, amount: TOPUP_LAMPORTS });
      await kv.expire(spendKey, 86400 * 7);
      if (newSpend > MAX_DAILY_LAMPORTS) {
        await rollback();
        return res.status(429).json({
          error: "relayer daily budget exhausted — try tomorrow or pay your own fees",
          quota: "daily",
          todaySpent: newSpend - TOPUP_LAMPORTS,
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
      // Already funded — release reservations since we didn't actually spend.
      await rollback();
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

    let sig: string;
    try {
      sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    } catch (err) {
      // Broadcast or confirmation failed — release reservations.
      await rollback();
      throw err;
    }

    // Success — reservations now correctly reflect actual spend; keep them.
    return res.status(200).json({ signature: sig, lamports: TOPUP_LAMPORTS });
  } catch (err: any) {
    await rollback();
    return res.status(500).json({ error: err?.message ?? "failed" });
  }
}
