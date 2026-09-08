# Working on Terminus Coin from a phone / cloud session

This repo can be driven remotely — from the Claude mobile app or **claude.ai/code** — because it lives on GitHub (`TermiMiner/Terminus-Coin`) with no secrets committed. A remote session runs in a **fresh cloud sandbox**: it clones the repo, works on a branch, and opens a PR. It does **not** have access to this machine's filesystem, wallets, or environment.

This doc records which tasks are safe to run in that sandbox and which must stay on the local operator machine. The dividing line is simple:

> **If a task needs to sign a transaction or read a private key, it stays local. Everything else can run remotely.**

None of the sensitive material below is in the repo, and it must never be pasted into a remote session or committed.

---

## Safe to run remotely (cloud sandbox / mobile)

These touch only source, config, and docs — no signing keys required.

| Task | Notes |
|---|---|
| Edit the on-chain program (`programs/`) | Rust changes, refactors, new instructions. `anchor build` runs in the sandbox. |
| Edit the miner UI (`miner-ui/`) | Frontend/TS work, `npm run build`, type-checks. |
| Edit or add scripts (`scripts/`) | Writing/reviewing the `.ts` scripts is fine — *running* the ones that sign is not (see below). |
| Docs & markdown | `README.md`, `MAINNET_CHECKLIST.md`, `RELAYER_OPERATOR.md`, everything in `docs/`. |
| Lint / format | `npm run lint`, `npm run lint:fix`. |
| IDL sync | `npm run sync-idl` (pure file copy). |
| Review, plan, open PRs | The normal remote workflow — branch + PR you approve from your phone. |

**Anchor tests** (`npm test`) need a local `solana-test-validator` **and** the `ANCHOR_WALLET` at `~/.config/solana/devnet-wallet.json`. They can run remotely *only* against a throwaway keypair generated inside the sandbox — never the real devnet wallet. Simplest to just run them locally.

---

## Must stay on the local operator machine

Each of these signs with, or reads, a key that exists only on this box. It will fail in the sandbox (key absent) — and must never be "fixed" by uploading the key.

| Task | Script / command | Needs |
|---|---|---|
| Mainnet launch | `scripts/mainnet-launch.sh` | mainnet deployer keypair |
| Devnet deploy / upgrade | `npm run redeploy:devnet` (`scripts/redeploy-devnet.sh`) | program upgrade authority |
| Initialize program | `scripts/initialize_program.ts` | program authority wallet |
| Initialize vesting | `npm run vesting` | authority wallet |
| Set rate limit | `npm run rate-limit` | authority wallet |
| Create token metadata | `npm run metadata` | mint authority |
| Team vest claim | `npm run team-claim` (`scripts/claim_team_vest.ts`) | `team-wallet.json` |
| Run the shared relayer | see `RELAYER_OPERATOR.md` | `term-shared-relayer.json` / Vercel env key |

---

## Where the secrets live (all local-only, none in git)

| Secret | Location | Used by |
|---|---|---|
| Team wallet | `~/team-wallet.json` | team vest claim |
| Shared relayer key | `~/term-shared-relayer.json` | relayer signing (prod key lives in Vercel env, not the repo) |
| Devnet wallet | `~/.config/solana/devnet-wallet.json` | `ANCHOR_WALLET` for tests/scripts |
| Local validator keypairs | `test-ledger/*.json` | local `solana-test-validator` (gitignored) |
| Frontend env | `miner-ui/.env` | build-time config (gitignored; `.env.example` is the template) |

These are gitignored or outside the repo tree by design. Keep it that way. The relayer's production private key belongs **only** in Vercel's environment variables, as noted in `RELAYER_OPERATOR.md`.

---

## Running a remote session

1. Open the Claude app or **claude.ai/code**, signed in to the account that owns the repo access.
2. Confirm the Claude GitHub app can reach `TermiMiner/Terminus-Coin`.
3. Start a Code session on that repo and describe the task — keep it to the "safe remotely" column above.
4. If a remote task genuinely needs configuration, add only **non-sensitive** values through the cloud environment's settings. Never a private key.
