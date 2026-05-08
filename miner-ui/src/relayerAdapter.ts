import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { BrowserKeypairWallet } from "./burnerWallet";

/**
 * Abstraction over "complete and broadcast" — used by useMiner so it doesn't
 * care whether the fee payer signs locally (browser-stored relayer keypair)
 * or remotely (server-side Vercel Function with the secret key in env).
 */
export interface BroadcastAdapter {
  pubkey: PublicKey;
  signAndBroadcast: (tx: Transaction, connection: Connection) => Promise<string>;
}

// ─── Local relayer (browser-stored keypair) ────────────────────────────────

export function localRelayerAdapter(relayer: BrowserKeypairWallet): BroadcastAdapter | null {
  if (!relayer.publicKey || !relayer.signTransaction) return null;
  const sign = relayer.signTransaction;
  return {
    pubkey: relayer.publicKey,
    signAndBroadcast: async (tx, connection) => {
      const signed = await sign(tx);
      return connection.sendRawTransaction(signed.serialize());
    },
  };
}

// ─── Shared relayer (server-side Vercel Function) ──────────────────────────

export interface SharedRelayerInfo {
  pubkey: PublicKey;
  balance: number; // lamports
}

/**
 * Probes /api/relayer-info. If the deployment has a configured shared relayer,
 * returns its pubkey + balance. If the endpoint isn't deployed (e.g., local
 * `npm run dev` without `vercel dev`) or the env vars aren't set, returns null.
 */
export async function fetchSharedRelayerInfo(): Promise<SharedRelayerInfo | null> {
  try {
    const res = await fetch("/api/relayer-info");
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.pubkey) return null;
    return { pubkey: new PublicKey(data.pubkey), balance: data.balance ?? 0 };
  } catch {
    return null;
  }
}

export function sharedRelayerAdapter(pubkey: PublicKey): BroadcastAdapter {
  return {
    pubkey,
    signAndBroadcast: async (tx) => {
      const b64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction: b64 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `relay failed (HTTP ${res.status})`);
      return data.signature;
    },
  };
}

/**
 * Ask the server to top up a recipient address. Server enforces:
 *   - recipient is a valid pubkey
 *   - recipient's balance is below the cap
 *   - per-call lamport amount is fixed
 */
export async function sharedTopUp(recipient: PublicKey): Promise<{ skipped?: boolean; signature?: string }> {
  const res = await fetch("/api/topup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: recipient.toBase58() }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `topup failed (HTTP ${res.status})`);
  return data;
}
