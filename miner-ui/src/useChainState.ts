import { useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import idl from "../idl/terminuscoin.json";

const PROGRAM_ID = new PublicKey("FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y");

export const [GLOBAL_STATE_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("global_state_final_2026")],
  PROGRAM_ID
);

export const [MINT_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint")],
  PROGRAM_ID
);

export const [STAKE_POOL_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("stake_pool")],
  PROGRAM_ID
);

export function deriveBondPDA(authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bond"), authority.toBuffer()],
    PROGRAM_ID
  )[0];
}

export interface ChainState {
  difficulty: bigint;          // u64 from chain — values can exceed 2^53
  totalClaims: number;
  totalMinted: bigint;
  lastHash: number[];
  paused: boolean;
  treasuryBalance: bigint;
}

const SUPPLY_CAP = 1_000_000_000_000_000n; // 1 billion × 1e6

export interface ChainStateResult {
  state: ChainState | null;
  loading: boolean;       // true until first poll attempt completes
  initialized: boolean;   // true if program account was found at least once
}

export function useChainState(connection: Connection | null): ChainStateResult {
  const [state, setState] = useState<ChainState | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!connection) return;

    const dummyWallet = {
      publicKey: PublicKey.default,
      signTransaction: async (tx: unknown) => tx,
      signAllTransactions: async (txs: unknown[]) => txs,
    };

    const provider = new AnchorProvider(connection, dummyWallet as anchor.Wallet, {
      commitment: "confirmed",
    });
    const program = new Program(idl as Idl, provider);

    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const gs = await (program.account as any).globalState.fetch(GLOBAL_STATE_PDA);
        let treasury = 0n;
        try {
          const sp = await (program.account as any).stakePool.fetch(STAKE_POOL_PDA);
          treasury = BigInt(sp.treasuryBalance.toString());
        } catch {
          // stake pool may not be initialised
        }
        if (!cancelled) {
          setState({
            difficulty: BigInt(gs.difficulty.toString()),
            totalClaims: Number(gs.totalClaims),
            totalMinted: BigInt(gs.totalMinted.toString()),
            lastHash: gs.lastHash as number[],
            paused: gs.paused as boolean,
            treasuryBalance: treasury,
          });
          setInitialized(true);
        }
      } catch {
        // program not yet initialised — leave state null
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    poll();
    const id = setInterval(poll, 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection]);

  return { state, loading, initialized };
}

export { SUPPLY_CAP, PROGRAM_ID };
