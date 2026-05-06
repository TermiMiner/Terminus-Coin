/**
 * initialize_vesting.ts — set up the team vesting state on-chain.
 *
 * Reserves 100M TERM (10% of supply cap) against total_minted across 4 tranches:
 *   • Tranche 0:  50M at launch
 *   • Tranche 1:  25M at year 5
 *   • Tranche 2:  15M at year 7
 *   • Tranche 3:  10M at year 10
 *
 * Run once after `yarn demo` (or after manual initialize + initializeStakePool):
 *   yarn vesting --team-wallet <PUBKEY>
 *
 * The team wallet is the only signer that can later call claim_team_vest to
 * mint unlocked tranches.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Terminuscoin } from "../target/types/terminuscoin";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Terminuscoin as Program<Terminuscoin>;
const wallet = provider.wallet as anchor.Wallet;

const [globalStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("global_state_final_2026")],
  program.programId
);
const [teamVestPDA] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("team_vest")],
  program.programId
);

function parseTeamWallet(): anchor.web3.PublicKey {
  const flag = process.argv.find((a) => a.startsWith("--team-wallet="))?.split("=")[1]
    ?? process.argv[process.argv.indexOf("--team-wallet") + 1];
  if (!flag) {
    console.error("Usage: yarn vesting --team-wallet <PUBKEY>");
    process.exit(1);
  }
  try {
    return new anchor.web3.PublicKey(flag);
  } catch {
    console.error(`Invalid pubkey: ${flag}`);
    process.exit(1);
  }
}

async function main() {
  const teamWallet = parseTeamWallet();

  console.log("=== TERMINUS COIN — INITIALIZE TEAM VESTING ===");
  console.log("Authority    :", wallet.publicKey.toBase58());
  console.log("Team wallet  :", teamWallet.toBase58());
  console.log("Vest PDA     :", teamVestPDA.toBase58());
  console.log("");

  // Idempotency check
  const existing = await provider.connection.getAccountInfo(teamVestPDA);
  if (existing) {
    console.log("Vesting state already initialized — fetching current state…");
    const v = await program.account.teamVestState.fetch(teamVestPDA);
    console.log("  Beneficiary  :", (v.teamWallet as anchor.web3.PublicKey).toBase58());
    for (let i = 0; i < 4; i++) {
      console.log(`  Tranche ${i} claimed: ${(v.claimed[i] as anchor.BN).toString()}`);
    }
    return;
  }

  // Verify GlobalState exists (program must be initialized first)
  const gsBefore = await program.account.globalState.fetch(globalStatePDA).catch(() => null);
  if (!gsBefore) {
    console.error("GlobalState does not exist. Run `yarn demo` (or initialize the program) first.");
    process.exit(1);
  }
  console.log("Total minted before:", (gsBefore.totalMinted as anchor.BN).toString());

  const sig = await program.methods
    .initializeVesting(teamWallet)
    .accounts({ authority: wallet.publicKey, teamVestState: teamVestPDA })
    .rpc();

  const gsAfter = await program.account.globalState.fetch(globalStatePDA);
  console.log("Total minted after :", (gsAfter.totalMinted as anchor.BN).toString());
  console.log("Reserved (delta)   :",
    (gsAfter.totalMinted as anchor.BN).sub(gsBefore.totalMinted as anchor.BN).toString());
  console.log("");
  console.log("Tranches:");
  console.log("  0:  50,000,000 TERM — unlocks at launch (claimable now)");
  console.log("  1:  25,000,000 TERM — unlocks at year 5");
  console.log("  2:  15,000,000 TERM — unlocks at year 7");
  console.log("  3:  10,000,000 TERM — unlocks at year 10");
  console.log("");
  console.log(`Done. tx: ${sig}`);
  console.log(`Team wallet ${teamWallet.toBase58()} can now call claim_team_vest.`);
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  if (err.logs) console.error("Logs:", err.logs.join("\n"));
  process.exit(1);
});
