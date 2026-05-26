import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";

const PROGRAM_ID                = "FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y";
const TOKEN_PROGRAM             = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM  = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM    = "ComputeBudget111111111111111111111111111111";

const ALLOWED = new Set([PROGRAM_ID, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM]);

// Conservative pre-check estimates for the daily-spend gate. Actual cost is
// measured post-confirmation via the tx's own fee_payer balance delta and
// reconciled into KV — these only have to be safe upper bounds, not exact.
//   - First-claim onboarding: up to ~5M lamports (tx fee + 2 ATAs +
//     bond rent + UserState rent, depending on what already exists)
//   - Repeat claim: just tx fee + a little slack
const PRECHECK_FIRST_CLAIM = 5_000_000;
const PRECHECK_REPEAT      =    50_000;

// Anchor instruction discriminator for `deposit_bond` — first 8 bytes of
// sha256("global:deposit_bond"). Used to detect first-claim onboarding txs.
const DEPOSIT_BOND_DISC = createHash("sha256")
  .update("global:deposit_bond")
  .digest()
  .subarray(0, 8);

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

// Worst-case cost estimate for the pre-broadcast gate. First-claim txs contain
// a `deposit_bond` ix targeting our program; repeat claims do not.
function maxPossibleCost(tx: Transaction): number {
  const isFirstClaim = tx.instructions.some(ix =>
    ix.programId.toBase58() === PROGRAM_ID &&
    ix.data.length >= 8 &&
    Buffer.compare(ix.data.subarray(0, 8), DEPOSIT_BOND_DISC) === 0
  );
  return isFirstClaim ? PRECHECK_FIRST_CLAIM : PRECHECK_REPEAT;
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
  const ipKey = hourKey("relay:ip", ip);
  const spendKey = todayKey();

  try {
    // ── IP rate limit (cheap, runs first) ──────────────────────────────
    if (kv) {
      const ipCount = Number((await kv.get<number>(ipKey)) ?? 0);
      if (ipCount >= MAX_RELAYS_PER_IP_PER_HR) {
        return res.status(429).json({
          error: `IP rate limit (${ipCount}/${MAX_RELAYS_PER_IP_PER_HR} per hour)`,
          quota: "ip",
        });
      }
    }

    // ── Deserialise + validate tx ──────────────────────────────────────
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

    // ── Daily-spend gate: atomic budget reservation ────────────────────
    // Pre-decrement KV with a conservative cost estimate. If the resulting
    // total exceeds the cap, roll back and reject. Actual cost is measured
    // post-confirmation and reconciled below.
    const estCost = maxPossibleCost(tx);
    let reservedCost = 0;
    if (kv) {
      const newSpend = await kv.incrby(spendKey, estCost);
      if (newSpend > MAX_DAILY_LAMPORTS) {
        await kv.incrby(spendKey, -estCost);
        return res.status(429).json({
          error: "relayer daily budget exhausted",
          quota: "daily",
          dailyCap: MAX_DAILY_LAMPORTS,
        });
      }
      await kv.expire(spendKey, 86400 * 7);
      reservedCost = estCost;
    }

    // ── Broadcast ──────────────────────────────────────────────────────
    tx.partialSign(relayer);

    const rpc = (process.env.RPC_URL || "https://api.devnet.solana.com").trim();
    const conn = new Connection(rpc, "confirmed");

    let sig: string;
    try {
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    } catch (err) {
      // Broadcast failed — release the reservation so the budget stays honest.
      if (kv && reservedCost > 0) {
        await kv.incrby(spendKey, -reservedCost);
      }
      throw err;
    }

    // IP counter increments only on successful broadcast (preserves existing behavior).
    if (kv) {
      await kv.incr(ipKey).then(() => kv.expire(ipKey, 3600));
    }

    // Respond to client immediately — client confirms the tx itself.
    res.status(200).json({ signature: sig });

    // ── Async reconciliation: actual cost vs estimate ──────────────────
    // Wait for confirmation, read the tx's own fee_payer balance delta
    // (concurrency-safe — unaffected by other relays in flight), then
    // adjust KV by the difference. Worst case (function dies before this
    // completes): KV holds the estimate. Fail-safe direction.
    if (kv && reservedCost > 0) {
      void (async () => {
        try {
          const bh = await conn.getLatestBlockhash("confirmed");
          await conn.confirmTransaction(
            { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
            "confirmed",
          );
          const txInfo = await conn.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          const actual = Math.max(
            0,
            (txInfo?.meta?.preBalances?.[0] ?? 0) - (txInfo?.meta?.postBalances?.[0] ?? 0),
          );
          const delta = actual - reservedCost;
          if (delta !== 0) await kv.incrby(spendKey, delta);
        } catch {
          // Reconciliation failed — keep the reservation. Fail-safe.
        }
      })();
    }
    return;
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "failed", logs: err?.logs });
  }
}
