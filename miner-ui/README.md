# Terminus Coin Miner UI

React + Vite client for mining TERM. Runs the keccak256 PoW loop in a Web Worker, submits claims via the connected wallet (Phantom / Solflare / Backpack).

## Quick start

```bash
npm install
cp .env.example .env       # edit if you want devnet instead of localnet
npm run dev                # http://localhost:5173
```

## Configuration

`.env` (copy from `.env.example`):

```
# Local validator (default)
VITE_RPC_URL=http://127.0.0.1:8899

# Or devnet
# VITE_RPC_URL=https://api.devnet.solana.com
```

Public RPCs are rate-limited under any real load. For anything beyond casual testing, use a private endpoint (Helius, QuickNode, Triton).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the production build locally |

## Architecture

```
src/
├── main.tsx           wallet provider setup (Phantom/Solflare/Backpack)
├── App.tsx            stat grid, controls, log feed
├── terminal.css       dark terminal aesthetic
├── miner.worker.ts    Web Worker running the keccak256 PoW loop
├── useChainState.ts   polls GlobalState + StakePool every 3s
└── useMiner.ts        worker lifecycle, claim submission, auto-restart
```

### Per-round flow

1. Fetch fresh `GlobalState` from RPC (always — never use stale React state)
2. Spawn a Web Worker with `(lastHash, pubkey, difficulty)`
3. Worker brute-forces a nonce until `keccak256(nonce || lastHash || pubkey)` meets the difficulty bits
4. Build a transaction: `setComputeUnitLimit(70_000)` + idempotent ATA creation + `claim(nonce)`
5. Sign with wallet, send, confirm
6. Restart loop (with backoff if the chain rejected the claim — e.g. rate-limited)

## Building the program first

The UI imports the IDL from `../target/idl/terminuscoin.json`. If you change the on-chain program, run `anchor build` from the repo root before `npm run dev`.
