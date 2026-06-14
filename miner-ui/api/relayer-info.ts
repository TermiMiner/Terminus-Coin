import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Redis } from "@upstash/redis";

const MAX_TOPUPS_PER_WALLET = parseInt(process.env.MAX_TOPUPS_PER_WALLET ?? "1");
const MAX_DAILY_LAMPORTS    = parseInt(process.env.MAX_DAILY_LAMPORTS    ?? "1000000000");

// Mirror the deprecation banner logic from api/relay.ts so the UI can
// fetch it via this endpoint (one-shot on page load) without waiting for
// a relayed claim to learn the relayer is sunsetting.
const BOOTSTRAP_SUNSET_DATE   = process.env.BOOTSTRAP_SUNSET_DATE ?? "";
const DEPRECATION_BANNER_DAYS = parseInt(process.env.DEPRECATION_BANNER_DAYS ?? "14");
// Relayer's permanent cost-recovery floor. Read independent of BOOTSTRAP_MODE
// so it survives the launch phase; falls back to the legacy env name. Fail loud
// on a non-integer/negative value so the advertised floor can't silently vanish
// (parseInt("0.5")===0 / parseInt("0.5TERM")===NaN both pass the old > 0 guard
// as false) — it must stay in lockstep with what relay.ts enforces.
function parseMinTipTerm(): number {
  const raw = (process.env.MIN_TIP_TERM ?? process.env.MIN_BOOTSTRAP_TIP_TERM ?? "500000").trim();
  if (raw === "") return 500_000; // empty env → default floor, never a silent 0
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`MIN_TIP_TERM must be a non-negative integer in raw TERM units (6 decimals); got ${JSON.stringify(raw)}`);
  }
  return n;
}
const MIN_TIP_TERM            = parseMinTipTerm();
const BOOTSTRAP_MODE          = (process.env.BOOTSTRAP_MODE ?? "false").toLowerCase() === "true";

function deprecationInfo() {
  if (!BOOTSTRAP_SUNSET_DATE) return null;
  const sunset = Date.parse(BOOTSTRAP_SUNSET_DATE);
  if (isNaN(sunset)) return null;
  const daysRemaining = Math.ceil((sunset - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysRemaining > DEPRECATION_BANNER_DAYS) return null;
  return {
    sunsetDate: BOOTSTRAP_SUNSET_DATE,
    daysRemaining: Math.max(0, daysRemaining),
    message: daysRemaining > 0
      ? `Bootstrap relayer ending in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}. After that you'll need to self-fund or use a community relayer.`
      : "Bootstrap relayer has ended. Switch to self-fund or use a community relayer.",
  };
}

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
    const raw = process.env.RELAYER_SECRET_KEY;
    if (!raw) {
      // No relayer configured on this deployment. Return a DEFINITIVE 200
      // "not configured" — distinct from a transient 500 outage below — so the
      // client treats it as a clean absence (route burners to self-fund) rather
      // than retrying forever in INITIALISING…. fetchSharedRelayerInfo maps a
      // 200 with no pubkey to null.
      return res.status(200).json({ configured: false });
    }
    // RPC only matters once a relayer IS configured. Fail loud if RPC_URL is
    // unset — never silently default to a public endpoint (a mainnet deploy
    // must not route to the wrong network).
    const rpc = (process.env.RPC_URL ?? "").trim();
    if (!rpc) throw new Error("RPC_URL is not set — refusing to default to a public RPC endpoint. Set RPC_URL to your cluster's RPC (devnet or mainnet).");
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
    }

    // Permanent relayer floor — advertised regardless of bootstrap so the UI
    // can derive tip presets and the floor stays enforced after the launch phase.
    if (MIN_TIP_TERM > 0) out.minTipTerm = MIN_TIP_TERM;
    // Bootstrap governs only the temporary first-claim subsidy + sunset banner.
    if (BOOTSTRAP_MODE) out.bootstrapMode = true;
    const dep = deprecationInfo();
    if (dep) out.deprecation = dep;

    res.setHeader("Cache-Control", "public, max-age=15");
    return res.status(200).json(out);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "failed" });
  }
}
