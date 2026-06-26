import { Connection } from "@solana/web3.js";

// confirmTransaction throws "block height exceeded" when the client gives up
// polling, NOT when the tx fails — it may have already landed. Re-query
// signature status directly before treating expiration as failure.
//
// Single source of truth — previously copy-pasted into burnerWallet, useMiner,
// and stakingActions; sweepTerm reuses it too.
export async function confirmOrCheckLanded(
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
