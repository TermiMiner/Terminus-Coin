/**
 * Shared helpers for the Vercel API functions.
 * The leading underscore tells Vercel not to expose this as an endpoint.
 */

import { Connection, Keypair } from "@solana/web3.js";

export const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

export const PROGRAM_ID = "FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y";

export function getRelayerKeypair(): Keypair {
  const json = process.env.RELAYER_SECRET_KEY;
  if (!json) throw new Error("RELAYER_SECRET_KEY env var not set");
  let arr: unknown;
  try { arr = JSON.parse(json); } catch { throw new Error("RELAYER_SECRET_KEY must be a JSON array of 64 numbers"); }
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error("RELAYER_SECRET_KEY must be a JSON array of 64 numbers");
  }
  return Keypair.fromSecretKey(new Uint8Array(arr as number[]));
}

export function getConnection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}
