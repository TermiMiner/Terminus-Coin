// Rent-exempt minimums for the accounts this site opens, read from the cluster.
// They used to be fixed in the code at 6,960 lamports a byte. Solana is cutting
// rent in steps (SIMD-0437); when devnet went to 5,080 in November 2026, the
// fixed figures asked testers for more SOL than a transaction needs.
import type { Connection } from "@solana/web3.js";

/** Data length, in bytes, of each account the site pays rent for. */
export const ACCOUNT_SIZES = {
  /** A plain wallet. A transaction may not leave it above zero but below this
   *  account's minimum (InsufficientFundsForRent), so a wallet that pays for
   *  something must keep this much afterwards. */
  wallet: 0,
  /** A classic SPL token account: the TERM account a wallet mines into. */
  tokenAccount: 165,
  /** BondAccount, 8 + 49 (programs/terminuscoin/src/lib.rs). */
  bond: 57,
  /** UserState, 8 + 16. */
  userState: 24,
  /** UserStakeAccount, 8 + 80. */
  stakeAccount: 88,
} as const;

export type RentTable = Record<keyof typeof ACCOUNT_SIZES, number>;

/**
 * The same minimums at the old rate. Rent has only come down since, so these
 * overstate what a transaction needs: the site uses them until the cluster
 * answers, and when it cannot.
 */
export const FALLBACK_RENT: RentTable = {
  wallet: 890_880,
  tokenAccount: 2_039_280,
  bond: 1_287_600,
  userState: 1_057_920,
  stakeAccount: 1_503_360,
};

const tables = new Map<string, Promise<RentTable>>();

/**
 * Each account's rent-exempt minimum on the cluster behind `connection`, read
 * once per RPC endpoint. A failed read is not kept, so the next call asks again.
 */
export function fetchRentTable(connection: Connection): Promise<RentTable> {
  const key = connection.rpcEndpoint;
  let table = tables.get(key);
  if (!table) {
    const kinds = Object.keys(ACCOUNT_SIZES) as (keyof RentTable)[];
    const pending = Promise.all(kinds.map((k) => connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZES[k])))
      .then((mins) => {
        if (!mins.every((m) => Number.isSafeInteger(m) && m > 0)) {
          throw new Error(`Unexpected rent-exempt minimums from the cluster: ${mins.join(", ")}`);
        }
        return Object.fromEntries(kinds.map((k, i) => [k, mins[i]])) as RentTable;
      });
    tables.set(key, pending);
    pending.catch(() => { if (tables.get(key) === pending) tables.delete(key); });
    table = pending;
  }
  return table;
}

/** fetchRentTable, or FALLBACK_RENT when the cluster does not answer. */
export function rentOrFallback(connection: Connection): Promise<RentTable> {
  return fetchRentTable(connection).catch(() => FALLBACK_RENT);
}
