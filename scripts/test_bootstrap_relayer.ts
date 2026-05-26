// Operational verification for the bootstrap-mode relayer.
//
// Exercises the four critical paths against a deployed Vercel Preview:
//   1. /api/relayer-info exposes bootstrapMode + minTipTerm
//   2. Repeat claim with tip=0 → 429 quota="tip-floor"
//   3. Repeat claim with tip=MIN_BOOTSTRAP_TIP_TERM → 200 (passes the gate)
//   4. Fresh wallet first claim with tip=0 → 200 (subsidy path)
//
// Usage:
//   BOOTSTRAP_URL=https://your-preview.vercel.app \
//     npx ts-node scripts/test_bootstrap_relayer.ts
//
// Optional:
//   RPC_URL          (default: https://api.devnet.solana.com)
//   ANCHOR_WALLET    (default: ~/.config/solana/devnet-wallet.json)
//   SKIP_FIRST_CLAIM (set to "1" to skip test 4 if /api/topup quota is used)

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

const URL_BASE = process.env.BOOTSTRAP_URL?.replace(/\/$/, "");
if (!URL_BASE) {
  console.error("Set BOOTSTRAP_URL env var (e.g., https://preview.vercel.app)");
  process.exit(1);
}

const RPC = (process.env.RPC_URL ?? "https://api.devnet.solana.com").trim();
const WALLET_PATH = process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/devnet-wallet.json`;
const SKIP_FIRST_CLAIM = process.env.SKIP_FIRST_CLAIM === "1";

const PROGRAM_ID = new PublicKey("FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y");
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const DIM  = "\x1b[2m";
const RST  = "\x1b[0m";

const conn = new Connection(RPC, "confirmed");
const wallet = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(WALLET_PATH.replace(/^~/, os.homedir()), "utf8")))
);

const CLAIM_DISC = createHash("sha256").update("global:claim").digest().subarray(0, 8);
const DEPOSIT_BOND_DISC = createHash("sha256").update("global:deposit_bond").digest().subarray(0, 8);

// ─── PDA derivations + PoW mining (mirror lib.rs) ──────────────────────────

const [GLOBAL_STATE_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("global_state_final_2026")], PROGRAM_ID,
);
const [MINT_PDA] = PublicKey.findProgramAddressSync([Buffer.from("mint")], PROGRAM_ID);
const [MINT_AUTHORITY_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_authority")], PROGRAM_ID,
);
const [STAKE_POOL_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("stake_pool")], PROGRAM_ID,
);

function userStatePda(authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_state"), authority.toBuffer()], PROGRAM_ID,
  )[0];
}
function bondPda(authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bond"), authority.toBuffer()], PROGRAM_ID,
  )[0];
}

const MAX_U64 = (1n << 64n) - 1n;
function mineNonce(lastHash: number[], user: PublicKey, difficulty: bigint): bigint {
  const target = difficulty <= 1n ? MAX_U64 : MAX_U64 / difficulty;
  const input = new Uint8Array(72);
  input.set(lastHash, 8);
  input.set(user.toBytes(), 40);
  const view = new DataView(input.buffer);
  for (let n = 0n; ; n++) {
    view.setBigUint64(0, n, true);
    const hash = keccak_256(input);
    const hashHigh =
      (BigInt(hash[0]) << 56n) | (BigInt(hash[1]) << 48n) |
      (BigInt(hash[2]) << 40n) | (BigInt(hash[3]) << 32n) |
      (BigInt(hash[4]) << 24n) | (BigInt(hash[5]) << 16n) |
      (BigInt(hash[6]) <<  8n) |  BigInt(hash[7]);
    if (hashHigh <= target) return n;
  }
}

// ─── Manual instruction builders ───────────────────────────────────────────

function claimIxData(nonce: bigint, tipTerm: bigint): Buffer {
  const data = Buffer.alloc(24);
  CLAIM_DISC.copy(data, 0);
  data.writeBigUInt64LE(nonce, 8);
  data.writeBigUInt64LE(tipTerm, 16);
  return data;
}

function depositBondIxData(): Buffer {
  return Buffer.from(DEPOSIT_BOND_DISC);
}

function buildClaimIx(
  authority: PublicKey,
  feePayer: PublicKey,
  userTokenAccount: PublicKey,
  feePayerTokenAccount: PublicKey,
  nonce: bigint,
  tipTerm: bigint,
): { programId: PublicKey; keys: any[]; data: Buffer } {
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: feePayer,             isSigner: true,  isWritable: true },
      { pubkey: GLOBAL_STATE_PDA,     isSigner: false, isWritable: true },
      { pubkey: STAKE_POOL_PDA,       isSigner: false, isWritable: true },
      { pubkey: MINT_PDA,             isSigner: false, isWritable: true },
      { pubkey: userTokenAccount,     isSigner: false, isWritable: true },
      { pubkey: feePayerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: MINT_AUTHORITY_PDA,   isSigner: false, isWritable: false },
      { pubkey: authority,            isSigner: true,  isWritable: true },
      { pubkey: userStatePda(authority), isSigner: false, isWritable: true },
      { pubkey: bondPda(authority),   isSigner: false, isWritable: true },
      { pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), isSigner: false, isWritable: false },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
    ],
    data: claimIxData(nonce, tipTerm),
  };
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function relayerInfo(): Promise<any> {
  const res = await fetch(`${URL_BASE}/api/relayer-info`);
  if (!res.ok) throw new Error(`relayer-info HTTP ${res.status}`);
  return res.json();
}

async function submitRelay(tx: Transaction): Promise<{ status: number; body: any }> {
  const b64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
  const res = await fetch(`${URL_BASE}/api/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: b64 }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function callTopup(recipient: PublicKey): Promise<{ status: number; body: any }> {
  const res = await fetch(`${URL_BASE}/api/topup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: recipient.toBase58() }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ─── Test runner ───────────────────────────────────────────────────────────

let failures = 0;
async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`── ${name}\n`);
  try {
    await fn();
    process.stdout.write(`  ${PASS} pass\n`);
  } catch (err: any) {
    process.stdout.write(`  ${FAIL} FAIL: ${err.message}\n`);
    failures++;
  }
}

async function main() {
  console.log(`\nBootstrap-mode operational verification`);
  console.log(`${DIM}target: ${URL_BASE}${RST}`);
  console.log(`${DIM}rpc:    ${RPC}${RST}`);
  console.log(`${DIM}wallet: ${wallet.publicKey.toBase58()}${RST}\n`);

  // ─── Test 1: relayer-info ─────────────────────────────────────────────
  let info: any;
  await test("1. /api/relayer-info exposes bootstrap fields", async () => {
    info = await relayerInfo();
    if (info.bootstrapMode !== true) throw new Error(`bootstrapMode=${info.bootstrapMode}, expected true`);
    if (typeof info.minTipTerm !== "number" || info.minTipTerm <= 0) throw new Error(`minTipTerm invalid: ${info.minTipTerm}`);
    console.log(`     bootstrapMode=true, minTipTerm=${info.minTipTerm} (${(info.minTipTerm/1e6).toFixed(2)} TERM)`);
    console.log(`     relayer pubkey: ${info.pubkey}`);
  });

  if (failures > 0) {
    console.log(`\n${FAIL} aborting: /api/relayer-info check failed`);
    process.exit(1);
  }

  const relayerPubkey = new PublicKey(info.pubkey);
  const minTipTerm = BigInt(info.minTipTerm);

  // Pre-build artifacts shared across tests 2 + 3
  const userAta = getAssociatedTokenAddressSync(MINT_PDA, wallet.publicKey);
  const relayerAta = getAssociatedTokenAddressSync(MINT_PDA, relayerPubkey);

  const userStateExists = await conn.getAccountInfo(userStatePda(wallet.publicKey));
  if (!userStateExists) {
    console.log(`\n${FAIL} wallet ${wallet.publicKey.toBase58()} has no UserState on-chain.`);
    console.log(`     Tests 2+3 need a wallet that has claimed at least once. Use a different wallet via ANCHOR_WALLET=.`);
    process.exit(1);
  }

  async function buildSignedClaim(tipTerm: bigint): Promise<Transaction> {
    const state = await conn.getAccountInfo(GLOBAL_STATE_PDA);
    if (!state) throw new Error("GlobalState not found");
    // GlobalState layout: 8 disc + 32 authority + 32 freeze + 32 pending_auth + 32 pending_freeze
    //   + 1 paused + 8 difficulty + 8 launch_time + 8 last_claim_window + 8 total_claims
    //   + 8 claims_in_window + 8 total_minted + 8 rate_limit_seconds + 32 last_hash
    const difficulty = state.data.readBigUInt64LE(8 + 32*4 + 1);
    const lastHash = Array.from(state.data.subarray(8 + 32*4 + 1 + 8*7, 8 + 32*4 + 1 + 8*7 + 32));
    const nonce = mineNonce(lastHash, wallet.publicKey, difficulty);
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: relayerPubkey });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      relayerPubkey, relayerAta, relayerPubkey, MINT_PDA,
    ));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      relayerPubkey, userAta, wallet.publicKey, MINT_PDA,
    ));
    const ix = buildClaimIx(wallet.publicKey, relayerPubkey, userAta, relayerAta, nonce, tipTerm);
    tx.add({ ...ix, keys: ix.keys.map((k: any) => k) } as any);
    tx.partialSign(wallet);
    return tx;
  }

  // ─── Test 2: tip = 0, repeat claim → 429 tip-floor ────────────────────
  await test("2. Repeat claim with tip=0 → 429 quota=tip-floor", async () => {
    const tx = await buildSignedClaim(0n);
    const { status, body } = await submitRelay(tx);
    if (status !== 429) throw new Error(`expected 429, got ${status} body=${JSON.stringify(body)}`);
    if (body.quota !== "tip-floor") throw new Error(`expected quota=tip-floor, got ${body.quota}`);
    console.log(`     ${DIM}→ ${body.error}${RST}`);
  });

  // ─── Test 3: tip = minTipTerm, repeat claim → 200 ─────────────────────
  await test("3. Repeat claim with tip=minTipTerm → 200 (passes the gate)", async () => {
    const tx = await buildSignedClaim(minTipTerm);
    const { status, body } = await submitRelay(tx);
    // 200 means the relay endpoint accepted and broadcast.
    // The on-chain claim might fail later (stale nonce if mining races, or
    // rate-limit cooldown) — that's not what we're testing here.
    if (status !== 200) throw new Error(`expected 200, got ${status} body=${JSON.stringify(body)}`);
    if (typeof body.signature !== "string") throw new Error(`no signature in response`);
    console.log(`     ${DIM}→ broadcast sig: ${body.signature.slice(0, 24)}...${RST}`);
  });

  if (SKIP_FIRST_CLAIM) {
    console.log(`\n${DIM}(skipping test 4 — SKIP_FIRST_CLAIM=1)${RST}`);
  } else {
    // ─── Test 4: fresh wallet first claim with tip=0 ──────────────────────
    await test("4. Fresh wallet first claim with tip=0 → 200 (subsidy)", async () => {
      const fresh = Keypair.generate();
      console.log(`     ${DIM}fresh wallet: ${fresh.publicKey.toBase58()}${RST}`);

      // Step A: topup gets the fresh wallet some bootstrap SOL
      const topupRes = await callTopup(fresh.publicKey);
      if (topupRes.status !== 200) {
        throw new Error(`topup failed: ${topupRes.status} ${JSON.stringify(topupRes.body)}`);
      }
      console.log(`     ${DIM}→ topup sig: ${(topupRes.body.signature ?? topupRes.body.skipped ?? '?').toString().slice(0, 24)}${RST}`);
      // Wait briefly for topup confirmation propagation
      await new Promise(r => setTimeout(r, 4000));

      // Step B: build first-claim tx (depositBond + claim)
      const freshAta = getAssociatedTokenAddressSync(MINT_PDA, fresh.publicKey);
      const state = await conn.getAccountInfo(GLOBAL_STATE_PDA);
      if (!state) throw new Error("GlobalState not found");
      const difficulty = state.data.readBigUInt64LE(8 + 32*4 + 1);
      const lastHash = Array.from(state.data.subarray(8 + 32*4 + 1 + 8*7, 8 + 32*4 + 1 + 8*7 + 32));
      const nonce = mineNonce(lastHash, fresh.publicKey, difficulty);

      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: relayerPubkey });
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        relayerPubkey, relayerAta, relayerPubkey, MINT_PDA,
      ));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        relayerPubkey, freshAta, fresh.publicKey, MINT_PDA,
      ));
      // depositBond ix — authority = fresh (signs), rentPayer = relayer (also signs)
      tx.add({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: bondPda(fresh.publicKey), isSigner: false, isWritable: true },
          { pubkey: fresh.publicKey,          isSigner: true,  isWritable: false },
          { pubkey: relayerPubkey,            isSigner: true,  isWritable: true },
          { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
        ],
        data: depositBondIxData(),
      } as any);
      const claimIx = buildClaimIx(fresh.publicKey, relayerPubkey, freshAta, relayerAta, nonce, 0n);
      tx.add({ ...claimIx, keys: claimIx.keys.map((k: any) => k) } as any);
      tx.partialSign(fresh);

      const { status, body } = await submitRelay(tx);
      if (status !== 200) throw new Error(`first-claim subsidy rejected: ${status} ${JSON.stringify(body)}`);
      if (typeof body.signature !== "string") throw new Error(`no signature in response`);
      console.log(`     ${DIM}→ subsidized first claim sig: ${body.signature.slice(0, 24)}...${RST}`);
    });
  }

  console.log();
  if (failures === 0) {
    console.log(`${PASS} all checks passed`);
  } else {
    console.log(`${FAIL} ${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(`\n${FAIL} unhandled:`, e); process.exit(1); });
