import { Connection, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, Idl } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "../idl/terminuscoin.json";
import { MINT_PDA } from "./useChainState";
import type { MinerWallet } from "./burnerWallet";
import type { BroadcastAdapter } from "./relayerAdapter";

export type StakingAction = "stake" | "unstake" | "claim_yield";

// confirmTransaction throws "block height exceeded" when the client gives up
// polling, NOT when the tx fails — it may have already landed. Re-query
// signature status directly before treating expiration as failure.
async function confirmOrCheckLanded(
  connection: Connection,
  sig: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  try {
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (!/block height exceeded|has expired/i.test(msg)) throw err;
    const { value } = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const status = value?.[0];
    if (status && !status.err && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return;
    }
    if (status?.err) {
      const e = new Error(`Transaction failed on chain: ${JSON.stringify(status.err)}`);
      (e as any).logs = (status as any).logs;
      throw e;
    }
    throw err;
  }
}

export interface StakingActionResult {
  signature: string;
}

/**
 * Build, sign, and broadcast a stake/unstake/claim_yield transaction.
 * Uses the supplied broadcaster (shared relayer or local) when present,
 * otherwise wallet pays its own fees.
 */
export async function executeStakingAction(
  connection: Connection,
  wallet: MinerWallet,
  broadcaster: BroadcastAdapter | undefined,
  action: StakingAction,
  amount: bigint,
): Promise<StakingActionResult> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error("Wallet not connected");
  }
  const provider = new AnchorProvider(connection, wallet as unknown as anchor.Wallet, { commitment: "confirmed" });
  const program = new Program(idl as Idl, provider);

  const userAta = getAssociatedTokenAddressSync(MINT_PDA, wallet.publicKey);
  const feePayerKey = broadcaster?.pubkey ?? wallet.publicKey;

  let actionIx;
  if (action === "stake") {
    actionIx = await (program.methods as any)
      .stake(new BN(amount.toString()))
      .accounts({
        userTokenAccount: userAta,
        authority: wallet.publicKey,
      })
      .instruction();
  } else if (action === "unstake") {
    actionIx = await (program.methods as any)
      .unstake(new BN(amount.toString()))
      .accounts({
        userTokenAccount: userAta,
        authority: wallet.publicKey,
      })
      .instruction();
  } else {
    actionIx = await (program.methods as any)
      .claimYield()
      .accounts({
        userTokenAccount: userAta,
        authority: wallet.publicKey,
      })
      .instruction();
  }

  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 70_000 });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: feePayerKey });
  tx.add(cuLimitIx, actionIx);

  const partial = await wallet.signTransaction(tx);
  let sig: string;
  if (broadcaster) {
    sig = await broadcaster.signAndBroadcast(partial as Transaction, connection);
  } else {
    sig = await connection.sendRawTransaction((partial as Transaction).serialize());
  }
  await confirmOrCheckLanded(connection, sig, blockhash, lastValidBlockHeight);
  return { signature: sig };
}
