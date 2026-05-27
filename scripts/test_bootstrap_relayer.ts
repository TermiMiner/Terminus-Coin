// Operational verification for the bootstrap-mode relayer.
//
// All four tests run sequentially on a single fresh wallet:
//   1. /api/relayer-info exposes bootstrapMode + minTipTerm
//   2. Fresh wallet → topup → first claim with tip=0 → 200 (subsidy path)
//   3. Same wallet → second claim with tip=0 → 429 quota="tip-floor"
//   4. Same wallet → third claim with tip=MIN_BOOTSTRAP_TIP_TERM → 200
//
// Each run burns one /api/topup (per-wallet quota = 1) because the fresh
// wallet is unique each time. If the per-IP topup rate limit is reached,
// re-run from a different IP or wait an hour.
//
// Usage:
//   BOOTSTRAP_URL=https://your-preview.vercel.app \
//     npx ts-node scripts/test_bootstrap_relayer.ts
//
// Optional:
//   RPC_URL  (default: https://api.devnet.solana.com)

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash } from "node:crypto";

// BOOTSTRAP_URL may include a ?_vercel_share=... query string for protected
// previews. We split it: base for path construction, share-token kept aside.
const rawUrl = process.env.BOOTSTRAP_URL;
if (!rawUrl) {
  console.error("Set BOOTSTRAP_URL env var (e.g., https://preview.vercel.app)");
  process.exit(1);
}
const parsedUrl = new URL(rawUrl);
const URL_BASE = `${parsedUrl.protocol}//${parsedUrl.host}`;
const SHARE_TOKEN = parsedUrl.searchParams.get("_vercel_share") ?? "";
// Vercel protection cookie acquired by exchanging the share token; set in main().
let vercelJwt = "";

function fetchOpts(extra: RequestInit = {}): RequestInit {
  const headers = new Headers(extra.headers);
  if (vercelJwt) headers.set("Cookie", `_vercel_jwt=${vercelJwt}`);
  return { ...extra, headers };
}

async function exchangeShareToken(): Promise<void> {
  if (!SHARE_TOKEN) return;
  // Hit any endpoint with the share token — Vercel will redirect and set
  // _vercel_jwt cookie. We capture the Set-Cookie header manually since
  // Node's fetch doesn't have a built-in cookie jar.
  const res = await fetch(`${URL_BASE}/api/relayer-info?_vercel_share=${SHARE_TOKEN}`, {
    redirect: "manual",
  });
  for (const [k, v] of res.headers.entries()) {
    if (k.toLowerCase() === "set-cookie") {
      const m = v.match(/_vercel_jwt=([^;]+)/);
      if (m) vercelJwt = m[1];
    }
  }
  if (!vercelJwt) {
    // Maybe the response was direct (no redirect) — try the body URL or just continue
    console.error(`${DIM}warn: couldn't extract _vercel_jwt cookie from share-token exchange${RST}`);
  }
}

const RPC = (process.env.RPC_URL ?? "https://api.devnet.solana.com").trim();

const PROGRAM_ID = new PublicKey("FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y");
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const DIM  = "\x1b[2m";
const RST  = "\x1b[0m";

const conn = new Connection(RPC, "confirmed");

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
  const res = await fetch(`${URL_BASE}/api/relayer-info`, fetchOpts());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`relayer-info HTTP ${res.status} body=${body.slice(0, 120)}`);
  }
  return res.json();
}

async function submitRelay(tx: Transaction): Promise<{ status: number; body: any }> {
  const b64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
  const res = await fetch(`${URL_BASE}/api/relay`, fetchOpts({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: b64 }),
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function callTopup(recipient: PublicKey): Promise<{ status: number; body: any }> {
  const res = await fetch(`${URL_BASE}/api/topup`, fetchOpts({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: recipient.toBase58() }),
  }));
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

async function waitForConfirmation(sig: string, maxWaitMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
      if (status.value.err) throw new Error(`tx failed: ${JSON.stringify(status.value.err)}`);
      return;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`tx ${sig.slice(0, 16)}... not confirmed within ${maxWaitMs}ms`);
}

async function readGlobalState(): Promise<{ difficulty: bigint; lastHash: number[]; rateLimitSeconds: bigint }> {
  const state = await conn.getAccountInfo(GLOBAL_STATE_PDA);
  if (!state) throw new Error("GlobalState not found");
  // 8 disc + 32 authority + 32 freeze + 32 pending_auth + 32 pending_freeze
  //   + 1 paused + 8 difficulty + 8 launch_time + 8 last_claim_window
  //   + 8 total_claims + 8 claims_in_window + 8 total_minted
  //   + 8 rate_limit_seconds + 32 last_hash
  const difficultyOffset = 8 + 32 * 4 + 1;
  const rateLimitOffset = difficultyOffset + 8 * 6;
  const lastHashOffset = difficultyOffset + 8 * 7;
  return {
    difficulty: state.data.readBigUInt64LE(difficultyOffset),
    rateLimitSeconds: state.data.readBigInt64LE(rateLimitOffset),
    lastHash: Array.from(state.data.subarray(lastHashOffset, lastHashOffset + 32)),
  };
}

async function main() {
  console.log(`\nBootstrap-mode operational verification`);
  console.log(`${DIM}target: ${URL_BASE}${RST}`);
  console.log(`${DIM}rpc:    ${RPC}${RST}`);

  // Exchange Vercel share token for protection-bypass JWT (if any)
  if (SHARE_TOKEN) {
    await exchangeShareToken();
    if (vercelJwt) console.log(`${DIM}auth:   share token exchanged for _vercel_jwt cookie${RST}`);
  }
  console.log();

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

  // Single fresh wallet drives all remaining tests
  const fresh = Keypair.generate();
  const freshAta = getAssociatedTokenAddressSync(MINT_PDA, fresh.publicKey);
  const relayerAta = getAssociatedTokenAddressSync(MINT_PDA, relayerPubkey);
  console.log(`\n${DIM}fresh wallet for tests 2-4: ${fresh.publicKey.toBase58()}${RST}`);

  // ─── Test 2: fresh wallet first claim with tip=0 (subsidy path) ───────
  await test("2. Fresh wallet first claim with tip=0 → 200 (subsidy)", async () => {
    // Step A: topup
    const topupRes = await callTopup(fresh.publicKey);
    if (topupRes.status !== 200) {
      throw new Error(`topup failed: ${topupRes.status} ${JSON.stringify(topupRes.body)}`);
    }
    const topupSig = topupRes.body.signature ?? "(skipped)";
    console.log(`     ${DIM}→ topup sig: ${topupSig.slice(0, 24)}${RST}`);
    if (topupRes.body.signature) await waitForConfirmation(topupRes.body.signature);

    // Step B: build first-claim tx with depositBond + claim(tip=0)
    const { difficulty, lastHash } = await readGlobalState();
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

    // Wait for confirmation so UserState exists for the next tests
    await waitForConfirmation(body.signature);
  });

  async function buildRepeatClaim(tipTerm: bigint): Promise<Transaction> {
    const { difficulty, lastHash } = await readGlobalState();
    const nonce = mineNonce(lastHash, fresh.publicKey, difficulty);
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: relayerPubkey });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      relayerPubkey, relayerAta, relayerPubkey, MINT_PDA,
    ));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      relayerPubkey, freshAta, fresh.publicKey, MINT_PDA,
    ));
    const ix = buildClaimIx(fresh.publicKey, relayerPubkey, freshAta, relayerAta, nonce, tipTerm);
    tx.add({ ...ix, keys: ix.keys.map((k: any) => k) } as any);
    tx.partialSign(fresh);
    return tx;
  }

  // ─── Test 3: repeat claim with tip=0 (now UserState exists) → 429 ────
  // The relay endpoint rejects BEFORE broadcasting, so the on-chain
  // rate_limit_seconds cooldown doesn't apply here.
  await test("3. Repeat claim with tip=0 → 429 quota=tip-floor", async () => {
    const tx = await buildRepeatClaim(0n);
    const { status, body } = await submitRelay(tx);
    if (status !== 429) throw new Error(`expected 429, got ${status} body=${JSON.stringify(body)}`);
    if (body.quota !== "tip-floor") throw new Error(`expected quota=tip-floor, got ${body.quota}`);
    console.log(`     ${DIM}→ ${body.error}${RST}`);
  });

  // ─── Test 4: repeat claim with tip=minTipTerm → 200 ──────────────────
  // The relay endpoint will broadcast this one, which means the on-chain
  // rate_limit_seconds cooldown applies. Wait it out.
  const { rateLimitSeconds } = await readGlobalState();
  const waitSeconds = Number(rateLimitSeconds) + 5;
  console.log(`${DIM}waiting ${waitSeconds}s for on-chain rate limit to clear...${RST}`);
  await new Promise(r => setTimeout(r, waitSeconds * 1000));

  await test("4. Repeat claim with tip=minTipTerm → 200 (passes the gate)", async () => {
    const tx = await buildRepeatClaim(minTipTerm);
    const { status, body } = await submitRelay(tx);
    if (status !== 200) throw new Error(`expected 200, got ${status} body=${JSON.stringify(body)}`);
    if (typeof body.signature !== "string") throw new Error(`no signature in response`);
    console.log(`     ${DIM}→ broadcast sig: ${body.signature.slice(0, 24)}...${RST}`);
  });

  console.log();
  if (failures === 0) {
    console.log(`${PASS} all checks passed`);
  } else {
    console.log(`${FAIL} ${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(`\n${FAIL} unhandled:`, e); process.exit(1); });
