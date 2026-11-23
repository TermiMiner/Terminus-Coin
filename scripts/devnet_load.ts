// devnet_load.ts — synthetic mining load for the devnet closed beta.
//
// WHY THIS EXISTS
//
// Difficulty holds steady only at TARGET_CLAIMS_PER_WINDOW / TARGET_WINDOW =
// 100 claims per 600s = one claim every 6 seconds. The per-wallet rate limit on
// devnet is 60s, so a single wallet can contribute at most 1 claim/min: holding
// difficulty flat needs >= 10 wallets mining continuously, and pushing it up
// needs more. Below target it falls, but only when a claim lands: a full window
// with N claims scales it by N/100, never by less than half per adjustment. So
// light continuous mining (<= 5 claims/min) halves it every 10 minutes down to
// the floor of 16, and no mining at all leaves it where it is.
//
// So MAINNET_CHECKLIST §6 ("difficulty adjustment observed working under
// varying load") cannot be satisfied by waiting for organic testers. This
// harness drives the load instead: a schedule of claim rates, and JSONL output
// you can replay to evidence the §6 criteria.
//
// ONE CLAIM IN FLIGHT. Every landed claim rotates last_hash, so only one claim
// per last_hash can land. Wallets mining in parallel against the same state
// just race each other, and the losers fail (those that get past preflight
// still pay the fee). So the harness sends one claim at a time, re-reading
// last_hash before each, and rotates through a pool of wallets only because of
// the per-wallet rate limit. Load is set in claims per minute, and since the
// harness can't collide with itself, a stale-nonce failure means someone
// else's claim landed first.
//
// LEFT RUNNING FOR WEEKS. §6 also asks for 30 days of operation, and
// scripts/devnet_load_soak.json is a 31-day schedule for it. So the harness
// can be left alone:
//   • The schedule runs on the clock from its start, which STATE_FILE keeps.
//     Started again after a crash or a reboot, it picks the schedule up where
//     the clock now is instead of starting over (--restart-schedule starts it
//     over).
//   • Pool wallets are topped up from the funding wallet as they run low,
//     within FUNDING_BUDGET_SOL for the whole schedule, and never so far that
//     the funding wallet is left with less than FUNDING_FLOOR_SOL.
//   • When claims keep failing for reasons that are not the program's (the RPC
//     node, a devnet outage), it logs an outage and backs off until claims
//     land again.
//   • Nothing it waits on can hang: each RPC request gives up after 30s and
//     each send after 2 minutes. A watchdog backs that up: if the run still
//     goes WATCHDOG_MINUTES without progress, it exits 2.
//   • When the process didn't run for a while (the host slept, or it was
//     stopped), it logs a clock_gap, so the record tells our downtime apart
//     from devnet's.
// It exits 0 when it stops on purpose (the schedule is over, Ctrl-C, the
// funding limits are reached, mining is paused), 1 when it crashes and 2 when
// the watchdog stops it. A supervisor that restarts it on failure therefore
// resumes the schedule after a crash or a hang and leaves it stopped after a
// deliberate stop.
//
// See docs/devnet-beta.md for how this fits the wider beta plan.
//
// SAFETY: refuses to run against mainnet-beta (genesis-hash check). It spends
// SOL and mints tokens; pointing it at mainnet would be unrecoverable.
//
// Usage:
//   RPC_URL=https://api.devnet.solana.com \
//   DEPLOYER=~/.config/solana/devnet-wallet.json \
//     npx ts-node -P tsconfig.json scripts/devnet_load.ts [--phases phases.json] [--restart-schedule]
//
// DEPLOYER is the wallet that funds the pool. It needs no authority over the
// program, so a long run can have a wallet of its own holding only devnet SOL.
//
// A phases file is a JSON array shaped like DEFAULT_PHASES:
//   [{ "label": "ramp-up", "claimsPerMin": 20, "minutes": 60 }, ...]
//
// Optional env:
//   WALLET_FILE         pool state (default scripts/.devnet-load-wallets.json)
//   STATE_FILE          when each schedule started and what it has spent
//                       (default scripts/.devnet-load-state.json)
//   LOG_FILE            JSONL event log (default devnet-load.jsonl)
//   MAX_WALLETS         size of the pool to create/fund (default: enough for the
//                       fastest phase under the on-chain per-wallet rate limit)
//   FUNDING_BUDGET_SOL  most SOL moved from DEPLOYER to the pool in one
//                       schedule, setup and top-ups together (default 1.5)
//   FUNDING_FLOOR_SOL   least SOL DEPLOYER is left with (default 0.5)
//   WATCHDOG_MINUTES    exit 2 after this long without progress (default 15; a
//                       slow but working claim attempt can take about 6)

import {
  AnchorProvider, BN, Program, Wallet, type Idl,
} from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Runtime IDL rather than ../target/types, so the harness runs on a bare box
// (a VPS for a multi-day soak) without the Rust/Anchor toolchain.
const idl = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../miner-ui/idl/terminuscoin.json"), "utf8"),
) as Idl;

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAX_U64 = (1n << 64n) - 1n;
const RATE_LIMIT_MARGIN_MS = 5_000; // on-chain unix_timestamp can lag the local clock
const POOL_SPARE = 2;               // wallets beyond the minimum the rate limit needs
const FAIL_BACKOFF_MS = 15_000;     // rest a wallet after an unclassified failure (RPC error, out of SOL, …)
const SETUP_LAMPORTS = 12_000_000;  // ~0.012 SOL: ATA + bond + user_state rent, plus fees to start on
const MINE_YIELD_EVERY = 20_000;    // hand the event loop back so signals and RPC stay responsive

// Top-ups. A fee payer has to keep the rent-exempt minimum for an empty
// account (890,880 lamports), so a wallet below TOPUP_BELOW has about 220
// claims' fees left. Balances are checked every BALANCE_CHECK_EVERY claims and
// after any failure, well inside that margin.
const TOPUP_BELOW = 2_000_000;      // ~0.002 SOL
const TOPUP_TO = 10_000_000;        // ~0.01 SOL, about 1,800 claims' fees
const BALANCE_CHECK_EVERY = 20;
const FEE_LAMPORTS = 5_000;         // one signature, no priority fee

// Outages: this many unclassified failures in a row (RPC errors, devnet down)
// count as one. The harness then pauses after each further failure, doubling
// from OUTAGE_PAUSE_MS up to OUTAGE_MAX_PAUSE_MS, until a claim gets an answer.
// The cap bounds how long after devnet comes back the harness notices.
const OUTAGE_AFTER = 8;
const OUTAGE_PAUSE_MS = 15_000;
const OUTAGE_MAX_PAUSE_MS = 120_000;

// Hangs. Node's fetch waits up to 5 minutes for a response, and a request sent
// on a connection that has died (the host slept, the network dropped) waits
// all of it. A send can wait longer still: while the RPC node is unreachable,
// its confirmation keeps polling for the block height.
const RPC_TIMEOUT_MS = 30_000;      // per HTTP request to the RPC node
const SEND_TIMEOUT_MS = 120_000;    // per send and confirm; a blockhash expires within about 90s
const WATCHDOG_TICK_MS = 10_000;
const CLOCK_GAP_MS = 60_000;        // a tick this late means the process didn't run: host asleep, or stopped

// Program error codes, taken from the IDL rather than hard-coded (Anchor
// numbers custom errors from 6000 in declaration order).
const errorNames = new Map((idl.errors ?? []).map((e) => [e.code, e.name]));
function errorCode(name: string): number {
  const e = (idl.errors ?? []).find((x) => x.name === name);
  if (!e) throw new Error(`IDL has no ${name} error — is miner-ui/idl/terminuscoin.json current?`);
  return e.code;
}
const INVALID_POW = errorCode("InvalidProofOfWork"); // stale: last_hash or difficulty moved first
const RATE_LIMITED = errorCode("RateLimitExceeded");
const PAUSED = errorCode("ContractPaused");
// Not retryable: mining is paused, or the supply cap is reached and mining is over.
const TERMINAL = new Set([PAUSED, errorCode("SupplyCapReached")]);

/** One phase of the load profile: send `claimsPerMin` claims a minute for `minutes`. */
type Phase = { claimsPerMin: number; minutes: number; label?: string };

// Default profile — the table in docs/devnet-beta.md. Target is 10 claims/min
// (100 per 600s window), so each rate reads as a multiple of it. Override with
// --phases.
const DEFAULT_PHASES: Phase[] = [
  { label: "baseline", claimsPerMin: 10, minutes: 60 }, // 1×   — roughly steady
  { label: "ramp-up",  claimsPerMin: 20, minutes: 60 }, // 2×   — doubles every ~5 min
  { label: "drop",     claimsPerMin: 2,  minutes: 60 }, // 0.2× — halves every 10 min
  { label: "recover",  claimsPerMin: 15, minutes: 60 }, // 1.5× — ×1.5 every ~7 min
];

/**
 * One run of a phase schedule, kept in STATE_FILE under the schedule's hash so
 * that a restart resumes it, and so that running a different schedule in
 * between does not lose its place.
 */
type Schedule = {
  startedAt: string;       // the phases run on the clock from here
  fundedLamports: number;  // moved from DEPLOYER to the pool during this schedule
  fundingTransfers: number;
};
type HarnessState = { schedules: Record<string, Schedule> };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function expand(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(expand(file), "utf8"))),
  );
}

function loadPhases(): Phase[] {
  const i = process.argv.indexOf("--phases");
  if (i === -1) return DEFAULT_PHASES;
  const phases = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8")) as Phase[];
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("--phases file must be a non-empty JSON array.");
  }
  for (const p of phases) {
    if (!(p.claimsPerMin > 0) || !(p.minutes > 0)) {
      throw new Error(`Bad phase ${JSON.stringify(p)}: needs claimsPerMin > 0 and minutes > 0.`);
    }
  }
  return phases;
}

/** An amount of SOL from the environment, in lamports. */
function solFromEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  const value = raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be an amount of SOL, 0 or more (got ${JSON.stringify(raw)}).`);
  }
  return Math.round(value * 1e9);
}

/** A number of minutes from the environment, in milliseconds. */
function minutesFromEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  const value = raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a number of minutes above 0 (got ${JSON.stringify(raw)}).`);
  }
  return value * 60_000;
}

const sol = (lamports: number) =>
  (lamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${min}m` : `${min}m`;
}

/** Something loggable for anything thrown, including values that aren't Errors. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  let json: string | undefined;
  try { json = JSON.stringify(err); } catch { /* circular */ }
  return `${(err as any)?.constructor?.name ?? typeof err} ${json ?? String(err)}`;
}

/** Reject if `p` hasn't settled within `ms`. The work behind `p` isn't cancelled. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The program error code in a failed send, whichever way it failed:
 *   rejected by preflight → "... custom program error: 0x1771 ..."
 *   failed on-chain       → "... Status: ({"err":{"InstructionError":[0,{"Custom":6001}]}}) ..."
 * Which one a stale claim hits depends on whether the claim that beat it had
 * confirmed by the time ours was simulated.
 */
function programErrorCode(err: unknown): number | undefined {
  const msg = describeError(err);
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(msg);
  if (hex) return parseInt(hex[1], 16);
  const dec = /"Custom":(\d+)/.exec(msg);
  return dec ? Number(dec[1]) : undefined;
}

function meetsDifficulty(hash: Uint8Array, target: bigint): boolean {
  let high = 0n;
  for (let i = 0; i < 8; i++) high = (high << 8n) | BigInt(hash[i]);
  return high <= target;
}

/**
 * Mine a nonce for `user` against `lastHash`. Mirrors the on-chain preimage:
 * 72 bytes = nonce (u64 LE) || last_hash (32) || miner pubkey (32).
 *
 * Yields to the event loop periodically, so a long search at high difficulty
 * doesn't block signal handling or the RPC connection, and calls `onYield`
 * each time so the watchdog can see it working.
 */
async function mineNonce(
  lastHash: number[], user: PublicKey, difficulty: bigint, onYield: () => void,
): Promise<{ nonce: BN; attempts: number }> {
  const target = difficulty <= 1n ? MAX_U64 : MAX_U64 / difficulty;
  const input = new Uint8Array(72);
  input.set(lastHash, 8);
  input.set(user.toBytes(), 40);
  const view = new DataView(input.buffer);
  let attempts = 0;
  for (let n = 0n; ; n++) {
    view.setBigUint64(0, n, true);
    attempts++;
    if (meetsDifficulty(keccak_256(input), target)) {
      return { nonce: new BN(n.toString()), attempts };
    }
    if (attempts % MINE_YIELD_EVERY === 0) {
      onYield();
      await new Promise((r) => setImmediate(r));
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rpc = (process.env.RPC_URL ?? "").trim();
  const deployerFile = (process.env.DEPLOYER ?? "").trim();
  if (!rpc) throw new Error("RPC_URL is not set.");
  if (!deployerFile) throw new Error("DEPLOYER (path to funding keypair) is not set.");
  const budgetLamports = solFromEnv("FUNDING_BUDGET_SOL", 1.5);
  const floorLamports = solFromEnv("FUNDING_FLOOR_SOL", 0.5);
  const watchdogMs = minutesFromEnv("WATCHDOG_MINUTES", 15);

  const conn = new Connection(rpc, {
    commitment: "confirmed",
    fetch: (input, init) => fetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(RPC_TIMEOUT_MS)])
        : AbortSignal.timeout(RPC_TIMEOUT_MS),
    }),
  });
  const send = (tx: Transaction, signers: Keypair[]) => withTimeout(
    sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" }),
    SEND_TIMEOUT_MS, "Send and confirm");

  // Refuse mainnet. This harness mints and spends; there is no undo.
  const genesis = await conn.getGenesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new Error("Refusing to run: RPC_URL points at mainnet-beta. This harness is devnet-only.");
  }
  console.log(`Cluster genesis : ${genesis} (not mainnet — ok)`);

  const phases = loadPhases();
  const logFile = expand(process.env.LOG_FILE ?? "devnet-load.jsonl");
  const log = fs.createWriteStream(logFile, { flags: "a" });
  const emit = (ev: Record<string, unknown>) =>
    log.write(JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n");

  // ── Watchdog ────────────────────────────────────────────────────────────────
  // With every request and send bounded, the run never goes long without
  // progress. If it does anyway, something is stuck, and exiting 2 lets a
  // supervisor restart it into the same schedule. A tick that arrives late
  // means the process wasn't running at all, so that is logged as a clock_gap
  // and not counted as a hang. The timer is left referenced on purpose: if the
  // run ever awaited a promise with nothing behind it, Node would otherwise
  // drain the event loop and exit 0, which a supervisor reads as a deliberate
  // stop.
  let activity = "starting";
  let lastProgress = Date.now();
  const progress = (what?: string) => {
    lastProgress = Date.now();
    if (what) activity = what;
  };
  let lastTick = Date.now();
  let watchdogFired = false;
  const watchdog = setInterval(() => {
    if (watchdogFired) return; // exiting; the log may already be closed
    const now = Date.now();
    const late = now - lastTick - WATCHDOG_TICK_MS;
    lastTick = now;
    if (late > CLOCK_GAP_MS) {
      emit({ event: "clock_gap", seconds: Math.round(late / 1000), activity });
      console.log(`\n  The process didn't run for ${duration(late)}: the host slept, or the process was stopped.`);
      lastProgress = now;
    } else if (now - lastProgress > watchdogMs) {
      watchdogFired = true;
      emit({ event: "watchdog", seconds: Math.round((now - lastProgress) / 1000), activity });
      console.error(`\nWatchdog: no progress for ${duration(now - lastProgress)} while ${activity}. Exiting 2.`);
      setTimeout(() => process.exit(2), 5_000).unref();
      log.end(() => process.exit(2));
    }
  }, WATCHDOG_TICK_MS);

  const deployer = loadKeypair(deployerFile);
  const provider = new AnchorProvider(conn, new Wallet(deployer), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  // The IDL is loaded at runtime, so there are no generated account types.
  // One narrow accessor keeps the cast in a single place instead of at each use.
  const fetchGlobalState = (pda: PublicKey): Promise<any> =>
    (program.account as any).globalState.fetch(pda);

  const [globalStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state_final_2026")], program.programId);
  const [mintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint")], program.programId);

  // Each wallet can claim once per walletGapMs, so the pool has to cover the
  // fastest phase. Read the limit from chain rather than assuming devnet's 60s.
  const rateLimitSecs = Number((await fetchGlobalState(globalStatePDA)).rateLimitSeconds);
  const walletGapMs = rateLimitSecs > 0 ? rateLimitSecs * 1000 + RATE_LIMIT_MARGIN_MS : 0;
  const maxRate = Math.max(...phases.map((p) => p.claimsPerMin));
  const poolNeeded = Math.ceil((maxRate * walletGapMs) / 60_000) + POOL_SPARE;
  const poolSize = Number(process.env.MAX_WALLETS ?? 0) || poolNeeded;
  const walletFile = expand(process.env.WALLET_FILE ?? path.join(__dirname, ".devnet-load-wallets.json"));
  const stateFile = expand(process.env.STATE_FILE ?? path.join(__dirname, ".devnet-load-state.json"));

  // ── Schedule (persisted) ────────────────────────────────────────────────────
  // The phases run on the clock from the schedule's start. Started again before
  // the schedule is over, the harness resumes it in the phase the clock is in.
  const phasesKey = crypto.createHash("sha256")
    .update(JSON.stringify(phases.map((p) => [p.label ?? "", p.claimsPerMin, p.minutes])))
    .digest("hex");
  const totalMs = phases.reduce((t, p) => t + p.minutes * 60_000, 0);
  const state: HarnessState = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
    : { schedules: {} };
  state.schedules ??= {};
  const prior = state.schedules[phasesKey];
  const resumed = !process.argv.includes("--restart-schedule")
    && !!prior && Date.parse(prior.startedAt) + totalMs > Date.now();
  const sched: Schedule = resumed
    ? prior
    : { startedAt: new Date().toISOString(), fundedLamports: 0, fundingTransfers: 0 };
  state.schedules[phasesKey] = sched;
  const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  saveState();
  const scheduleStart = Date.parse(sched.startedAt);

  console.log(`Program         : ${program.programId.toBase58()}`);
  console.log(`Funding wallet  : ${deployer.publicKey.toBase58()} (${sol(await conn.getBalance(deployer.publicKey))} SOL)`);
  console.log(`Funding limits  : ${sol(budgetLamports)} SOL for this schedule, ${sol(sched.fundedLamports)} used so far; ` +
    `the funding wallet keeps at least ${sol(floorLamports)} SOL`);
  console.log(`Rate limit      : ${rateLimitSecs}s per wallet`);
  console.log(`Pool size       : ${poolSize}${poolSize < poolNeeded ? ` (below the ${poolNeeded} the fastest phase needs — it will fall short)` : ""}`);
  console.log(`Event log       : ${logFile}`);
  console.log(`Phases          : ${phases.map((p) => `${p.label ?? "?"}(${p.claimsPerMin}/min × ${duration(p.minutes * 60_000)})`).join(" → ")}`);
  console.log(`Schedule        : ${resumed ? `resuming the one started ${sched.startedAt}, ${duration(Date.now() - scheduleStart)} in` : "starting now"}; ` +
    `${duration(totalMs)} in all, ending ${new Date(scheduleStart + totalMs).toISOString()}`);
  emit({
    event: resumed ? "schedule_resume" : "schedule_start", startedAt: sched.startedAt,
    phases: phasesKey, totalMinutes: totalMs / 60_000,
  });

  // ── Stopping ────────────────────────────────────────────────────────────────
  // Every deliberate stop goes through stop(): the reason is printed and logged
  // at the end, and the process exits 0.
  let stopping = false;
  let stopReason = "";
  const stop = (reason: string) => {
    if (!stopping) { stopping = true; stopReason = reason; }
  };
  let signals = 0;
  const onSignal = (name: string) => {
    if (++signals > 1) process.exit(130);
    console.log(`\n${name}: stopping after the in-flight claim… (again to quit at once)`);
    stop(`Stopped by ${name}. Start it again to resume the schedule.`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  /**
   * Move SOL from the funding wallet to a pool wallet. Refuses, and stops the
   * run, rather than take this schedule past FUNDING_BUDGET_SOL or leave the
   * funding wallet below FUNDING_FLOOR_SOL.
   */
  async function fund(to: PublicKey, lamports: number, why: "setup" | "topup"): Promise<boolean> {
    progress("funding a wallet");
    const funderBalance = await conn.getBalance(deployer.publicKey);
    let refusal = "";
    if (sched.fundedLamports + lamports > budgetLamports) {
      refusal = `the funding budget is used up. This schedule has moved ${sol(sched.fundedLamports)} SOL to the pool, ` +
        `FUNDING_BUDGET_SOL is ${sol(budgetLamports)}, and a ${why} needs ${sol(lamports)} more. ` +
        "Raise FUNDING_BUDGET_SOL and start it again to carry on.";
    } else if (funderBalance - lamports - FEE_LAMPORTS < floorLamports) {
      refusal = `the funding wallet holds ${sol(funderBalance)} SOL, and a ${why} of ${sol(lamports)} would take it ` +
        `below FUNDING_FLOOR_SOL (${sol(floorLamports)}). Add SOL to ${deployer.publicKey.toBase58()} and start it again to carry on.`;
    }
    if (refusal) {
      emit({
        event: "funding_stop", why, wallet: to.toBase58(), lamports,
        fundedLamports: sched.fundedLamports, funderBalance, reason: refusal,
      });
      stop(`Stopped: ${refusal}`);
      return false;
    }
    // Counted before it is sent, so a transfer whose outcome is unknown still
    // counts against the budget.
    sched.fundedLamports += lamports;
    sched.fundingTransfers += 1;
    saveState();
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: deployer.publicKey, toPubkey: to, lamports,
    }));
    const sig = await send(tx, [deployer]);
    emit({ event: "fund", why, wallet: to.toBase58(), lamports, sig, fundedLamports: sched.fundedLamports });
    return true;
  }

  // ── Wallet pool (persisted) ─────────────────────────────────────────────────
  // Reused across runs on purpose: each wallet's bond, ATA and user_state are
  // already paid for, so a restart doesn't pay that rent again.
  let secrets: number[][] = fs.existsSync(walletFile)
    ? JSON.parse(fs.readFileSync(walletFile, "utf8"))
    : [];
  while (secrets.length < poolSize) secrets.push(Array.from(Keypair.generate().secretKey));
  fs.writeFileSync(walletFile, JSON.stringify(secrets));
  const miners = secrets.slice(0, poolSize).map((s) => Keypair.fromSecretKey(new Uint8Array(s)));
  console.log(`Wallet pool     : ${walletFile} (${miners.length} wallets)\n`);

  // ── Fund + set up each wallet (idempotent) ──────────────────────────────────
  for (const [i, kp] of miners.entries()) {
    progress("setting up wallets");
    const bal = await conn.getBalance(kp.publicKey);
    if (bal < SETUP_LAMPORTS / 2 && !(await fund(kp.publicKey, SETUP_LAMPORTS, "setup"))) break;

    const ata = getAssociatedTokenAddressSync(mintPDA, kp.publicKey);
    const [bondPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("bond"), kp.publicKey.toBuffer()], program.programId);

    const needAta = !(await conn.getAccountInfo(ata));
    const needBond = !(await conn.getAccountInfo(bondPDA));
    if (needAta || needBond) {
      const tx = new Transaction();
      if (needAta) {
        tx.add(createAssociatedTokenAccountIdempotentInstruction(
          kp.publicKey, ata, kp.publicKey, mintPDA));
      }
      if (needBond) {
        // rent_payer is its own signer. Left out, Anchor fills in the provider
        // wallet (the deployer), which doesn't sign here and the send fails.
        // The miner pays its own bond rent out of SETUP_LAMPORTS.
        tx.add(await program.methods.depositBond()
          .accounts({ authority: kp.publicKey, rentPayer: kp.publicKey }).instruction());
      }
      await send(tx, [kp]);
      emit({ event: "wallet_setup", wallet: kp.publicKey.toBase58(), ata: needAta, bond: needBond });
    }
    process.stdout.write(`\rPrepared ${i + 1}/${miners.length} wallets`);
  }
  console.log("\n");

  // ── Mining loop ─────────────────────────────────────────────────────────────
  const sleepUntil = async (t: number, what = "waiting for the next slot") => {
    activity = what;
    while (!stopping && Date.now() < t) {
      progress();
      await new Promise((r) => setTimeout(r, Math.min(1_000, t - Date.now())));
    }
  };

  // When each wallet may claim next. Starts at 0: a wallet that claimed just
  // before a restart gets one RateLimitExceeded and backs off.
  const nextEligible = new Map<string, number>(miners.map((kp) => [kp.publicKey.toBase58(), 0]));
  // Claims since each wallet's balance was last checked; absent means check now.
  const claimsSinceCheck = new Map<string, number>();
  let lastSeenDifficulty = -1n;
  // The last_hash our most recent landed claim consumed. Seeing it again means
  // the RPC node hasn't caught up with that claim yet.
  let consumedHash = "";

  type Outcome = "ok" | "stale" | "ratelimit" | "error" | "terminal";

  /** One claim attempt for `kp` against fresh state. Never throws. */
  async function attemptClaim(kp: Keypair): Promise<Outcome> {
    const key = kp.publicKey.toBase58();
    try {
      // Top the wallet up before it runs dry.
      const since = claimsSinceCheck.get(key);
      if (since === undefined || since >= BALANCE_CHECK_EVERY) {
        progress("checking a wallet's balance");
        const balance = await conn.getBalance(kp.publicKey);
        if (balance < TOPUP_BELOW && !(await fund(kp.publicKey, TOPUP_TO - balance, "topup"))) {
          return "terminal";
        }
        claimsSinceCheck.set(key, 0);
      }
      claimsSinceCheck.set(key, claimsSinceCheck.get(key)! + 1);

      progress("reading the program's state");
      let state = await fetchGlobalState(globalStatePDA);
      for (let i = 0; i < 10 && Buffer.from(state.lastHash).toString("hex") === consumedHash; i++) {
        await new Promise((r) => setTimeout(r, 400));
        state = await fetchGlobalState(globalStatePDA);
      }
      const difficulty = BigInt(state.difficulty.toString());

      // Difficulty transitions are the §6 evidence — record every change we see.
      if (difficulty !== lastSeenDifficulty) {
        emit({ event: "difficulty", difficulty: difficulty.toString(), totalClaims: Number(state.totalClaims) });
        if (lastSeenDifficulty !== -1n) {
          console.log(`\n  difficulty ${lastSeenDifficulty} → ${difficulty}`);
        }
        lastSeenDifficulty = difficulty;
      }

      progress("mining");
      const t0 = Date.now();
      const { nonce, attempts } = await mineNonce(
        state.lastHash as number[], kp.publicKey, difficulty, () => progress());
      const mineMs = Date.now() - t0;
      const ata = getAssociatedTokenAddressSync(mintPDA, kp.publicKey);
      const ix = await program.methods.claim(nonce, new BN(0))
        .accounts({
          feePayer: kp.publicKey,
          userTokenAccount: ata,
          feePayerTokenAccount: ata,
          authority: kp.publicKey,
        }).instruction();
      progress("sending a claim");
      const sig = await send(new Transaction().add(ix), [kp]);
      nextEligible.set(key, Date.now() + walletGapMs);
      consumedHash = Buffer.from(state.lastHash).toString("hex");
      emit({
        event: "claim_ok", wallet: key, sig, attempts, mineMs,
        confirmMs: Date.now() - t0 - mineMs, difficulty: difficulty.toString(),
      });
      return "ok";
    } catch (err) {
      const code = programErrorCode(err);
      // stale:     another claim landed after we read last_hash, or moved the
      //            difficulty. Expected under contention; the wallet stays
      //            eligible and retries on the next slot with fresh state.
      // ratelimit: the on-chain cooldown, mostly right after a restart.
      // terminal:  paused, or the supply cap is reached; the run stops.
      const kind: Outcome =
        code === INVALID_POW ? "stale"
        : code === RATE_LIMITED ? "ratelimit"
        : code !== undefined && TERMINAL.has(code) ? "terminal"
        : "error";
      if (kind === "ratelimit") nextEligible.set(key, Date.now() + walletGapMs);
      else if (kind === "error") {
        nextEligible.set(key, Date.now() + FAIL_BACKOFF_MS);
        claimsSinceCheck.delete(key); // it may have run out of SOL: check before its next claim
      } else if (kind === "terminal") {
        stop(code === PAUSED
          ? "Stopped: mining is paused on-chain (set_paused). Unpause it, then start the harness again to resume the schedule."
          : "Stopped: the supply cap is reached, so mining is over.");
      }
      emit({
        event: "claim_fail", wallet: key, kind, code: code ?? null,
        error: (code !== undefined && errorNames.get(code)) || describeError(err).slice(0, 200),
      });
      return kind;
    }
  }

  /** The wallet whose rate-limit window closed first, and when it did. */
  function pickWallet(): { kp: Keypair; readyAt: number } {
    let kp = miners[0];
    let readyAt = nextEligible.get(kp.publicKey.toBase58())!;
    for (const m of miners) {
      const at = nextEligible.get(m.publicKey.toBase58())!;
      if (at < readyAt) { kp = m; readyAt = at; }
    }
    return { kp, readyAt };
  }

  // Outage tracking: unclassified failures since a claim last got an answer
  // from the program (landed, stale or rate-limited all count as answers).
  let failuresInARow = 0;
  let outageSince = 0;

  // Phases run back to back on the clock from the schedule's start. On a
  // resumed schedule, phases already over are skipped and the current one is
  // joined part way through.
  let phaseStart = scheduleStart;
  let firstPhaseHere = true;
  for (const phase of phases) {
    const until = phaseStart + phase.minutes * 60_000;
    const scheduledStart = phaseStart;
    phaseStart = until;
    if (stopping) break;
    if (until <= Date.now()) continue;
    const joined = resumed && firstPhaseHere;
    firstPhaseHere = false;

    const intervalMs = 60_000 / phase.claimsPerMin;
    const start = Date.now();
    console.log(`\n── phase ${phase.label ?? ""}: ${phase.claimsPerMin} claims/min for ${duration(until - start)}` +
      `${joined ? ` (resumed; the phase began ${new Date(scheduledStart).toISOString()})` : ""} ──`);
    emit({
      event: "phase_start", label: phase.label, claimsPerMin: phase.claimsPerMin, minutes: phase.minutes,
      until: new Date(until).toISOString(), resumed: joined,
    });

    const tally: Record<Outcome, number> = { ok: 0, stale: 0, ratelimit: 0, error: 0, terminal: 0 };
    let slotAt = start;
    while (!stopping) {
      // The next slot on the schedule, or later if every wallet is still
      // rate-limited (a pool too small for this rate).
      const { kp, readyAt } = pickWallet();
      const at = Math.max(slotAt, readyAt);
      if (at >= until) break;
      await sleepUntil(at);
      if (stopping) break;

      const outcome = await attemptClaim(kp);
      progress();
      tally[outcome]++;

      // A run of failures the program didn't cause is the RPC node or devnet
      // itself. Log when it starts and ends (docs/devnet-beta.md: record
      // devnet's own outages), and back off instead of hammering it.
      if (outcome === "error") {
        failuresInARow++;
        if (failuresInARow === OUTAGE_AFTER) {
          outageSince = Date.now();
          emit({ event: "outage_start", failures: failuresInARow });
          console.log(`\n  ${failuresInARow} failures in a row: treating it as an outage and backing off`);
        }
        if (failuresInARow >= OUTAGE_AFTER) {
          const pause = Math.min(OUTAGE_MAX_PAUSE_MS,
            OUTAGE_PAUSE_MS * 2 ** Math.min(10, failuresInARow - OUTAGE_AFTER));
          await sleepUntil(Math.min(Date.now() + pause, until), "pausing for an outage");
        }
      } else if (outcome !== "terminal") {
        if (outageSince) {
          emit({ event: "outage_end", seconds: Math.round((Date.now() - outageSince) / 1000), failures: failuresInARow });
          console.log(`\n  outage over after ${duration(Date.now() - outageSince)}`);
          outageSince = 0;
        }
        failuresInARow = 0;
      }

      // A claim that overran its slot pushes the schedule back rather than
      // being followed by a burst to catch up.
      slotAt = Math.max(slotAt + intervalMs, Date.now());
      const perMin = tally.ok / ((Date.now() - start) / 60_000);
      process.stdout.write(
        `\r  ok=${tally.ok} stale=${tally.stale} ratelimit=${tally.ratelimit} err=${tally.error}` +
        `  ${perMin.toFixed(1)}/${phase.claimsPerMin} per min  diff=${lastSeenDifficulty}   `);
    }
    const achievedPerMin = tally.ok / ((Date.now() - start) / 60_000);
    emit({
      event: "phase_end", label: phase.label, ...tally,
      claimsPerMin: phase.claimsPerMin, achievedPerMin: Number(achievedPerMin.toFixed(2)),
    });
    console.log("");
  }

  if (!stopping) {
    stop("The schedule is over.");
    emit({ event: "schedule_end", startedAt: sched.startedAt, fundedLamports: sched.fundedLamports });
  }
  clearInterval(watchdog);
  emit({ event: "run_end", reason: stopReason });
  await new Promise<void>((r) => log.end(() => r()));
  console.log(`\n${stopReason}\nEvent log: ${logFile}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("Error:", err?.message ?? err);
    if (err?.logs) console.error(err.logs.join("\n"));
    process.exit(1);
  },
);
