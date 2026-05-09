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

function ts(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
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
  if (/RateLimitExceeded/i.test(all))   return 60_000;  // matches set_rate_limit default
  if (/ContractPaused/i.test(all))      return 30_000;
  if (/AccountFrozen/i.test(all))       return 60_000;
  if (/insufficient (lamports|funds)/i.test(all)) return 30_000;
  if (/User rejected/i.test(all))       return 5_000;
  return 0;
}

export function useMiner(connection: Connection | null, wallet: MinerWallet, broadcaster?: BroadcastAdapter) {
  const [status, setStatus] = useState<MinerStatus>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([
    mkLog("dim", `[${ts()}] Terminus Coin miner ready. Connect wallet to start.`),
  ]);
  const [hashrate, setHashrate] = useState<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const shouldRestartRef = useRef(false);
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

        // Predict the reward this nonce will earn (assumes epoch 0 — UI doesn't track epoch yet)
        const baseUnscaled = 3_400_000n;
        const expectedRaw = baseUnscaled * (1n << BigInt(bonusBits));
        const expectedTerm = (Number(expectedRaw) / 1e6).toFixed(2);
        const luckLabel =
          bonusBits >= 8 ? " 🎰 JACKPOT" :
          bonusBits >= 6 ? " ⭐ BIG HIT" :
          bonusBits >= 4 ? " ✨ lucky" :
          bonusBits >= 2 ? "" : "";

        appendLog("dim", `[${ts()}] Found nonce ${nonce} in ${attempts.toLocaleString()} attempts (${(elapsed / 1000).toFixed(2)}s, ~${hr.toLocaleString()} H/s)`);
        const level: "info" | "success" = bonusBits >= 4 ? "success" : "info";
        appendLog(level, `[${ts()}] Bonus +${bonusBits} bits → ~${expectedTerm} TERM gross${luckLabel}`);

        if (!shouldRestartRef.current) { setStatus("idle"); return; }

        // Submit claim
        setStatus("submitting");
        appendLog("dim", `[${ts()}] Submitting claim…`);

        let backoffMs = 0;
        try {
          const userAta = getAssociatedTokenAddressSync(MINT_PDA, wallet.publicKey!);

          const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey!,
            userAta,
            wallet.publicKey!,
            MINT_PDA
          );

          // Anti-Sybil bond: deposit it the first time this wallet ever mines.
          // ~0.001 SOL of rent gets locked; recoverable later via withdraw_bond
          // after BOND_WITHDRAW_COOLDOWN seconds since last claim.
          const bondPDA = deriveBondPDA(wallet.publicKey!);
          const bondInfo = await connection!.getAccountInfo(bondPDA);
          let depositBondIx: any = null;
          if (!bondInfo) {
            depositBondIx = await (program.methods as any)
              .depositBond()
              .accounts({ authority: wallet.publicKey })
              .instruction();
            appendLog("dim", `[${ts()}] First mine — also depositing 0.001 SOL bond.`);
          }

          // Pick fee payer: broadcaster if configured (gasless mining), else wallet itself.
          const feePayerKey = broadcaster?.pubkey ?? wallet.publicKey!;

          const claimIx = await (program.methods as any)
            .claim(new BN(nonce))
            .accounts({
              feePayer: feePayerKey,
              mint: MINT_PDA,
              userTokenAccount: userAta,
              authority: wallet.publicKey,
            })
            .instruction();

          const { blockhash, lastValidBlockHeight } =
            await connection!.getLatestBlockhash("confirmed");

          // CU budget: claim ~34K, ATA creation ~25K, bond deposit ~5K when present.
          // Default 200K is wasteful and degrades scheduling.
          const cuUnits = depositBondIx ? 90_000 : 70_000;
          const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: cuUnits });

          const tx = new Transaction({
            recentBlockhash: blockhash,
            feePayer: feePayerKey,
          });
          if (depositBondIx) {
            tx.add(cuLimitIx, createAtaIx, depositBondIx, claimIx);
          } else {
            tx.add(cuLimitIx, createAtaIx, claimIx);
          }

          // Authority signs first; broadcaster (local relayer or shared
          // server-side relayer) completes signing + broadcast.
          const partial = await wallet.signTransaction!(tx);
          let sig: string;
          if (broadcaster) {
            sig = await broadcaster.signAndBroadcast(partial, connection!);
          } else {
            sig = await connection!.sendRawTransaction(partial.serialize());
          }
          await connection!.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

          appendLog("success", `[${ts()}] Claimed! tx=${sig.slice(0, 16)}…`);
          backoffMs = 0;
        } catch (err: any) {
          const friendly = friendlyClaimError(err);
          appendLog("error", `[${ts()}] ${friendly}`);
          if (friendly.startsWith("Claim failed:") && err?.logs) {
            for (const l of (err.logs as string[]).slice(0, 4))
              appendLog("error", `  ${l}`);
          }
          backoffMs = backoffForError(err);
        }

        if (shouldRestartRef.current) {
          if (backoffMs > 0) {
            appendLog("dim", `[${ts()}] Backing off ${Math.round(backoffMs / 1000)}s before next round…`);
            setTimeout(() => { if (shouldRestartRef.current) mine(); }, backoffMs);
          } else {
            appendLog("dim", `[${ts()}] Restarting…`);
            mine();
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
  }, [connection, wallet]);

  // keep startRef current so the auto-restart closure always calls the latest version
  useEffect(() => { startRef.current = start; }, [start]);

  // stop worker on unmount
  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  return { status, logs, hashrate, start, stop };
}
