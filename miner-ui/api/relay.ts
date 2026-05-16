import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { Redis } from "@upstash/redis";

const PROGRAM_ID                = "FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y";
const TOKEN_PROGRAM             = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM  = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM    = "ComputeBudget111111111111111111111111111111";

const ALLOWED = new Set([PROGRAM_ID, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM]);

const APPROX_RELAY_FEE_LAMPORTS = 10_000; // tx fee for the 2-signer claim — counts against daily cap

const MAX_RELAYS_PER_IP_PER_HR  = parseInt(process.env.MAX_RELAYS_PER_IP_PER_HR  ?? "120"); // ~2/min
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
 * POST /api/relay  { transaction: base64 }
 *
 * Adds the relayer's signature to a partially-signed tx and broadcasts.
 * Anti-abuse:
 *   1. Instruction allowlist — relayer ONLY signs txs targeting our program,
 *      Token program, ATA program, and ComputeBudget. No arbitrary signing.
 *   2. tx.feePayer must be the relayer (rejects misdirected requests).
 *   3. Per-IP rate limit (KV)  — max MAX_RELAYS_PER_IP_PER_HR per hour.
 *   4. Daily spend cap (KV)    — shared with /api/topup. ~10K lamports per relay.
 *
 * On-chain rate_limit_seconds already caps per-wallet claim rate, so we don't
 * also enforce per-wallet quotas here.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { transaction } = (req.body ?? {}) as { transaction?: string };
  if (typeof transaction !== "string") {
    return res.status(400).json({ error: "transaction (base64) required" });
  }

  const ip = clientIp(req);

  try {
    // ── Per-IP + daily quota gate ──────────────────────────────────────
    if (kv) {
      const ipKey = hourKey("relay:ip", ip);
      const spendKey = todayKey();
      const [ipCount, todaySpent] = await Promise.all([
        kv.get<number>(ipKey).then((v) => Number(v ?? 0)),
        kv.get<number>(spendKey).then((v) => Number(v ?? 0)),
      ]);
      if (ipCount >= MAX_RELAYS_PER_IP_PER_HR) {
        return res.status(429).json({
          error: `IP rate limit (${ipCount}/${MAX_RELAYS_PER_IP_PER_HR} per hour)`,
          quota: "ip",
        });
      }
      if (todaySpent + APPROX_RELAY_FEE_LAMPORTS > MAX_DAILY_LAMPORTS) {
        return res.status(429).json({
          error: "relayer daily budget exhausted",
          quota: "daily",
          todaySpent,
          dailyCap: MAX_DAILY_LAMPORTS,
        });
      }
    }

    const relayer = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse((process.env.RELAYER_SECRET_KEY ?? "").trim()))
    );

    let tx: Transaction;
    try { tx = Transaction.from(Buffer.from(transaction, "base64")); }
    catch { return res.status(400).json({ error: "tx deserialise failed" }); }

    if (!tx.feePayer || tx.feePayer.toBase58() !== relayer.publicKey.toBase58()) {
      return res.status(400).json({ error: "tx fee_payer must be the relayer" });
    }

    for (const ix of tx.instructions) {
      const pid = ix.programId.toBase58();
      if (!ALLOWED.has(pid)) {
        return res.status(400).json({ error: `disallowed program in tx: ${pid}` });
      }
    }

    tx.partialSign(relayer);

    const rpc = (process.env.RPC_URL || "https://api.devnet.solana.com").trim();
    const conn = new Connection(rpc, "confirmed");
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });

    // Record the spend after successful broadcast
    if (kv) {
      const ipKey = hourKey("relay:ip", ip);
      const spendKey = todayKey();
      await Promise.all([
        kv.incr(ipKey).then(() => kv.expire(ipKey, 3600)),
        kv.incrby(spendKey, APPROX_RELAY_FEE_LAMPORTS).then(() => kv.expire(spendKey, 86400 * 7)),
      ]);
    }

    return res.status(200).json({ signature: sig });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "failed", logs: err?.logs });
  }
}
