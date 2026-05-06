/**
 * set_rate_limit.ts — set the per-wallet claim cooldown.
 *
 * The rate limit is the minimum number of seconds between consecutive
 * claims by the same wallet. 0 = no limit. Authority-only.
 *
 * Usage:
 *   yarn rate-limit 60        # one claim per minute per wallet
 *   yarn rate-limit 0         # disable
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

function parseSeconds(): number {
  const arg = process.argv[2];
  if (arg === undefined) {
    console.error("Usage: yarn rate-limit <seconds>");
    process.exit(1);
  }
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`Invalid seconds value: ${arg}`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const seconds = parseSeconds();

  console.log("=== TERMINUS COIN — SET RATE LIMIT ===");
  console.log("Authority    :", wallet.publicKey.toBase58());

  const before = await program.account.globalState.fetch(globalStatePDA);
  console.log("Current limit:", (before.rateLimitSeconds as anchor.BN).toString(), "s");
  console.log("New limit    :", seconds, "s");

  if (Number((before.rateLimitSeconds as anchor.BN).toString()) === seconds) {
    console.log("No change needed — already set.");
    return;
  }

  const sig = await program.methods
    .setRateLimit(new anchor.BN(seconds))
    .accounts({ authority: wallet.publicKey })
    .rpc();

  const after = await program.account.globalState.fetch(globalStatePDA);
  console.log("Updated to   :", (after.rateLimitSeconds as anchor.BN).toString(), "s");
  console.log("tx           :", sig);
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  if (err.logs) console.error("Logs:", err.logs.join("\n"));
  process.exit(1);
});
