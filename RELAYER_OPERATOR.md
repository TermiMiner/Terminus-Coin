# Running a Terminus Coin relayer

This document explains how to fork the repo and run your own gasless-mining relayer for TERM. The relayer pays Solana transaction fees on behalf of miners so they don't need to top up SOL themselves — a one-time bootstrap top-up gives a fresh wallet enough SOL to deposit its bond and pay its own ongoing fees, and the `/api/relay` endpoint signs claim transactions with the relayer's key.

The default operator (project) runs a relayer on devnet. This doc lets anyone run a parallel one — useful for redundancy, regional latency, or simply because the project's relayer is rate-limited.

---

## Architecture

Three Vercel Functions handle everything:

| Endpoint | Purpose |
|---|---|
| `GET /api/relayer-info` | Public: returns relayer pubkey + balance + (if KV provisioned) the remaining daily-spend headroom and per-wallet topup quota. The UI auto-detects shared mode via this endpoint. |
| `POST /api/topup` | Sends a one-time 0.015 SOL bootstrap to a fresh burner address. Quota-gated. |
| `POST /api/relay` | Signs a partially-signed claim transaction with the relayer's key and broadcasts it. Strict instruction allowlist — only signs txs targeting our program + Token / ATA / ComputeBudget programs. |

The relayer's private key lives **only** in Vercel's environment variables — never in the bundle, never on the client.

---

## Step 1: Fork the repo

```
gh repo fork TermiMiner/Terminus-Coin
```

Or via the GitHub web UI. Clone your fork locally if you want to run anything.

## Step 2: Generate a relayer keypair

```bash
solana-keygen new -o relayer-keypair.json --no-bip39-passphrase
solana-keygen pubkey relayer-keypair.json    # save this
```

**Never commit this file.** The repo's `.gitignore` doesn't list it explicitly — keep it outside the repo entirely (e.g., `~/term-relayer.json`).

## Step 3: Fund the relayer

Devnet:
```bash
solana airdrop 5 <RELAYER_PUBKEY> --url devnet
```

Mainnet (when ready):
```bash
solana transfer <RELAYER_PUBKEY> <AMOUNT> --keypair <YOUR_FUNDING_WALLET> --url mainnet-beta
```

Recommended starting balance for a new operator: **2–5 SOL on devnet**, **0.5–2 SOL on mainnet**. The daily cap (below) bounds how fast it can be drained.

## Step 4: Provision Upstash Redis

The Redis store backs the per-wallet quota, per-IP rate limit, and daily-spend tracker. **Skipping this step means the relayer has no rate limits and can be drained quickly** — only fine for devnet experimentation, never for mainnet.

1. In your Vercel project: **Storage** → **Create Database** → pick **Upstash → Serverless DB (Redis, Vector, Queue, Search)** from the Marketplace and provision a Redis database
2. Name it (e.g., `term-relayer-kv`)
3. Click **Connect to Project** — the Marketplace integration auto-injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. (The legacy `KV_REST_API_URL`/`KV_REST_API_TOKEN` names from the old Vercel KV integration are also accepted as a fallback.)
4. Free tier is fine: 10K commands/day covers thousands of mining sessions

## Step 5: Set environment variables

In Vercel project settings → **Environment Variables**, add:

### Required

| Name | Value | Notes |
|---|---|---|
| `RELAYER_SECRET_KEY` | Content of `relayer-keypair.json` — the `[1,2,…,64]` array | Paste the whole array. Never share. |
| `VITE_RELAYER_PUBKEY` | Pubkey from `solana-keygen pubkey` | Public — used by frontend to detect shared mode |
| `RPC_URL` | `https://api.devnet.solana.com` or your private RPC | Trailing whitespace matters — none |

### Optional (quota tuning)

Defaults are sensible; override only if you understand the trade-offs.

| Name | Default | What it controls |
|---|---|---|
| `MAX_TOPUPS_PER_WALLET` | `1` | How many bootstrap top-ups a single wallet can ever receive. |
| `MAX_TOPUPS_PER_IP_PER_HR` | `5` | How many top-up requests one IP can make per hour. Sliding 1-hour window. |
| `MAX_RELAYS_PER_IP_PER_HR` | `120` | How many claim-relay requests one IP can make per hour. ~2/min — matches the on-chain 60s rate limit. |
| `MAX_DAILY_LAMPORTS` | `1000000000` (1 SOL) | Total relayer SOL outflow per UTC day. Counts both top-ups and relay fees against the same budget. When hit, the relayer auto-rejects new requests until tomorrow. |

## Step 6: Deploy

```
vercel deploy --prod
```

Or push to `main` and let Vercel's GitHub integration build automatically.

## Step 7: Verify

```bash
curl https://<your-deployment>.vercel.app/api/relayer-info
```

Expected response:
```json
{
  "pubkey": "EvT7...",
  "balance": 5000000000,
  "dailyCap": 1000000000,
  "dailySpent": 0,
  "dailyRemaining": 1000000000
}
```

If `dailyCap` is absent, KV isn't connected — go back to Step 4.

If `balance` is 0, the relayer wallet isn't funded — Step 3.

If you get a 500 error, check the Function logs in Vercel — most common cause is a typo in `RELAYER_SECRET_KEY` (must be a valid JSON array of exactly 64 numbers).

---

## Operating the relayer

### Daily monitoring

Visit `/api/relayer-info?wallet=<your-pubkey>` to see at a glance:

- How much SOL the relayer has left
- How much has been spent today
- How much daily-cap headroom remains
- How many top-ups your wallet has used

Set a reminder to check this once a day until you have a feel for the drain rate. Re-fund when balance falls below 1 day's worth of drain.

### Detecting abuse

Symptoms of an attack on your relayer:

| Signal | Likely cause |
|---|---|
| Daily budget hits cap within an hour of midnight UTC | Single-actor draining as fast as possible; check IP rate limits are firing |
| `dailySpent` climbs much faster than the rate of organic mining | Sybil farm or bot run targeting your endpoint |
| Vercel function logs show many `429` responses | Quota gates are working — good, but the attacker keeps probing |
| Same IP across thousands of distinct wallet pubkeys | Classic Sybil; tighten `MAX_TOPUPS_PER_IP_PER_HR` |

Response options, in order:

1. **Tighten env vars**: lower `MAX_TOPUPS_PER_IP_PER_HR` and `MAX_DAILY_LAMPORTS`. Takes effect on next request (no redeploy needed).
2. **Pause the relayer**: set `MAX_DAILY_LAMPORTS=0`. Effectively disables top-up + relay until you re-enable.
3. **Rotate the keypair**: generate a new one, update `RELAYER_SECRET_KEY` + `VITE_RELAYER_PUBKEY`, redeploy. Old wallet is harmless (no key compromise — the original key still works), but if you want a clean break this is the way.

### The kill-switch path (test this before mainnet)

Verify the daily cap actually disables the relayer:

```bash
# Set the cap absurdly low — 100 lamports
vercel env add MAX_DAILY_LAMPORTS production
# Enter: 100

# Trigger a redeploy. Wait ~1 minute.
# Then try a topup:
curl -X POST https://<deployment>/api/topup \
  -H 'Content-Type: application/json' \
  -d '{"recipient":"<any pubkey>"}'

# Expected: 429 "relayer daily budget exhausted"
```

Reset to a reasonable value once you've confirmed the gate fires.

---

## Hardening for mainnet

Devnet defaults are designed for tester convenience. For mainnet:

1. **Lower `MAX_TOPUPS_PER_WALLET` to `1`.** Anyone who needs more bootstrap can either fund themselves or use a different relayer.
2. **Lower `MAX_DAILY_LAMPORTS` to match your appetite** for being drained on a bad night. 0.5 SOL ≈ $100 is a sensible cap to start.
3. **Use a dedicated funding wallet** that holds only the operator-budgeted amount. Don't connect the relayer to your main treasury — if it's ever compromised, the loss is bounded.
4. **Watch the first 48 hours closely.** Tighten or pause if anything looks off. Adjust upward only once usage patterns are clear.
5. **Plan an exit strategy.** Gasless onboarding is a launch promotion, not a forever-commitment. After 30–90 days, consider disabling top-ups (set `MAX_TOPUPS_PER_WALLET=0`) and letting the network move to fully self-funded mining.

---

## Forking the relayer code only

If you want to run only the API portion of the relayer (no UI), the three files are:

```
miner-ui/api/relayer-info.ts
miner-ui/api/topup.ts
miner-ui/api/relay.ts
```

Each is self-contained — no shared imports. You can copy these into a minimal Vercel project (or another serverless host) and they'll work as long as you set the env vars above and bring `@solana/web3.js` and `@upstash/redis` as dependencies.

The UI doesn't care which relayer it talks to — it auto-detects based on the Vercel domain it's deployed under. If you want users to use *your* relayer specifically, point them at your Vercel URL.
