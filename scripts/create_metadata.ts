/**
 * create_metadata.ts — attach Metaplex Token Metadata to the TERM mint.
 *
 * The mint authority is a PDA owned by the program, so metadata must be
 * created via a program instruction (this script cannot do it directly).
 *
 * Run once after deploying/initializing:
 *   yarn metadata
 *
 * Update the URI once an image is ready (update_authority = your wallet):
 *   yarn metadata --uri https://arweave.net/YOUR_FINAL_METADATA_JSON
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Terminuscoin } from "../target/types/terminuscoin";

const MPL_TOKEN_METADATA_PROGRAM_ID = new anchor.web3.PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Terminuscoin as Program<Terminuscoin>;
const wallet = provider.wallet as anchor.Wallet;

const [mintPDA] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("mint")],
  program.programId
);

const [metadataPDA] = anchor.web3.PublicKey.findProgramAddressSync(
  [
    Buffer.from("metadata"),
    MPL_TOKEN_METADATA_PROGRAM_ID.toBytes(),
    mintPDA.toBytes(),
  ],
  MPL_TOKEN_METADATA_PROGRAM_ID
);

// Parse optional --uri flag from argv
const uriIdx = process.argv.indexOf("--uri");
const uriArg = process.argv.find((a) => a.startsWith("--uri="))?.split("=")[1]
  ?? (uriIdx >= 0 ? process.argv[uriIdx + 1] : undefined);

const NAME   = "Terminus Coin";
const SYMBOL = "TERM";
// Default points at this repo's metadata/term.json via jsdelivr.
// For mainnet, override with --uri https://arweave.net/<TX_ID>
const URI    = uriArg ?? "https://cdn.jsdelivr.net/gh/TermiMiner/terminus-coin@main/metadata/term.json";

async function main() {
  // Sanity-check the URI is actually fetchable before broadcasting on-chain.
  // The metadata account is created with is_mutable=true, so a wrong URI is
  // recoverable, but it's much cleaner to never write a broken URL in the
  // first place.
  process.stdout.write(`Verifying URI is reachable: ${URI} … `);
  try {
    const res = await fetch(URI);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.name || !body.symbol || !body.image) {
      throw new Error("missing required fields (name/symbol/image)");
    }
    console.log("OK");
  } catch (err: any) {
    console.log("FAILED");
    console.error(`  ${err.message ?? err}`);
    console.error("  Make sure metadata/term.json is committed and pushed to GitHub.");
    console.error("  jsdelivr can take ~1-2 minutes to pick up new commits.");
    console.error("  Or pass --uri <DIFFERENT_URL> to override.");
    process.exit(1);
  }

  const metaInfo = await provider.connection.getAccountInfo(metadataPDA);

  if (metaInfo) {
    console.log("Metadata account already exists at", metadataPDA.toBase58());
    console.log("To update URI, use the Metaplex update instruction with your wallet.");
    return;
  }

  console.log("=== TERMINUS COIN — CREATE METADATA ===");
  console.log("Mint        :", mintPDA.toBase58());
  console.log("Metadata PDA:", metadataPDA.toBase58());
  console.log("Name        :", NAME);
  console.log("Symbol      :", SYMBOL);
  console.log("URI         :", URI);
  console.log("");

  const sig = await program.methods
    .createMetadata(NAME, SYMBOL, URI)
    .accounts({
      authority: wallet.publicKey,
      metadata: metadataPDA,
      metadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
    })
    .rpc();

  console.log("Done! tx:", sig);
  console.log(
    "update_authority is your wallet — update the URI anytime via Metaplex once the image is ready."
  );
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  if (err.logs) console.error("Logs:", err.logs.join("\n"));
  process.exit(1);
});
