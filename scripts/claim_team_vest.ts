/**
 * claim_team_vest.ts — claim whatever team-vest tranches have vested.
 *
 * Must be run with the team wallet's keypair as ANCHOR_WALLET. The signer
 * must match the team_wallet recorded in the on-chain TeamVestState — the
 * program enforces this via has_one and will reject any other signer.
 *
 * Tranches vest as follows (after `initialize_vesting` is called):
 *   • 50M TERM  — claimable at launch (cliff)
 *   • 25M TERM  — linearly over 1 year, starting at year 5
 *   • 15M TERM  — linearly over 1 year, starting at year 7
 *   • 10M TERM  — linearly over 1 year, starting at year 10
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/team-wallet.json \
 *   yarn team-claim
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Terminuscoin } from "../target/types/terminuscoin";
import { getOrCreateAssociatedTokenAccount, getAccount } from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Terminuscoin as Program<Terminuscoin>;
const wallet = provider.wallet as anchor.Wallet;

const [mintPDA] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("mint")],
  program.programId
);
const [teamVestPDA] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("team_vest")],
  program.programId
);

async function main() {
  console.log("=== TERMINUS COIN — TEAM VEST CLAIM ===");
  console.log("Signer       :", wallet.publicKey.toBase58());
  console.log("Vest PDA     :", teamVestPDA.toBase58());

  // Verify our wallet is the recorded team wallet
  const v = await program.account.teamVestState.fetch(teamVestPDA).catch(() => null);
  if (!v) {
    console.error("Team vesting hasn't been initialised yet on this program.");
    process.exit(1);
  }
  const teamWallet = v.teamWallet as anchor.web3.PublicKey;
  if (teamWallet.toBase58() !== wallet.publicKey.toBase58()) {
    console.error(`Signer mismatch — TeamVestState recorded ${teamWallet.toBase58()}, but ANCHOR_WALLET is ${wallet.publicKey.toBase58()}.`);
    console.error("Run with the correct keypair: ANCHOR_WALLET=<path-to-team-keypair.json>");
    process.exit(1);
  }

  // Show the current vesting status (off-chain projection — view() function in the program)
  const status = await program.methods.getTeamVestStatus().accounts({}).view();
  console.log("");
  console.log("Vesting status:");
  console.log("  Total alloc      :", (status.totalAllocation.toNumber() / 1e6).toLocaleString(), "TERM");
  console.log("  Already claimed  :", (status.totalClaimed.toNumber() / 1e6).toLocaleString(), "TERM");
  console.log("  Currently claimable:", (status.totalClaimable.toNumber() / 1e6).toLocaleString(), "TERM");
  console.log("  Per tranche      :");
  for (let i = 0; i < 4; i++) {
    const amt = (status.trancheAmounts[i].toNumber() / 1e6).toLocaleString();
    const vested = (status.trancheVested[i].toNumber() / 1e6).toLocaleString();
    const claimed = (status.trancheClaimed[i].toNumber() / 1e6).toLocaleString();
    const unlocked = status.trancheUnlocked[i] ? "unlocked" : "locked";
    console.log(`    ${i}: alloc=${amt} TERM | vested=${vested} | claimed=${claimed} | ${unlocked}`);
  }

  if (status.totalClaimable.toNumber() === 0) {
    console.log("\nNothing claimable right now.");
    return;
  }

  // Get/create the team wallet's associated token account
  console.log("");
  console.log("Getting team token account…");
  const ata = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    wallet.payer,        // payer for ATA creation
    mintPDA,
    wallet.publicKey,    // owner
  );
  console.log("  ATA          :", ata.address.toBase58());

  const balBefore = await getAccount(provider.connection, ata.address);
  console.log("  Balance before:", (Number(balBefore.amount) / 1e6).toLocaleString(), "TERM");

  // Claim
  console.log("");
  console.log("Submitting claim_team_vest…");
  const sig = await program.methods.claimTeamVest()
    .accounts({
      teamTokenAccount: ata.address,
    })
    .rpc();
  console.log("  tx:", sig);

  const balAfter = await getAccount(provider.connection, ata.address);
  const received = (Number(balAfter.amount) - Number(balBefore.amount)) / 1e6;
  console.log("");
  console.log(`Done. Received ${received.toLocaleString()} TERM.`);
  console.log("New balance     :", (Number(balAfter.amount) / 1e6).toLocaleString(), "TERM");
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  if (err.logs) console.error("Logs:", err.logs.join("\n"));
  process.exit(1);
});
