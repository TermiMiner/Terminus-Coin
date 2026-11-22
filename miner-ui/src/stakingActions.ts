import { Connection, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, Idl } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "../idl/terminuscoin.json";
import { MINT_PDA } from "./useChainState";
import type { MinerWallet } from "./burnerWallet";
import type { BroadcastAdapter } from "./relayerAdapter";
import { confirmOrCheckLanded } from "./confirmTx";
import { FEE_PAYER_RENT_FLOOR_LAMPORTS } from "./sweepTerm";

// A wallet's first stake creates its stake account (UserStakeAccount, 8 + 80
// bytes) with `payer = authority`, so the wallet pays the rent itself even when
// a relayer pays the fee. A burner on the gasless path holds no SOL, and its
// first stake used to fail at the relayer's simulation with no reason given.
export const STAKE_ACCOUNT_RENT_LAMPORTS = 1_503_360;
const STAKE_FEE_LAMPORTS = 5_000; // one signature, no priority fee

/**
 * SOL a wallet must hold for its first stake: the stake account's rent, the fee
 * when the wallet pays its own, and the rent-exempt minimum the wallet has to
 * keep afterwards (a transaction may not leave it above zero but below that).
 */
export function firstStakeLamports(walletPaysFee: boolean): number {
  return STAKE_ACCOUNT_RENT_LAMPORTS + (walletPaysFee ? STAKE_FEE_LAMPORTS : 0) + FEE_PAYER_RENT_FLOOR_LAMPORTS;
}

export type StakingAction = "stake" | "unstake" | "claim_yield";

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
