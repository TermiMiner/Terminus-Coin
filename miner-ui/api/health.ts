import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * GET /api/health
 * Diagnostic endpoint — verifies the Vercel Function infrastructure works
 * independent of our Solana code. Returns which env vars are set (without
 * revealing their values). Used to triage 500s from the other endpoints.
 */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    node: process.version,
    env: {
      RELAYER_SECRET_KEY: !!process.env.RELAYER_SECRET_KEY,
      VITE_RELAYER_PUBKEY: process.env.VITE_RELAYER_PUBKEY ?? null,
      RPC_URL: process.env.RPC_URL ?? null,
    },
  });
}
