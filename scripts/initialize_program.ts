import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Terminuscoin } from "../target/types/terminuscoin";

// initialize_program.ts — mint-NOTHING initializer for mainnet launch.
//
// Runs the three program-setup instructions, all idempotent:
//   1. initialize()          — GlobalState + mint (PDA)
//   2. initializeStakePool() — the treasury/stake pool
//   3. initializeBondVault() — the TERM bond vault
//
// Unlike pow_demo.ts (the devnet sanity flow) it does NOT create a deployer ATA,
// deposit a deployer bond, or MINE. So it mints zero TERM and leaves no insider
// pre-launch balance — which is exactly what the launch plan requires (no
// insider pre-pool window). Reads GlobalState back as a no-mint sanity check.
//
// Usage (via mainnet-launch.sh, or directly):
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<keypair.json> \
//     npx ts-node -P tsconfig.json scripts/initialize_program.ts

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Terminuscoin as Program<Terminuscoin>;
const wallet = provider.wallet as anchor.Wallet;

const pda = (seed: string) =>
  anchor.web3.PublicKey.findProgramAddressSync([Buffer.from(seed)], program.programId)[0];

const globalStatePDA = pda("global_state_final_2026");
const mintPDA = pda("mint");
const stakePoolPDA = pda("stake_pool");
const bondVaultPDA = pda("bond_term_vault");

async function ensure(
  label: string,
  exists: () => Promise<boolean>,
  create: () => Promise<string>,
): Promise<void> {
  process.stdout.write(`• ${label} … `);
  if (await exists()) {
    console.log("already initialized — skipping.");
    return;
  }
  const sig = await create();
  console.log(`done (${sig.slice(0, 16)}…).`);
}

async function main() {
  console.log("=== TERMINUS COIN — INITIALIZE (mints nothing) ===");
  console.log("Wallet  :", wallet.publicKey.toBase58());
  console.log("Program :", program.programId.toBase58());
  console.log("");

  await ensure(
    "Program + GlobalState + mint",
    async () => {
      try { await program.account.globalState.fetch(globalStatePDA); return true; }
      catch { return false; }
    },
    () => program.methods.initialize().accounts({ authority: wallet.publicKey }).rpc(),
  );

  await ensure(
    "Stake pool",
    async () => {
      try { await program.account.stakePool.fetch(stakePoolPDA); return true; }
      catch { return false; }
    },
    () => program.methods.initializeStakePool().accounts({ authority: wallet.publicKey }).rpc(),
  );

  await ensure(
    "TERM bond vault",
    async () => (await provider.connection.getAccountInfo(bondVaultPDA)) !== null,
    () => program.methods.initializeBondVault().accounts({ authority: wallet.publicKey }).rpc(),
  );

  // No-mint sanity read-back.
  const s = await program.account.globalState.fetch(globalStatePDA);
  console.log("");
  console.log("GlobalState     :", globalStatePDA.toBase58());
  console.log("Mint            :", mintPDA.toBase58());
  console.log("Stake pool      :", stakePoolPDA.toBase58());
  console.log("Bond vault      :", bondVaultPDA.toBase58());
  console.log("Authority       :", s.authority.toBase58());
  console.log("Difficulty      :", s.difficulty.toString());
  console.log(
    "Total minted    :",
    (s.totalMinted.toNumber() / 1e6).toFixed(6),
    "TERM (expect 0.000000 — team vesting reserves 100M in the next step)",
  );
  console.log("");
  console.log("✓ Initialized. Nothing minted; no deployer balance created.");
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  if (err.logs) console.error("Logs:", err.logs.join("\n"));
  process.exit(1);
});
