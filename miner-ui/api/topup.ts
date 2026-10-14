import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Redis } from "@upstash/redis";

const TOPUP_LAMPORTS = 7_500_000;         // 0.0075 SOL — covers setup + ~12h of 24/7 mining
const RECIPIENT_BALANCE_CAP = 7_000_000;  // skip topup if recipient already has this much; keep < TOPUP_LAMPORTS (7.5M) so a just-granted wallet is caught

// Quotas (env overrides). Defaults are conservative — see RELAYER_OPERATOR.md.
const MAX_TOPUPS_PER_WALLET     = parseInt(process.env.MAX_TOPUPS_PER_WALLET     ?? "1");
const MAX_TOPUPS_PER_IP_PER_HR  = parseInt(process.env.MAX_TOPUPS_PER_IP_PER_HR  ?? "5");
const MAX_DAILY_LAMPORTS        = parseInt(process.env.MAX_DAILY_LAMPORTS        ?? "1000000000"); // 1 SOL

// Accept either Vercel KV's legacy env names or Upstash Marketplace's native names.
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   ?? process.env.KV_REST_API_URL   ?? "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
const kv = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

// Devnet-only escape hatch for running without KV. See unguardedRefusal().
const ALLOW_UNGUARDED_TOPUP = (process.env.ALLOW_UNGUARDED_TOPUP ?? "false").toLowerCase() === "true";
// Same constant mainnet-launch.sh checks before it will touch chain.
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

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

// Cached per cold start; only consulted on the escape-hatch path, so the normal
// (KV-provisioned) path never pays for this round-trip.
let cachedGenesis: string | null = null;

/**
 * The three quota guards all live behind KV. With no KV there are no guards at
 * all, so a funded relayer can be drained by anyone who can POST — survivable on
 * devnet (worthless SOL), not on mainnet. The default is therefore to REFUSE,
 * matching every other money-path guard in this directory: RPC_URL throws rather
 * than defaulting to a public endpoint, MIN_TIP_TERM refuses a silent 0.
 *
 * ALLOW_UNGUARDED_TOPUP=true re-opens the endpoint for devnet testing. The
 * escape hatch is itself checked against the cluster, because the dangerous
 * sequence is a devnet deployment that later flips RPC_URL to mainnet and
 * forgets to unset it — on mainnet-beta the hatch is ignored. A cluster we
 * cannot verify counts as mainnet.
 *
 * Returns a 503 body when the request must be refused, or null to proceed.
 */
async function unguardedRefusal(conn: Connection): Promise<Record<string, unknown> | null> {
  if (!ALLOW_UNGUARDED_TOPUP) {
    return {
      error:
        "relayer top-ups are disabled: quota guards are not provisioned. Set " +
        "UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (RELAYER_OPERATOR.md step 4).",
      reason: "guards-unavailable",
    };
  }
  try {
    if (cachedGenesis === null) cachedGenesis = await conn.getGenesisHash();
  } catch {
    return {
      error:
        "relayer top-ups are disabled: quota guards are not provisioned and the " +
        "cluster could not be verified, so the devnet-only override cannot be honoured.",
      reason: "cluster-unverified",
    };
  }
  if (cachedGenesis === MAINNET_GENESIS) {
    return {
      error:
        "relayer top-ups are disabled: ALLOW_UNGUARDED_TOPUP is ignored on " +
        "mainnet-beta. Provision KV quota guards (RELAYER_OPERATOR.md step 4).",
      reason: "guards-unavailable-mainnet",
    };
  }
  return null;
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
 * With no KV the guards cannot run, so the endpoint REFUSES (503) rather than
 * serving unguarded top-ups. See unguardedRefusal(). Provisioning KV is
 * RELAYER_OPERATOR.md step 4.
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
  // rollback() drains the list, so calling it twice is a no-op. The send
  // path's inner catch rolls back and rethrows into the outer catch, which
  // rolls back again; without the drain every counter was decremented twice
  // (wallet quota → -1, daily spend under-counted by two grants).
  const reservations: Array<{ key: string; amount: number }> = [];
  const rollback = async () => {
    if (!kv) return;
    const pending = reservations.splice(0);
    await Promise.all(
      pending.map((r) => kv!.incrby(r.key, -r.amount)),
    ).catch(() => { /* best-effort */ });
  };

  try {
    // ── Config (fail loud) ─────────────────────────────────────────────
    // Resolved before the guards so the fail-closed check below has a
    // Connection to verify the cluster with. Fail loud if RPC_URL is unset —
    // never silently default to a public endpoint (a mainnet deploy must not
    // route to devnet).
    const rpc = (process.env.RPC_URL ?? "").trim();
    if (!rpc) throw new Error("RPC_URL is not set — refusing to default to a public RPC endpoint. Set RPC_URL to your cluster's RPC (devnet or mainnet).");
    const raw = process.env.RELAYER_SECRET_KEY;
    if (!raw) throw new Error("RELAYER_SECRET_KEY env var not set");
    const relayer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw.trim())));
    const conn = new Connection(rpc, "confirmed");

    // ── Guard availability: fail CLOSED ────────────────────────────────
    // No KV means no quotas, no rate limit and no daily cap. Refuse rather
    // than hand out SOL unguarded.
    if (!kv) {
      const refusal = await unguardedRefusal(conn);
      if (refusal) return res.status(503).json(refusal);
    }

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
