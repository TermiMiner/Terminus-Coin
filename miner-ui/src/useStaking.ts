import { useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, Idl } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "../idl/terminuscoin.json";
import { MINT_PDA, STAKE_POOL_PDA, PROGRAM_ID } from "./useChainState";

export const [STAKE_VAULT_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("stake_vault")],
  PROGRAM_ID
);

export function deriveUserStakePDA(authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_stake"), authority.toBuffer()],
    PROGRAM_ID
  )[0];
}

const YIELD_PRECISION = 1_000_000_000_000n; // 1e12 from the program

export interface StakingState {
  walletBalance: bigint;        // user's TERM in their ATA, raw units
  staked: bigint;               // user's stake_account.amount
  pendingYield: bigint;         // computed: storedPending + accrued from rpts
  poolTotalStaked: bigint;
  poolTreasury: bigint;
  poolRpts: bigint;             // reward_per_token_stored (u128 → bigint)
  hasStakeAccount: boolean;     // whether user_stake_account exists
  loading: boolean;
}

const initial: StakingState = {
  walletBalance: 0n,
  staked: 0n,
  pendingYield: 0n,
  poolTotalStaked: 0n,
  poolTreasury: 0n,
  poolRpts: 0n,
  hasStakeAccount: false,
  loading: true,
};

export function useStaking(connection: Connection | null, walletPubkey: PublicKey | null): StakingState {
  const [state, setState] = useState<StakingState>(initial);

  useEffect(() => {
    if (!connection || !walletPubkey) { setState(initial); return; }

    const dummyWallet = {
      publicKey: PublicKey.default,
      signTransaction: async (t: unknown) => t,
      signAllTransactions: async (t: unknown[]) => t,
    };
    const provider = new AnchorProvider(connection, dummyWallet as anchor.Wallet, { commitment: "confirmed" });
    const program = new Program(idl as Idl, provider);

    const userAta = getAssociatedTokenAddressSync(MINT_PDA, walletPubkey);
    const userStakePDA = deriveUserStakePDA(walletPubkey);

    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        // Pool state
        const pool = await (program.account as any).stakePool.fetch(STAKE_POOL_PDA);
        const poolTotalStaked = BigInt(pool.totalStaked.toString());
        const poolTreasury = BigInt(pool.treasuryBalance.toString());
        const poolRpts = BigInt(pool.rewardPerTokenStored.toString());

        // User wallet (ATA may not exist yet)
        let walletBalance = 0n;
        try {
          const acc = await connection!.getTokenAccountBalance(userAta);
          walletBalance = BigInt(acc.value.amount);
        } catch { /* ATA missing — balance is 0 */ }

        // User stake account
        let staked = 0n;
        let storedPending = 0n;
        let userRewardDebt = 0n;
        let hasStakeAccount = false;
        try {
          const us = await (program.account as any).userStakeAccount.fetch(userStakePDA);
          staked = BigInt(us.amount.toString());
          storedPending = BigInt(us.pendingYield.toString());
          userRewardDebt = BigInt(us.rewardDebt.toString());
          hasStakeAccount = true;
        } catch { /* stake account missing — first-time staker */ }

        // Compute live pending yield using the same formula as the program:
        //   accrued = (poolRpts - userRewardDebt) * staked / YIELD_PRECISION
        //   total   = storedPending + accrued
        let accrued = 0n;
        if (staked > 0n && poolRpts >= userRewardDebt) {
          accrued = (poolRpts - userRewardDebt) * staked / YIELD_PRECISION;
        }
        const pendingYield = storedPending + accrued;

        if (!cancelled) {
          setState({
            walletBalance,
            staked,
            pendingYield,
            poolTotalStaked,
            poolTreasury,
            poolRpts,
            hasStakeAccount,
            loading: false,
          });
        }
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
      }
    }

    poll();
    const id = setInterval(poll, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [connection, walletPubkey?.toBase58()]);

  return state;
}
