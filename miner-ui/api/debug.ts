import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * GET /api/debug
 * Reports exactly where the Solana import chain breaks (if it does).
 * Each import is wrapped in try/catch and reported individually.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const result: any = {
    node: process.version,
    env: {
      RELAYER_SECRET_KEY: !!process.env.RELAYER_SECRET_KEY,
      VITE_RELAYER_PUBKEY: process.env.VITE_RELAYER_PUBKEY ?? null,
      RPC_URL: process.env.RPC_URL ?? null,
    },
    steps: [] as Array<{ name: string; ok: boolean; error?: string }>,
  };

  async function step(name: string, fn: () => Promise<unknown> | unknown) {
    try {
      await fn();
      result.steps.push({ name, ok: true });
    } catch (e: any) {
      result.steps.push({ name, ok: false, error: e?.message ?? String(e) });
    }
  }

  await step("import @solana/web3.js", async () => {
    return await import("@solana/web3.js");
  });

  await step("create Keypair from env", async () => {
    const web3 = await import("@solana/web3.js");
    const arr = JSON.parse((process.env.RELAYER_SECRET_KEY ?? "[]").trim());
    return web3.Keypair.fromSecretKey(new Uint8Array(arr));
  });

  await step("create Connection", async () => {
    const web3 = await import("@solana/web3.js");
    return new web3.Connection((process.env.RPC_URL ?? "").trim(), "confirmed");
  });

  await step("getBalance(pubkey)", async () => {
    const web3 = await import("@solana/web3.js");
    const arr = JSON.parse((process.env.RELAYER_SECRET_KEY ?? "[]").trim());
    const kp = web3.Keypair.fromSecretKey(new Uint8Array(arr));
    const conn = new web3.Connection((process.env.RPC_URL ?? "").trim(), "confirmed");
    return await conn.getBalance(kp.publicKey);
  });

  res.status(200).json(result);
}
