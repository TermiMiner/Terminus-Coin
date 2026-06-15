// api/_env.ts — shared env bootstrap for the Vercel serverless relayer functions
// (relay, relayer-info, topup). Centralizes the fail-loud RPC guard, the relayer
// keypair load, the KV client, and the validated tip floor so the three handlers
// can't drift — especially MIN_TIP_TERM, which relay.ts ENFORCES and
// relayer-info.ts ADVERTISES; a divergence there would show one floor in the UI
// while the relayer rejects against another.
import { Keypair } from "@solana/web3.js";
import { Redis } from "@upstash/redis";

// Fail loud if RPC_URL is unset — never silently default to a public endpoint
// (a mainnet deploy must not route to the wrong network; the public node is
// rate-limited anyway). Called inside the handler so the throw is caught and
// returned as a 500 with this message, not an opaque cold-start crash.
export function getRpcUrl(): string {
  const rpc = (process.env.RPC_URL ?? "").trim();
  if (!rpc) throw new Error("RPC_URL is not set — refusing to default to a public RPC endpoint. Set RPC_URL to your cluster's RPC (devnet or mainnet).");
  return rpc;
}

// Load the relayer's signing keypair from RELAYER_SECRET_KEY (JSON byte array).
// Throws if unset — callers that tolerate "no relayer" (relayer-info) must check
// process.env.RELAYER_SECRET_KEY themselves before calling this.
export function loadRelayerKeypair(): Keypair {
  const raw = process.env.RELAYER_SECRET_KEY;
  if (!raw) throw new Error("RELAYER_SECRET_KEY env var not set");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw.trim())));
}

// Upstash / Vercel-KV client, or null when not provisioned (the quota guards are
// then SKIPPED — fine for devnet, NOT safe for mainnet; see RELAYER_OPERATOR.md).
// Accepts either Vercel KV's legacy env names or Upstash Marketplace's native ones.
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   ?? process.env.KV_REST_API_URL   ?? "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
export const kv = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

// Relayer's permanent cost-recovery floor (raw TERM units, 6 decimals). Validated
// fail-loud: a non-integer/negative would silently drop the floor on the money
// path (parseInt("0.5")===0, parseInt("0.5TERM")===NaN both pass an old `> 0`
// guard as false). Falls back to the legacy env name; empty → default 0.5 TERM.
// A function (not a module const) so topup.ts — which imports kv but never uses
// the floor — isn't coupled to its validity.
export function getMinTipTerm(): number {
  const raw = (process.env.MIN_TIP_TERM ?? process.env.MIN_BOOTSTRAP_TIP_TERM ?? "500000").trim();
  if (raw === "") return 500_000; // empty env → default floor, never a silent 0
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`MIN_TIP_TERM must be a non-negative integer in raw TERM units (6 decimals); got ${JSON.stringify(raw)}`);
  }
  return n;
}
