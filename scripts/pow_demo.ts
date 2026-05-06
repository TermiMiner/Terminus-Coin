import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Terminuscoin } from "../target/types/terminuscoin";
import {
  createAssociatedTokenAccount,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";

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
const [stakePoolPDA] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("stake_pool")], program.programId
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
  console.log("=== TERMINUS COIN — END-TO-END DEMO ===");
  console.log("Wallet  :", wallet.publicKey.toBase58());
  console.log("Program :", program.programId.toBase58());
  console.log("");

  const mint = mintPDA;

  // Step 1: Initialize (idempotent — skip if GlobalState already exists)
  console.log("Step 1: Checking initialization…");
  let initState;
  try {
    initState = await program.account.globalState.fetch(globalStatePDA);
    console.log("  Already initialized — skipping.");
  } catch {
    console.log("  Initializing program (creates GlobalState + mint atomically)…");
    await program.methods.initialize()
      .accounts({ authority: wallet.publicKey })
      .rpc();
    initState = await program.account.globalState.fetch(globalStatePDA);
  }
  console.log("  Mint PDA          :", mint.toBase58());
  console.log("  Difficulty        :", initState.difficulty.toString(), "(1 in N hashes)");
  console.log("  Genesis hash      :", Buffer.from(initState.lastHash as number[]).toString("hex").slice(0, 16) + "…");

  // Step 2: Get or create user token account
  console.log("\nStep 2: Getting user token account…");
  const ata = await getOrCreateAssociatedTokenAccount(
    provider.connection, wallet.payer, mint, wallet.publicKey
  );
  const userTokenAccount = ata.address;
  console.log("  Token account     :", userTokenAccount.toBase58());

  // Step 3: Initialize stake pool (idempotent)
  console.log("\nStep 3: Checking stake pool…");
  try {
    await program.account.stakePool.fetch(stakePoolPDA);
    console.log("  Already initialized — skipping.");
  } catch {
    console.log("  Initializing stake pool…");
    await program.methods.initializeStakePool()
      .accounts({ authority: wallet.publicKey })
      .rpc();
  }
  console.log("  Stake pool PDA    :", stakePoolPDA.toBase58());

  // Step 4: Initialize TERM bond vault (idempotent, authority-only)
  console.log("\nStep 4: Checking TERM bond vault…");
  const [bondVaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("bond_term_vault")], program.programId
  );
  const vaultInfo = await provider.connection.getAccountInfo(bondVaultPDA);
  if (vaultInfo) {
    console.log("  Already initialized — skipping.");
  } else {
    console.log("  Initializing TERM bond vault…");
    await program.methods.initializeBondVault()
      .accounts({ authority: wallet.publicKey })
      .rpc();
  }
  console.log("  Bond vault PDA    :", bondVaultPDA.toBase58());

  // Step 5: Deposit anti-Sybil bond (idempotent — required to claim)
  console.log("\nStep 5: Checking anti-Sybil bond…");
  const [bondPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("bond"), wallet.publicKey.toBuffer()], program.programId
  );
  const bondInfo = await provider.connection.getAccountInfo(bondPDA);
  if (bondInfo) {
    console.log("  Already deposited — skipping.");
  } else {
    console.log("  Depositing SOL bond (~0.001 SOL of rent)…");
    await program.methods.depositBond()
      .accounts({ authority: wallet.publicKey })
      .rpc();
  }
  console.log("  Bond PDA          :", bondPDA.toBase58());

  // Step 6: Mine and claim 3 rounds
  // Note: NET_REWARD is approximate — burn rate scales dynamically with difficulty.
  // For display only; the actual amount is whatever the program credits.

  for (let round = 1; round <= 3; round++) {
    const state = await program.account.globalState.fetch(globalStatePDA);
    const diff = state.difficulty;
    const avgHashes = diff.toString();

    console.log(`\n--- Round ${round} | difficulty=${diff.toString()} | ~${avgHashes} avg hashes ---`);
    process.stdout.write("  Mining…");
    const t0 = Date.now();
    const { nonce, attempts } = mineNonce(
      state.lastHash as number[], wallet.publicKey, diff
    );
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(` found nonce in ${attempts.toLocaleString()} attempts (${elapsed}s)`);

    await program.methods.claim(nonce)
      .accounts({
        feePayer: wallet.publicKey,
        userTokenAccount,
        authority: wallet.publicKey,
      })
      .rpc();

    const after = await program.account.globalState.fetch(globalStatePDA);
    const bal = await getAccount(provider.connection, userTokenAccount);
    const pool = await program.account.stakePool.fetch(stakePoolPDA);

    console.log("  Total claims      :", after.totalClaims.toNumber());
    console.log("  Total minted      :", (after.totalMinted.toNumber() / 1e6).toFixed(6), "TERM");
    console.log("  Token balance     :", (Number(bal.amount) / 1e6).toFixed(6), "TERM");
    console.log("  Treasury balance  :", (pool.treasuryBalance.toNumber() / 1e6).toFixed(6), "TERM");
    console.log("  New last_hash     :", Buffer.from(after.lastHash as number[]).toString("hex").slice(0, 16) + "…");
  }

  // Summary
  const finalState = await program.account.globalState.fetch(globalStatePDA);
  const finalBal = await getAccount(provider.connection, userTokenAccount);
  console.log("\n=== DEMO COMPLETE ===");
  console.log("Final token balance :", (Number(finalBal.amount) / 1e6).toFixed(6), "TERM");
  console.log("Total claims        :", finalState.totalClaims.toNumber());
  console.log("Total minted        :", (finalState.totalMinted.toNumber() / 1e6).toFixed(6), "TERM");
  console.log("Supply cap          : 1,000,000,000 TERM (", (finalState.totalMinted.toNumber() / 1e15 * 100).toFixed(8), "% used )");
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  if (err.logs) console.error("Logs:", err.logs.join("\n"));
  process.exit(1);
});
