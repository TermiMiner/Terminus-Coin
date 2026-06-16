import { useCallback, useEffect, useRef, useState } from "react";
import { ComputeBudgetProgram, Connection, PublicKey, Transaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, Idl } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "../idl/terminuscoin.json";
import { PROGRAM_ID, GLOBAL_STATE_PDA, MINT_PDA, STAKE_POOL_PDA, deriveBondPDA } from "./useChainState";
import { minNetReward, baseRewardForEpoch } from "./tipMath";
import { luckTier } from "./luck";
import type { MineRequest, MineResult } from "./miner.worker";
import type { MinerWallet } from "./burnerWallet";
import type { BroadcastAdapter } from "./relayerAdapter";

export type MinerStatus = "idle" | "mining" | "submitting" | "error";

export interface LogEntry {
  id: number;
  level: "info" | "dim" | "warn" | "error" | "success";
  text: string;
}

let logSeq = 0;
function mkLog(level: LogEntry["level"], text: string): LogEntry {
  return { id: logSeq++, level, text };
}

// Claim event for the on-screen reveal (ClaimReveal) — typed data so the
// animation reacts to a landed claim without parsing log strings. Purely
// additive; the terminal log is unchanged.
export interface MinerEvent {
  seq: number;              // monotonic — fires the reveal even on repeat values
  kind: "claimed";
  bonusBits: number;        // 0..=8 — the slot-machine reveal
  termGross: number;        // expected gross TERM for this claim
}
let eventSeq = 0;

function ts(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

// confirmTransaction throws "block height exceeded" when the client gives up
// polling, NOT when the tx fails — it may have already landed. Re-query
// signature status directly before treating expiration as failure.
async function confirmOrCheckLanded(
  connection: Connection,
  sig: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  try {
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (!/block height exceeded|has expired/i.test(msg)) throw err;
    const { value } = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const status = value?.[0];
    if (status && !status.err && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return;
    }
    if (status?.err) {
      const e = new Error(`Transaction failed on chain: ${JSON.stringify(status.err)}`);
      (e as any).logs = (status as any).logs;
      throw e;
    }
    throw err;
  }
}

// Map common claim errors to user-readable strings. Falls back to a clipped
// raw message so unknown errors still show something useful.
function friendlyClaimError(err: any): string {
  const msg: string = err?.message ?? String(err);
  const logs: string[] = err?.logs ?? [];
  const all = [msg, ...logs].join(" ");

  if (/InvalidProofOfWork/i.test(all))    return "Stale nonce — chain advanced before we submitted. Will retry.";
  if (/RateLimitExceeded/i.test(all))     return "Rate limit active — waiting for cooldown before next claim.";
  if (/ContractPaused/i.test(all))        return "Program is paused. Pausing miner.";
  if (/AccountFrozen/i.test(all))         return "This wallet is frozen by the freeze authority.";
  if (/SupplyCapReached/i.test(all))      return "Supply cap reached — emissions complete.";
  if (/TipExceedsCap/i.test(all))         return "Tip exceeds protocol cap (5 TERM max). Lower your tip in settings.";
  if (/TipExceedsReward/i.test(all))      return "Tip exceeds this claim's net reward. Lower your tip or wait for a higher-bonus claim.";
  if (/WrongRentPayer/i.test(all))        return "Bond rent_payer mismatch — the recorded rent payer doesn't match. Use a fresh wallet.";
  if (/insufficient (lamports|funds)/i.test(all))
                                          return "Wallet has no SOL for fees. Top up and retry.";
  if (/blockhash not found/i.test(all))   return "Network blockhash expired. Will retry next round.";
  if (/User rejected/i.test(all))         return "Transaction rejected in wallet.";

  return `Claim failed: ${msg.slice(0, 120)}`;
}

// Decide how long to wait before the next round based on error type.
// Rate limits self-resolve after the cooldown; everything else retries fast.
function backoffForError(err: any): number {
  const all = `${err?.message ?? ""} ${(err?.logs ?? []).join(" ")}`;
  if (/RateLimitExceeded/i.test(all))   return 10_000;  // just past cooldown — chain clock catches up fast; no need for a full 60s
  if (/ContractPaused/i.test(all))      return 30_000;
  if (/AccountFrozen/i.test(all))       return 60_000;
  if (/insufficient (lamports|funds)/i.test(all)) return 30_000;
  if (/User rejected/i.test(all))       return 5_000;
  return 0;
}

export function useMiner(
  connection: Connection | null,
  wallet: MinerWallet,
  broadcaster?: BroadcastAdapter,
  relayerTipTerm: number = 0,
) {
  const [status, setStatus] = useState<MinerStatus>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([
    mkLog("dim", `[${ts()}] Terminus Coin miner ready. Connect wallet to start.`),
  ]);
  const [hashrate, setHashrate] = useState<number | null>(null);
  const [lastEvent, setLastEvent] = useState<MinerEvent | null>(null);
  function emit(e: Omit<MinerEvent, "seq">) {
    setLastEvent({ ...e, seq: eventSeq++ });
  }

  const workerRef = useRef<Worker | null>(null);
  const shouldRestartRef = useRef(false);
  const lastClaimAtRef = useRef(0); // ms timestamp of the last landed claim — drives the cooldown gate
  const startRef = useRef<() => void>(() => {});

  function appendLog(level: LogEntry["level"], text: string) {
    setLogs((prev) => {
      const next = [...prev, mkLog(level, text)];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }

  const stop = useCallback(() => {
    shouldRestartRef.current = false;
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setStatus("idle");
    setHashrate(null);
    appendLog("warn", `[${ts()}] Mining stopped.`);
  }, []);

  const start = useCallback(() => {
    if (!connection || !wallet.publicKey || !wallet.signTransaction) {
      appendLog("error", `[${ts()}] Wallet not connected.`);
      return;
    }

    shouldRestartRef.current = true;

    async function mine() {
      if (!connection || !wallet.publicKey || !wallet.signTransaction) return;

      // Always fetch fresh chain state from RPC to get latest lastHash
      const provider = new AnchorProvider(
        connection,
        wallet as unknown as anchor.Wallet,
        { commitment: "confirmed" }
      );
      const program = new Program(idl as Idl, provider);

      let gs: any;
      try {
        gs = await (program.account as any).globalState.fetch(GLOBAL_STATE_PDA);
      } catch (err: any) {
        appendLog("error", `[${ts()}] Failed to fetch chain state: ${err.message}`);
        setStatus("error");
        return;
      }

      if (gs.paused) {
        appendLog("warn", `[${ts()}] Program is paused. Retrying in 10s…`);
        setStatus("idle");
        setTimeout(() => { if (shouldRestartRef.current) startRef.current(); }, 10_000);
        return;
      }

      const difficulty: string = gs.difficulty.toString();
      const lastHash: number[] = gs.lastHash;

      appendLog("info", `[${ts()}] Starting round — difficulty=${difficulty} (1 in ${difficulty} hashes avg)`);
      setStatus("mining");

      // Terminate any lingering worker
      if (workerRef.current) workerRef.current.terminate();

      const worker = new Worker(new URL("./miner.worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;

      const req: MineRequest = {
        lastHash,
        pubkey: Array.from(wallet.publicKey!.toBytes()),
        difficulty,
      };

      worker.postMessage(req);

      worker.onmessage = async (ev: MessageEvent<MineResult>) => {
        const { nonce, attempts, elapsed, bonusBits } = ev.data;
        worker.terminate();
        workerRef.current = null;

        const hr = Math.round(attempts / (elapsed / 1000));
        setHashrate(hr);

        // Epoch-aware reward for THIS block (mirrors lib.rs emission): gross =
        // base(epoch) << bits, net = minNetReward(epoch) << bits — the lucky
        // multiplier (2^bits) scales both. Hold the reveal until the claim lands
        // on chain so the slot-machine moment isn't spoiled during mining.
        const launchTime = gs.launchTime.toNumber();
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        const diff = BigInt(difficulty);
        const expectedRaw = baseRewardForEpoch(BigInt(launchTime), nowSec) << BigInt(bonusBits);
        const expectedTerm = (Number(expectedRaw) / 1e6).toFixed(2);
        const netForBonus = minNetReward(BigInt(launchTime), diff, nowSec) << BigInt(bonusBits);
        const tier = luckTier(bonusBits);
        const luckLabel = tier.label ? ` ${tier.glyph} ${tier.label}` : "";

        appendLog("dim", `[${ts()}] Found nonce ${nonce} in ${attempts.toLocaleString()} attempts (${(elapsed / 1000).toFixed(2)}s, ~${hr.toLocaleString()} H/s)`);

        if (!shouldRestartRef.current) { setStatus("idle"); return; }

        // ── Per-block tip-feasibility gate ─────────────────────────────────
        // The relayer tip is paid out of the claim's reward and the program
        // enforces tip <= net_reward. A base block can fall below the relayer's
        // floor while a luckier block (net scales 2^bits) still clears it — so
        // skip a block that can't cover the tip and re-mine, fishing for a
        // claimable lucky one. Beats submitting a doomed claim (relayer 422) or
        // stopping. No-op when tip=0 (self-fund) or the floor is feasible.
        if (relayerTipTerm > 0 && netForBonus < BigInt(Math.round(relayerTipTerm))) {
          appendLog("dim", `[${ts()}] Reward ~${expectedTerm} TERM doesn't cover the ${(relayerTipTerm / 1e6).toFixed(2)} TERM tip — need a luckier block. Re-mining…`);
          if (shouldRestartRef.current) startRef.current(); else setStatus("idle");
          return;
        }

        // ── Cooldown gate ──────────────────────────────────────────────────
        // Hold the (already-mined) nonce until the on-chain rate-limit cooldown
        // elapses, instead of firing a claim the program would reject with
        // RateLimitExceeded — which just wastes this mine + a relayer preflight.
        // The cooldown is Phase-1-only (sunsets at 1 yr), so honor it only while
        // in Phase 1. Mining usually overlaps the cooldown, so this only holds on
        // a fast nonce; the rest of the time `remaining` is already ≤ 0.
        const rateLimitSec = gs.rateLimitSeconds.toNumber();
        const inPhase1 = Date.now() / 1000 - launchTime < 31_557_600; // PHASE2_ACTIVATION_SECS
        const cooldownMs = inPhase1 && rateLimitSec > 0 ? rateLimitSec * 1000 : 0;
        if (cooldownMs > 0 && lastClaimAtRef.current > 0) {
          // +8s buffer: the on-chain rate-limit check uses Solana's clock, which
          // drifts vs real wall-time (more so on devnet), so a thin buffer lets
          // the first post-cooldown claim land a hair early and bounce off
          // RateLimitExceeded. 8s comfortably absorbs the drift.
          const remaining = lastClaimAtRef.current + cooldownMs + 8_000 - Date.now();
          if (remaining > 0) {
            appendLog("dim", `[${ts()}] Cooldown — holding ${Math.ceil(remaining / 1000)}s before claiming (nonce ready)…`);
            await new Promise((r) => setTimeout(r, remaining));
            if (!shouldRestartRef.current) { setStatus("idle"); return; }
          }
        }

        // Submit claim
        setStatus("submitting");
        appendLog("dim", `[${ts()}] Submitting claim…`);

        let backoffMs = 0;
        try {
          const userAta = getAssociatedTokenAddressSync(MINT_PDA, wallet.publicKey!);

          // Pick fee payer: broadcaster if configured (gasless mining), else wallet itself.
          const feePayerKey = broadcaster?.pubkey ?? wallet.publicKey!;
          const feePayerIsWallet = feePayerKey.equals(wallet.publicKey!);
          const feePayerAta = feePayerIsWallet
            ? userAta
            : getAssociatedTokenAddressSync(MINT_PDA, feePayerKey);

          // User's ATA — paid by fee_payer (so a 0-SOL wallet can be onboarded
          // by a relayer). Idempotent: no-op if already exists.
          const createUserAtaIx = createAssociatedTokenAccountIdempotentInstruction(
            feePayerKey,
            userAta,
            wallet.publicKey!,
            MINT_PDA
          );

          // Relayer's ATA — needed to satisfy `token::authority = fee_payer`
          // on the claim's fee_payer_token_account. Only included when
          // fee_payer != authority (gasless mode). Relayer pays for its own ATA.
          const createFeePayerAtaIx = feePayerIsWallet
            ? null
            : createAssociatedTokenAccountIdempotentInstruction(
                feePayerKey,
                feePayerAta,
                feePayerKey,
                MINT_PDA
              );

          // Anti-Sybil bond: deposit it the first time this wallet ever mines.
          // ~0.001 SOL of rent gets locked; recoverable later via withdraw_bond.
          // Detect old-format bonds (devnet upgrade artifact): expected size is
          // 57 bytes (8 disc + 49 borsh). Anything else means a stranded bond
          // from before the rent_payer field was added.
          const bondPDA = deriveBondPDA(wallet.publicKey!);
          const bondInfo = await connection!.getAccountInfo(bondPDA);
          if (bondInfo && bondInfo.data.length !== 57) {
            appendLog("error", `[${ts()}] Old-format bond detected at this address. The program was upgraded; the old bond's 0.001 SOL is stranded. Please use a fresh wallet to mine.`);
            setStatus("error");
            return;
          }
          let depositBondIx: any = null;
          if (!bondInfo) {
            depositBondIx = await (program.methods as any)
              .depositBond()
              .accounts({
                authority: wallet.publicKey,
                rentPayer: feePayerKey, // relayer pays bond rent in gasless mode
              })
              .instruction();
            appendLog("dim", `[${ts()}] First mine — also depositing 0.001 SOL bond.`);
          }

          // tip = relayerTipTerm (config'd in App.tsx via the tip selector).
          // Default 0 = self-fund/free-relay; positive values tip the
          // configured relayer in TERM out of the miner's net reward.
          const claimIx = await (program.methods as any)
            .claim(new BN(nonce), new BN(relayerTipTerm))
            .accounts({
              feePayer: feePayerKey,
              mint: MINT_PDA,
              userTokenAccount: userAta,
              feePayerTokenAccount: feePayerAta,
              authority: wallet.publicKey,
            })
            .instruction();

          const { blockhash, lastValidBlockHeight } =
            await connection!.getLatestBlockhash("confirmed");

          // CU budget: claim ~34K, ATA creation ~25K each, bond deposit ~5K when present.
          // Default 200K is wasteful and degrades scheduling.
          const cuUnits =
            (depositBondIx ? 95_000 : 75_000) +
            (createFeePayerAtaIx ? 25_000 : 0);
          const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: cuUnits });

          const tx = new Transaction({
            recentBlockhash: blockhash,
            feePayer: feePayerKey,
          });
          tx.add(cuLimitIx);
          if (createFeePayerAtaIx) tx.add(createFeePayerAtaIx);
          tx.add(createUserAtaIx);
          if (depositBondIx) tx.add(depositBondIx);
          tx.add(claimIx);

          // Authority signs first; broadcaster (local relayer or shared
          // server-side relayer) completes signing + broadcast.
          const partial = await wallet.signTransaction!(tx);
          let sig: string;
          if (broadcaster) {
            sig = await broadcaster.signAndBroadcast(partial, connection!);
          } else {
            sig = await connection!.sendRawTransaction(partial.serialize());
          }
          await confirmOrCheckLanded(connection!, sig, blockhash, lastValidBlockHeight);

          // Reveal the bonus along with the claim — the slot-machine moment.
          const level: "info" | "success" = bonusBits >= 4 ? "success" : "info";
          appendLog(level, `[${ts()}] Claimed! tx=${sig.slice(0, 16)}… — Bonus +${bonusBits} bits → ~${expectedTerm} TERM gross${luckLabel}`);
          emit({ kind: "claimed", bonusBits, termGross: Number(expectedTerm) });
          lastClaimAtRef.current = Date.now(); // arm the cooldown gate for the next round
          backoffMs = 0;
        } catch (err: any) {
          const friendly = friendlyClaimError(err);
          // Tell the user what they "would have" won so a missed jackpot feels like a story, not a silent loss.
          const missedLabel = bonusBits >= 4
            ? ` — missed +${bonusBits} bits / ${expectedTerm} TERM${luckLabel}`
            : "";
          appendLog("error", `[${ts()}] ${friendly}${missedLabel}`);
          if (friendly.startsWith("Claim failed:") && err?.logs) {
            for (const l of (err.logs as string[]).slice(0, 4))
              appendLog("error", `  ${l}`);
          }
          backoffMs = backoffForError(err);
        }

        if (shouldRestartRef.current) {
          // Re-enter through startRef so the next round picks up the latest
          // closure (broadcaster, relayerTipTerm). Calling mine() directly
          // would re-use the closure captured when the user clicked Start,
          // so mid-session tip/mode changes would silently not apply until
          // a Stop + Start cycle.
          if (backoffMs > 0) {
            appendLog("dim", `[${ts()}] Backing off ${Math.round(backoffMs / 1000)}s before next round…`);
            setTimeout(() => { if (shouldRestartRef.current) startRef.current(); }, backoffMs);
          } else {
            appendLog("dim", `[${ts()}] Restarting…`);
            startRef.current();
          }
        } else {
          setStatus("idle");
        }
      };

      worker.onerror = (e) => {
        appendLog("error", `[${ts()}] Worker error: ${e.message}`);
        setStatus("error");
        workerRef.current = null;
      };
    }

    mine();
    // broadcaster + relayerTipTerm MUST be in deps — without them, switching
    // mode mid-session or before clicking Start leaves the captured closure
    // pointing at the old routing (caused "tip doesn't deduct when SHARED
    // selected" bug). Recreating on every render is cheap.
  }, [connection, wallet, broadcaster, relayerTipTerm]);

  // keep startRef current so the auto-restart closure always calls the latest version
  useEffect(() => { startRef.current = start; }, [start]);

  // Reset the cooldown gate when the active wallet changes — last_claim_time is
  // per-wallet on-chain (a freshly-connected wallet has none), so the previous
  // wallet's cooldown must not carry over and delay its first claim.
  useEffect(() => { lastClaimAtRef.current = 0; }, [wallet.publicKey?.toBase58()]);

  // stop worker on unmount — also clear the restart flag so a claim parked on
  // the cooldown await (or mid-submit) doesn't resume and spawn a fresh worker
  // after teardown (stop() clears it on an explicit Stop; unmount must too).
  useEffect(() => () => {
    shouldRestartRef.current = false;
    workerRef.current?.terminate();
  }, []);

  return { status, logs, hashrate, lastEvent, start, stop };
}
