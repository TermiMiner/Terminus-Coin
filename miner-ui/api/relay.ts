import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { waitUntil } from "@vercel/functions";
import { createHash } from "node:crypto";
import { getRpcUrl, loadRelayerKeypair, kv, getMinTipTerm } from "./_env";

const PROGRAM_ID                = "FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y";
const PROGRAM_ID_PUBKEY         = new PublicKey(PROGRAM_ID);
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

// Anchor instruction discriminators — first 8 bytes of sha256("global:<name>").
const DEPOSIT_BOND_DISC = createHash("sha256")
  .update("global:deposit_bond")
  .digest()
  .subarray(0, 8);
const CLAIM_DISC = createHash("sha256")
  .update("global:claim")
  .digest()
  .subarray(0, 8);

const MAX_RELAYS_PER_IP_PER_HR  = parseInt(process.env.MAX_RELAYS_PER_IP_PER_HR  ?? "120"); // ~2/min
const MAX_DAILY_LAMPORTS        = parseInt(process.env.MAX_DAILY_LAMPORTS        ?? "1000000000"); // 1 SOL

// ─── Bootstrap-mode controls ──────────────────────────────────────────────────
// When BOOTSTRAP_MODE=true, the relayer behaves as the time-boxed launch
// promotion described in MAINNET_CHECKLIST.md: first-claim subsidies for new
// wallets, MIN_BOOTSTRAP_TIP enforced on subsequent claims, deprecation
// signaling, hard cutover at BOOTSTRAP_SUNSET_DATE.
// When false (default), the relayer accepts any tip (including 0) — current
// devnet behavior, preserved so this code can ship without flipping the
// operational policy.
const BOOTSTRAP_MODE         = (process.env.BOOTSTRAP_MODE ?? "false").toLowerCase() === "true";
// Relayer's permanent cost-recovery floor (raw TERM units) lives in api/_env.ts
// (getMinTipTerm) — shared with relayer-info so enforce + advertise can't drift.
const BOOTSTRAP_SUNSET_DATE  = process.env.BOOTSTRAP_SUNSET_DATE ?? ""; // ISO 8601, e.g. "2026-09-15T00:00:00Z"
const DEPRECATION_BANNER_DAYS = parseInt(process.env.DEPRECATION_BANNER_DAYS ?? "14");

// KV client (Upstash / Vercel-KV) is shared from api/_env.ts.

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

// Locate the claim instruction in the tx (if any) and decode its inline args.
// Claim ix data layout: [8-byte disc][8-byte nonce LE][8-byte tip LE].
// Returns null if no claim ix is present (shouldn't happen for legit relay
// requests but we don't want to crash on malformed input).
function decodeClaimIx(tx: Transaction): { tip: bigint; authority: PublicKey } | null {
  const claimIx = tx.instructions.find(ix =>
    ix.programId.toBase58() === PROGRAM_ID &&
    ix.data.length >= 24 && // 8 disc + 8 nonce + 8 tip
    Buffer.compare(ix.data.subarray(0, 8), CLAIM_DISC) === 0
  );
  if (!claimIx) return null;
  // tip is the second u64 in the args, after the 8-byte nonce
  const tip = claimIx.data.readBigUInt64LE(16);
  // `authority` is account index 7 in the Claim<'info> struct, 0-indexed:
  //   0=fee_payer 1=global_state 2=stake_pool 3=mint 4=user_token_account
  //   5=fee_payer_token_account 6=mint_authority 7=authority …
  // Position is stable as part of the IDL contract.
  const AUTHORITY_INDEX = 7;
  if (claimIx.keys.length <= AUTHORITY_INDEX) return null;
  return { tip, authority: claimIx.keys[AUTHORITY_INDEX].pubkey };
}

// Has this wallet ever claimed? Used in BOOTSTRAP_MODE to decide whether
// tip = 0 is allowed (subsidized first claim) or rejected (must tip).
async function isFirstClaim(conn: Connection, authority: PublicKey): Promise<boolean> {
  const [userStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_state"), authority.toBuffer()],
    PROGRAM_ID_PUBKEY,
  );
  const acc = await conn.getAccountInfo(userStatePda);
  return !acc;
}

// Returns deprecation metadata if BOOTSTRAP_SUNSET_DATE is configured and
// we're inside the banner window. Returns null otherwise (UI won't render
// a banner).
function deprecationInfo(): { sunsetDate: string; daysRemaining: number; message: string } | null {
  if (!BOOTSTRAP_SUNSET_DATE) return null;
  const sunset = Date.parse(BOOTSTRAP_SUNSET_DATE);
  if (isNaN(sunset)) return null;
  const now = Date.now();
  const daysRemaining = Math.ceil((sunset - now) / (1000 * 60 * 60 * 24));
  if (daysRemaining > DEPRECATION_BANNER_DAYS) return null;
  return {
    sunsetDate: BOOTSTRAP_SUNSET_DATE,
    daysRemaining: Math.max(0, daysRemaining),
    message: daysRemaining > 0
      ? `Bootstrap relayer ending in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}. After that you'll need to self-fund or use a community relayer.`
      : "Bootstrap relayer has ended. Switch to self-fund or use a community relayer.",
  };
}

// A preflight failure is only the CLIENT's doomed tx when the PROGRAM actually
// ran and rejected it (custom program error / InstructionError in the sim logs).
// Transient/infra failures — blockhash not found, node behind, send errors —
// throw too but carry no program logs; those must surface as 5xx (retryable +
// visible to monitoring), NOT a 422 "would fail on-chain".
function isDoomedTx(err: any): boolean {
  const logs: string[] = Array.isArray(err?.logs) ? err.logs : [];
  if (logs.length === 0) return false;
  const hay = [String(err?.message ?? ""), ...logs].join("\n");
  return /custom program error|Error processing Instruction|InstructionError|AnchorError|Program \S+ failed/i.test(hay);
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
 *   4. Daily spend cap (KV)    — shared with /api/topup. Per-tx cost is
 *      measured post-confirmation (first claims with bond+ATA rent can
 *      cost ~5M lamports; repeat claims ~10K). Pre-broadcast reservation
 *      uses a conservative upper bound to avoid concurrent overshoot.
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
    const relayer = loadRelayerKeypair();

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

    // Connection is needed for bootstrap-mode first-claim detection AND the
    // broadcast itself. Construct once and share. getRpcUrl() fails loud if
    // RPC_URL is unset (see api/_env.ts).
    const conn = new Connection(getRpcUrl(), "confirmed");

    // ── Tip-floor + bootstrap policy ───────────────────────────────────
    // The tip floor (MIN_TIP_TERM) is a PERMANENT relayer cost-recovery rule,
    // enforced on every repeat claim — independent of BOOTSTRAP_MODE, so it
    // survives the launch phase. BOOTSTRAP_MODE governs only the temporary
    // subsidies. Non-claim relayed txs (e.g. withdraw_bond — the end-of-mining
    // rent refund) decode to null and pass through; they produce no TERM to tip
    // from. Rules for claim txs:
    //   - Repeat claims MUST tip at least MIN_TIP_TERM, or the relayer rejects.
    //   - First claims (fresh wallet, no UserState yet) are subsidized ONLY
    //     under bootstrap: tip can be 0. Outside bootstrap they pay the floor.
    //   - Under bootstrap after sunset: paid relays return 410 Gone; only
    //     first-claim subsidies continue (manual contingency).
    //
    // Known bounded DoS surface: a repeat-claim attacker could attach a
    // deposit_bond ix to their claim tx — if it fails on-chain (bond PDA
    // already in use), the relayer eats the tx fee (~5K lamports). Bounded by
    // MAX_RELAYS_PER_IP_PER_HR × ~5K ≈ 600K lamports/hr/IP.
    const deprecation = deprecationInfo();
    {
      const claimInfo = decodeClaimIx(tx);
      if (claimInfo) {
        const { tip, authority } = claimInfo;
        // First-claim free ride exists only under bootstrap; otherwise every
        // claim pays the floor. The ternary short-circuits the isFirstClaim RPC
        // when bootstrap is off.
        const firstClaim = BOOTSTRAP_MODE ? await isFirstClaim(conn, authority) : false;

        // Bootstrap sunset hard cutover: only first-claim subsidies continue.
        if (BOOTSTRAP_MODE && deprecation && deprecation.daysRemaining === 0 && !firstClaim) {
          return res.status(410).json({
            error: deprecation.message,
            deprecation,
          });
        }

        // Tip floor — non-subsidized claims must cover the relayer's SOL costs.
        const minTip = getMinTipTerm();
        if (!firstClaim && minTip > 0 && tip < BigInt(minTip)) {
          return res.status(429).json({
            error: `Tip below relayer minimum (${(minTip / 1_000_000).toFixed(2)} TERM). Raise your tip in settings or switch to self-fund.`,
            quota: "tip-floor",
            minTip,
            providedTip: Number(tip),
          });
        }
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

    let sig: string;
    try {
      // skipPreflight:false → the RPC simulates (preflight) before forwarding. A
      // doomed claim (tip > cap/net_reward, frozen wallet, stale nonce) fails
      // preflight and is NEVER submitted, so the relayer pays no gas for it.
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    } catch (err: any) {
      // Broadcast/preflight failed — release the reservation so the budget stays honest.
      if (kv && reservedCost > 0) {
        await kv.incrby(spendKey, -reservedCost);
      }
      // Only a genuine on-chain program rejection is the CLIENT's doomed tx —
      // report it as 422 with the program logs (so the UI shows the real reason
      // and monitoring doesn't see a 500). A transient RPC/infra failure
      // (blockhash not found, node behind) is NOT doomed: re-throw → 500 so it's
      // retried and stays visible to monitoring.
      if (isDoomedTx(err)) {
        return res.status(422).json({
          error: "claim rejected at simulation — it would fail on-chain, so it was not broadcast",
          detail: typeof err?.message === "string" ? err.message : undefined,
          logs: err?.logs ?? null,
        });
      }
      throw err; // genuine or transient relayer/RPC fault → 500 (retryable, monitored)
    }

    // IP counter increments only on successful broadcast (preserves existing behavior).
    if (kv) {
      await kv.incr(ipKey);
      await kv.expire(ipKey, 3600);
    }

    // Respond to client immediately — client confirms the tx itself.
    // Include deprecation field when within the sunset banner window so UI
    // can render a warning. Field is omitted entirely outside the window.
    const responseBody: Record<string, unknown> = { signature: sig };
    if (deprecation) responseBody.deprecation = deprecation;
    res.status(200).json(responseBody);

    // ── Async reconciliation: actual cost vs estimate ──────────────────
    // Wait for confirmation, read the tx's own fee_payer balance delta
    // (concurrency-safe — unaffected by other relays in flight), then
    // adjust KV by the difference. waitUntil() tells Vercel to keep the
    // function alive past res.json() until this completes — without it,
    // the runtime is allowed to freeze/kill the function and the
    // reconciliation never runs.
    if (kv && reservedCost > 0) {
      const txBlockhash = tx.recentBlockhash!;
      waitUntil((async () => {
        try {
          // Use the tx's own recentBlockhash for the confirmation strategy;
          // compute a current lastValidBlockHeight to bound polling.
          const blockHeight = await conn.getBlockHeight("confirmed");
          await conn.confirmTransaction(
            { signature: sig, blockhash: txBlockhash, lastValidBlockHeight: blockHeight + 150 },
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
          // Reconciliation failed — keep the reservation. Fail-safe direction.
        }
      })());
    }
    return;
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "failed", logs: err?.logs });
  }
}
