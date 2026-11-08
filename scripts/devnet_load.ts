// devnet_load.ts — synthetic mining load for the devnet closed beta.
//
// WHY THIS EXISTS
//
// Difficulty holds steady only at TARGET_CLAIMS_PER_WINDOW / TARGET_WINDOW =
// 100 claims per 600s = one claim every 6 seconds. The per-wallet rate limit on
// devnet is 60s, so a single wallet can contribute at most 1 claim/min: holding
// difficulty flat needs >= 10 wallets mining continuously, and pushing it up
// needs more. Below that, every window expires under target and difficulty
// halves — from the initial 4096 it reaches the floor of 16 in eight windows
// (~80 minutes) and pins there.
//
// So MAINNET_CHECKLIST §6 ("difficulty adjustment observed working under
// varying load") cannot be satisfied by waiting for organic testers. This
// harness drives the load instead: N wallets, a phase schedule that varies N
// over time, and JSONL output you can replay to evidence the §6 criteria.
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
// Optional env:
//   WALLET_FILE   pool state (default scripts/.devnet-load-wallets.json)
//   LOG_FILE      JSONL event log (default devnet-load.jsonl)
//   MAX_WALLETS   size of the pool to create/fund (default: max across phases)

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
const RATE_LIMIT_MS = 60_000;      // devnet set_rate_limit(60); claims closer than this are rejected on-chain
const SETUP_LAMPORTS = 12_000_000; // ~0.012 SOL: ATA + bond + user_state rent, plus fees for a long run
const MINE_YIELD_EVERY = 20_000;   // hand the event loop back so RPC stays responsive

/** One phase of the load profile: hold `wallets` active for `minutes`. */
type Phase = { wallets: number; minutes: number; label?: string };

// Default profile — the ramp from docs/devnet-beta.md. Override with --phases.
const DEFAULT_PHASES: Phase[] = [
  { label: "baseline", wallets: 12, minutes: 60 },
  { label: "ramp-up",  wallets: 30, minutes: 120 },
  { label: "drop",     wallets: 2,  minutes: 90 },
  { label: "recover",  wallets: 12, minutes: 120 },
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

function meetsDifficulty(hash: Uint8Array, target: bigint): boolean {
  let high = 0n;
  for (let i = 0; i < 8; i++) high = (high << 8n) | BigInt(hash[i]);
  return high <= target;
}

/**
 * Mine a nonce for `user` against `lastHash`. Mirrors the on-chain preimage:
 * 72 bytes = nonce (u64 LE) || last_hash (32) || miner pubkey (32).
 *
 * Yields to the event loop periodically — without that, one wallet mining a
 * high difficulty would stall every other wallet's RPC and starve the pool.
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

  const phases: Phase[] = (() => {
    const i = process.argv.indexOf("--phases");
    if (i === -1) return DEFAULT_PHASES;
    return JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8")) as Phase[];
  })();

  const poolSize = Number(process.env.MAX_WALLETS ?? 0)
    || Math.max(...phases.map((p) => p.wallets));
  const walletFile = expand(process.env.WALLET_FILE ?? path.join(__dirname, ".devnet-load-wallets.json"));
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

  console.log(`Program         : ${program.programId.toBase58()}`);
  console.log(`Funding wallet  : ${deployer.publicKey.toBase58()}`);
  console.log(`Pool size       : ${poolSize}`);
  console.log(`Event log       : ${logFile}`);
  console.log(`Phases          : ${phases.map((p) => `${p.label ?? "?"}(${p.wallets}w/${p.minutes}m)`).join(" → ")}`);

  // ── Wallet pool (persisted) ─────────────────────────────────────────────────
  // Reused across runs on purpose: each wallet's bond, ATA and user_state are
  // already paid for, so a restart doesn't re-rent them or re-trip the
  // relayer's per-wallet topup quota.
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
        tx.add(await program.methods.depositBond()
          .accounts({ authority: kp.publicKey }).instruction());
      }
      await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
      emit({ event: "wallet_setup", wallet: kp.publicKey.toBase58(), ata: needAta, bond: needBond });
    }
    process.stdout.write(`\rPrepared ${i + 1}/${miners.length} wallets`);
  }
  console.log("\n");

  // ── Mining loop ─────────────────────────────────────────────────────────────
  let stopping = false;
  process.on("SIGINT", () => { console.log("\nStopping after in-flight claims…"); stopping = true; });

  // Seeded with a stagger rather than left empty. An empty map makes every
  // wallet eligible on the first cycle: all N mine the same last_hash, all
  // submit, one lands and rotates it, and the other N-1 fail InvalidProofOfWork.
  // That never settles — only the winner's timestamp advances — so the pool
  // burns N times the CPU per landed claim and fills the log with failures that
  // look like breakage. Spreading first eligibility across the rate-limit window
  // puts roughly one wallet in play at a time instead.
  const lastClaimAt = new Map<string, number>();
  const t0run = Date.now();
  miners.forEach((kp, i) => {
    const offset = Math.round((i / Math.max(miners.length, 1)) * RATE_LIMIT_MS);
    lastClaimAt.set(kp.publicKey.toBase58(), t0run - RATE_LIMIT_MS + offset);
  });
  let lastSeenDifficulty = -1n;

  /** Outcome of one wallet's turn. Only "ok" means a claim landed. */
  type Outcome = "ok" | "skip" | "stale" | "ratelimit" | "error" | "terminal";

  async function attemptClaim(kp: Keypair): Promise<Outcome> {
    const key = kp.publicKey.toBase58();
    const since = Date.now() - (lastClaimAt.get(key) ?? 0);
    if (since < RATE_LIMIT_MS) return "skip";

    const state = await fetchGlobalState(globalStatePDA);
    const difficulty = BigInt(state.difficulty.toString());

    // Difficulty transitions are the §6 evidence — record every change we see.
    if (difficulty !== lastSeenDifficulty) {
      emit({ event: "difficulty", difficulty: difficulty.toString(), totalClaims: Number(state.totalClaims) });
      if (lastSeenDifficulty !== -1n) {
        console.log(`  difficulty ${lastSeenDifficulty} → ${difficulty}`);
      }
      lastSeenDifficulty = difficulty;
    }

    const t0 = Date.now();
    const { nonce, attempts } = await mineNonce(state.lastHash as number[], kp.publicKey, difficulty);
    const ata = getAssociatedTokenAddressSync(mintPDA, kp.publicKey);

    try {
      const ix = await program.methods.claim(nonce, new BN(0))
        .accounts({
          feePayer: kp.publicKey,
          userTokenAccount: ata,
          feePayerTokenAccount: ata,
          authority: kp.publicKey,
        }).instruction();
      const sig = await sendAndConfirmTransaction(
        conn, new Transaction().add(ix), [kp], { commitment: "confirmed" });
      lastClaimAt.set(key, Date.now());
      emit({
        event: "claim_ok", wallet: key, sig, attempts,
        mineMs: Date.now() - t0, difficulty: difficulty.toString(),
      });
      return "ok";
    } catch (err: any) {
      // Codes are from the IDL error list, not guessed:
      //   0x1771 InvalidProofOfWork — last_hash rotated under us. Expected
      //          under contention, and its rate measures how crowded the
      //          network is.
      //   0x1773 RateLimitExceeded  — the on-chain cooldown. Benign; it mostly
      //          appears after a restart, when the in-memory lastClaimAt map
      //          has lost the history the chain still remembers.
      //   0x1770 ContractPaused / 0x1772 SupplyCapReached — terminal. Neither
      //          is retryable, and SupplyCapReached in particular means mining
      //          is over; logging it as contention would have the pool hammer
      //          a dead chain forever.
      const msg = String(err?.message ?? err);
      const kind: Outcome =
        /InvalidProofOfWork|0x1771/.test(msg) ? "stale"
        : /RateLimitExceeded|0x1773/.test(msg) ? "ratelimit"
        : /SupplyCapReached|ContractPaused|0x1772|0x1770/.test(msg) ? "terminal"
        : "error";
      emit({ event: "claim_fail", wallet: key, kind, error: msg.slice(0, 200) });
      return kind;
    }
  }

  for (const phase of phases) {
    if (stopping) break;
    const active = miners.slice(0, Math.min(phase.wallets, miners.length));
    const until = Date.now() + phase.minutes * 60_000;
    console.log(`\n── phase ${phase.label ?? ""}: ${active.length} wallets for ${phase.minutes}m ──`);
    emit({ event: "phase_start", label: phase.label, wallets: active.length, minutes: phase.minutes });

    const tally: Record<Outcome, number> = {
      ok: 0, skip: 0, stale: 0, ratelimit: 0, error: 0, terminal: 0,
    };
    while (Date.now() < until && !stopping) {
      const results = await Promise.all(
        active.map((kp) => attemptClaim(kp).catch((): Outcome => "error")),
      );
      for (const r of results) tally[r]++;
      // A terminal error is not something more mining can fix — stop rather
      // than spin against a paused or exhausted chain.
      if (results.includes("terminal")) {
        console.log("\n  terminal program error — stopping. See the log.");
        stopping = true;
      }
      process.stdout.write(
        `\r  ok=${tally.ok} stale=${tally.stale} ratelimit=${tally.ratelimit} ` +
        `err=${tally.error} diff=${lastSeenDifficulty}   `,
      );
      await new Promise((r) => setTimeout(r, 2_000));
    }
    emit({ event: "phase_end", label: phase.label, ...tally });
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
