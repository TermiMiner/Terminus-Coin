/**
 * measure_cu.ts — mine one valid nonce against the live on-chain state,
 * simulate the claim to read compute units, then send it and measure the
 * actual SOL fee paid.
 *
 * Assumes the program is already initialized (run the test suite or
 * pow_demo.ts first to set up GlobalState and the stake pool).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
 *   ANCHOR_WALLET=~/.config/solana/devnet-wallet.json \
 *   npx ts-node -P tsconfig.json scripts/measure_cu.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Terminuscoin } from "../target/types/terminuscoin";
import { createAssociatedTokenAccount, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { ComputeBudgetProgram } from "@solana/web3.js";

const CU_LIMIT = 70_000;  // matches miner-ui

// ─── Setup ────────────────────────────────────────────────────────────────────

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Terminuscoin as Program<Terminuscoin>;
const wallet = provider.wallet as anchor.Wallet;

const [globalStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("global_state_final_2026")], program.programId
);
const [mintPDA] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("mint")], program.programId
);

// ─── PoW helpers ──────────────────────────────────────────────────────────────

const MAX_U64 = (1n << 64n) - 1n;

function meetsdifficulty(hash: Uint8Array, target: bigint): boolean {
  const hashHigh =
    (BigInt(hash[0]) << 56n) | (BigInt(hash[1]) << 48n) |
    (BigInt(hash[2]) << 40n) | (BigInt(hash[3]) << 32n) |
    (BigInt(hash[4]) << 24n) | (BigInt(hash[5]) << 16n) |
    (BigInt(hash[6]) <<  8n) |  BigInt(hash[7]);
  return hashHigh <= target;
}

function mineNonce(
  lastHash: number[],
  user: anchor.web3.PublicKey,
  difficulty: anchor.BN | bigint
): { nonce: anchor.BN; attempts: number } {
  const diff = typeof difficulty === "bigint" ? difficulty : BigInt(difficulty.toString());
  const target = diff <= 1n ? MAX_U64 : MAX_U64 / diff;
  const input = new Uint8Array(72);
  input.set(lastHash, 8);
  input.set(user.toBytes(), 40);
  const view = new DataView(input.buffer);
  let attempts = 0;
  for (let n = 0n; ; n++) {
    view.setBigUint64(0, n, true);
    attempts++;
    if (meetsdifficulty(keccak_256(input), target))
      return { nonce: new anchor.BN(n.toString()), attempts };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Verify the program is initialized
  const stateInfo = await provider.connection.getAccountInfo(globalStatePDA);
  if (!stateInfo) {
    console.error("GlobalState not found. Run pow_demo.ts first to initialize.");
    process.exit(1);
  }

  // Ensure bond is deposited (required to claim)
  const [bondPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("bond"), wallet.publicKey.toBuffer()], program.programId
  );
  const bondInfo = await provider.connection.getAccountInfo(bondPDA);
  if (!bondInfo) {
    console.log("Depositing anti-Sybil bond first…");
    await program.methods.depositBond()
      .accounts({ authority: wallet.publicKey })
      .rpc();
  }

  const state = await program.account.globalState.fetch(globalStatePDA);
  const { difficulty } = state;

  // Get or create the user's token account for the program mint
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection, wallet.payer, mintPDA, wallet.publicKey
  );
  const userTokenAccount = tokenAccount.address;

  console.log("=== TERMINUS COIN — COMPUTE UNIT MEASUREMENT ===");
  console.log("Wallet         :", wallet.publicKey.toBase58());
  console.log("Difficulty     :", difficulty.toString(), `(1 in ${difficulty.toString()} hashes avg)`);
  console.log("");

  // Mine a valid nonce
  process.stdout.write(`Mining nonce…`);
  const t0 = Date.now();
  const { nonce, attempts } = mineNonce(state.lastHash as number[], wallet.publicKey, difficulty);
  console.log(` found in ${attempts.toLocaleString()} attempts (${((Date.now() - t0) / 1000).toFixed(2)}s)`);

  // Build the transaction with explicit CU budget (mirrors miner-ui)
  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT });
  const tx = await program.methods.claim(nonce)
    .accounts({
      feePayer: wallet.publicKey,
      userTokenAccount,
      authority: wallet.publicKey,
    })
    .preInstructions([cuLimitIx])
    .transaction();

  const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet.payer);

  // Simulate to read compute units consumed
  const sim = await provider.connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.error("Simulation failed:", JSON.stringify(sim.value.err));
    console.error("Logs:", sim.value.logs?.join("\n"));
    process.exit(1);
  }
  const cu = sim.value.unitsConsumed ?? 0;

  // Send and measure actual lamport cost
  const balBefore = await provider.connection.getBalance(wallet.publicKey);
  const sig = await provider.connection.sendRawTransaction(tx.serialize());
  await provider.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
  const balAfter = await provider.connection.getBalance(wallet.publicKey);
  const feeLamports = balBefore - balAfter;

  const solPrice = 150; // rough reference price
  const feeUsd = (feeLamports / 1e9) * solPrice;

  console.log("\n=== COMPUTE & FEE REPORT ===");
  console.log(`Compute units consumed : ${cu.toLocaleString()} CU`);
  console.log(`Requested CU limit     : ${CU_LIMIT.toLocaleString()} CU`);
  console.log(`Default would have been: 200,000 CU`);
  console.log(`Headroom vs limit      : ${(CU_LIMIT - cu).toLocaleString()} CU`);
  console.log(`Fee paid               : ${feeLamports.toLocaleString()} lamports`);
  console.log(`                         ${(feeLamports / 1e9).toFixed(9)} SOL`);
  console.log(`                         ~$${feeUsd.toFixed(6)} USD  (at $${solPrice}/SOL)`);
  console.log(`Difficulty             : ${difficulty.toString()}`);
  console.log(`Nonce attempts         : ${attempts.toLocaleString()}`);
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  if (err.logs) console.error("Logs:", err.logs.join("\n"));
  process.exit(1);
});
