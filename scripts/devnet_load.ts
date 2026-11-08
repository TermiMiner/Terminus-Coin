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
// See docs/devnet-beta.md for how this fits the wider beta plan.
//
// SAFETY: refuses to run against mainnet-beta (genesis-hash check). It spends
// SOL and mints tokens; pointing it at mainnet would be unrecoverable.
//
// Usage:
//   RPC_URL=https://api.devnet.solana.com \
//   DEPLOYER=~/.config/solana/devnet-wallet.json \
//     npx ts-node -P tsconfig.json scripts/devnet_load.ts [--phases phases.json]
//
// A phases file is a JSON array shaped like DEFAULT_PHASES:
//   [{ "label": "ramp-up", "claimsPerMin": 20, "minutes": 60 }, ...]
//
// Optional env:
//   WALLET_FILE   pool state (default scripts/.devnet-load-wallets.json)
//   LOG_FILE      JSONL event log (default devnet-load.jsonl)
//   MAX_WALLETS   size of the pool to create/fund (default: enough for the
//                 fastest phase under the on-chain per-wallet rate limit)

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
const SETUP_LAMPORTS = 12_000_000;  // ~0.012 SOL: ATA + bond + user_state rent, plus fees for a long run
const MINE_YIELD_EVERY = 20_000;    // hand the event loop back so signals and RPC stay responsive

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
// Not retryable: mining is paused, or the supply cap is reached and mining is over.
const TERMINAL = new Set([errorCode("ContractPaused"), errorCode("SupplyCapReached")]);

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

/** Something loggable for anything thrown, including values that aren't Errors. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  let json: string | undefined;
  try { json = JSON.stringify(err); } catch { /* circular */ }
  return `${(err as any)?.constructor?.name ?? typeof err} ${json ?? String(err)}`;
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
 * doesn't block signal handling or the RPC connection.
 */
async function mineNonce(
  lastHash: number[], user: PublicKey, difficulty: bigint,
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

  const conn = new Connection(rpc, "confirmed");

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

  console.log(`Program         : ${program.programId.toBase58()}`);
  console.log(`Funding wallet  : ${deployer.publicKey.toBase58()}`);
  console.log(`Rate limit      : ${rateLimitSecs}s per wallet`);
  console.log(`Pool size       : ${poolSize}${poolSize < poolNeeded ? ` (below the ${poolNeeded} the fastest phase needs — it will fall short)` : ""}`);
  console.log(`Event log       : ${logFile}`);
  console.log(`Phases          : ${phases.map((p) => `${p.label ?? "?"}(${p.claimsPerMin}/min × ${p.minutes}m)`).join(" → ")}`);

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
    const bal = await conn.getBalance(kp.publicKey);
    if (bal < SETUP_LAMPORTS / 2) {
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: SETUP_LAMPORTS,
      }));
      await sendAndConfirmTransaction(conn, tx, [deployer], { commitment: "confirmed" });
    }

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
      await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
      emit({ event: "wallet_setup", wallet: kp.publicKey.toBase58(), ata: needAta, bond: needBond });
    }
    process.stdout.write(`\rPrepared ${i + 1}/${miners.length} wallets`);
  }
  console.log("\n");

  // ── Mining loop ─────────────────────────────────────────────────────────────
  let stopping = false;
  process.on("SIGINT", () => { console.log("\nStopping after the in-flight claim…"); stopping = true; });

  const sleepUntil = async (t: number) => {
    while (!stopping && Date.now() < t) {
      await new Promise((r) => setTimeout(r, Math.min(1_000, t - Date.now())));
    }
  };

  // When each wallet may claim next. Starts at 0: a wallet that claimed just
  // before a restart gets one RateLimitExceeded and backs off.
  const nextEligible = new Map<string, number>(miners.map((kp) => [kp.publicKey.toBase58(), 0]));
  let lastSeenDifficulty = -1n;
  // The last_hash our most recent landed claim consumed. Seeing it again means
  // the RPC node hasn't caught up with that claim yet.
  let consumedHash = "";

  type Outcome = "ok" | "stale" | "ratelimit" | "error" | "terminal";

  /** One claim attempt for `kp` against fresh state. Never throws. */
  async function attemptClaim(kp: Keypair): Promise<Outcome> {
    const key = kp.publicKey.toBase58();
    try {
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

      const t0 = Date.now();
      const { nonce, attempts } = await mineNonce(state.lastHash as number[], kp.publicKey, difficulty);
      const mineMs = Date.now() - t0;
      const ata = getAssociatedTokenAddressSync(mintPDA, kp.publicKey);
      const ix = await program.methods.claim(nonce, new BN(0))
        .accounts({
          feePayer: kp.publicKey,
          userTokenAccount: ata,
          feePayerTokenAccount: ata,
          authority: kp.publicKey,
        }).instruction();
      const sig = await sendAndConfirmTransaction(
        conn, new Transaction().add(ix), [kp], { commitment: "confirmed" });
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
      else if (kind === "error") nextEligible.set(key, Date.now() + FAIL_BACKOFF_MS);
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

  for (const phase of phases) {
    if (stopping) break;
    const intervalMs = 60_000 / phase.claimsPerMin;
    const start = Date.now();
    const until = start + phase.minutes * 60_000;
    console.log(`\n── phase ${phase.label ?? ""}: ${phase.claimsPerMin} claims/min for ${phase.minutes}m ──`);
    emit({ event: "phase_start", label: phase.label, claimsPerMin: phase.claimsPerMin, minutes: phase.minutes });

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
      tally[outcome]++;
      // Nothing more mining can fix — stop rather than spin against a paused
      // or exhausted program.
      if (outcome === "terminal") {
        console.log("\n  terminal program error — stopping. See the log.");
        stopping = true;
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

  emit({ event: "run_end" });
  log.end();
  console.log("\nDone. Event log:", logFile);
}

main().catch((err) => {
  console.error("Error:", err?.message ?? err);
  if (err?.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
