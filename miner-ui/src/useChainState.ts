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
  launchTime: bigint;          // i64 unix seconds — emission epoch anchor
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
  rpcError: string | null; // non-null when the last poll couldn't REACH the RPC
                           // (401 / blocked key / wrong origin / 429 / network) —
                           // distinct from a genuinely-missing program account
}

export function useChainState(connection: Connection | null): ChainStateResult {
  const [state, setState] = useState<ChainState | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [rpcError, setRpcError] = useState<string | null>(null);

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
            launchTime: BigInt(gs.launchTime.toString()),
            totalClaims: Number(gs.totalClaims),
            totalMinted: BigInt(gs.totalMinted.toString()),
            lastHash: gs.lastHash as number[],
            paused: gs.paused as boolean,
            treasuryBalance: treasury,
          });
          setInitialized(true);
          setRpcError(null);
        }
      } catch (err: any) {
        // Distinguish "program account genuinely missing" from "couldn't reach
        // the RPC" — both used to land here and surface identically as "NOT
        // INITIALIZED", which masked the 2026-06-15 domain-lock outage. Anchor
        // throws "Account does not exist / has no data" for a truly-missing
        // account; anything else fetching it (401 / blocked key / wrong origin /
        // 429 / network) is an RPC reachability problem.
        if (!cancelled) {
          const msg = String(err?.message ?? err);
          const missing = /account does not exist|has no data/i.test(msg);
          setRpcError(missing ? null : "Can't reach the RPC — check your connection or the RPC key's allowed-domains / cluster.");
        }
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

  return { state, loading, initialized, rpcError };
}

export { SUPPLY_CAP, PROGRAM_ID };
