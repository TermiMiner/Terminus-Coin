# Terminus Coin (TERM)

Proof-of-work SPL token on Solana. Miners burn keccak256 hashes to claim emissions; the network self-regulates via bidirectional difficulty adjustment.

- **Program ID:** `FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y`
- **Decimals:** 6
- **Supply cap:** 1,000,000,000 TERM
- **Mechanism:** keccak256 PoW with miner pubkey baked into hash input (anti-front-running)

## Tokenomics

| Allocation | Amount | Schedule |
|---|---|---|
| Mining | 900M TERM (90%) | 17 TERM/claim epoch 0, halving every 5 years, 10 epochs (50-year programme) |
| Team — tranche 0 | 50M TERM (5.0%) | Unlocks at launch |
| Team — tranche 1 | 25M TERM (2.5%) | Unlocks at year 5 |
| Team — tranche 2 | 15M TERM (1.5%) | Unlocks at year 7 |
| Team — tranche 3 | 10M TERM (1.0%) | Unlocks at year 10 |

Per-claim split: **96% to miner**, **0.25–5% burned** (dynamic — see below), **3% to staking treasury** (only credited when stakers exist).

In addition, when stakers exist, each claim contributes a fixed **0.01 TERM fee** to the staking treasury. This fee is constant regardless of epoch, so it remains the dominant treasury source after the halving curve flattens — providing a perpetual security budget that doesn't depend on emissions.

## Dynamic burn

Burn rate scales with network heat (difficulty). Anchored on log₂(difficulty):

| Difficulty | log₂ | Burn rate |
|---|---|---|
| ≤ 256 | ≤ 8 bits | 0.25% (network cold) |
| 4,096 | 12 bits | 1.4% (initial) |
| 65,536 | 16 bits | 2.6% |
| 1,048,576 | 20 bits | 3.8% |
| ≥ 16,777,216 | ≥ 24 bits | 5% (network hot) |

When mining is in high demand the protocol becomes more deflationary; when activity is low the burn relaxes. The burn always happens as a real on-chain SPL `burn` instruction (mint-then-burn pattern, visible in explorers).

## Difficulty (continuous target)

`difficulty` is a u64 multiplier — a hash is valid if its first 8 bytes interpreted as a big-endian u64 are ≤ `u64::MAX / difficulty`. Probability ≈ 1 / difficulty.

Adjustment after each window (100 claims completed OR 600s elapsed):
```
factor = (claims_in_window × TARGET_WINDOW) / (TARGET_CLAIMS × actual_window_seconds)
new_difficulty = clamp(old × factor, old/2, old×2)
```

Bounded to ±2× per adjustment to prevent oscillation. Range: `[16, 2^40]`. Initial: 4,096.

## Anti-Sybil bond

Each miner must deposit a one-time anti-Sybil bond before mining. Two payment options — pick one:

| Option | Locks | Recoverable | When |
|---|---|---|---|
| **SOL bond** (`deposit_bond`) | ~0.001 SOL of account rent | `withdraw_bond` after 1h cooldown | Bootstrap path — universally available |
| **TERM bond** (`deposit_bond_term`) | 20 TERM in shared escrow vault | `withdraw_bond_term` after 1h cooldown | Endogenous — for established miners |

Mutually exclusive — Anchor's `init` constraint enforces one BondAccount per wallet. Sybil cost scales linearly either way: 1000 wallets ≈ 1 SOL or 20,000 TERM continuously locked. The mining UI bundles SOL bond deposit into the first claim transaction automatically (single wallet popup).

The authority's `set_rate_limit` lever stays active during bootstrap (year 0–1) and is automatically ignored after **year 1 (PHASE2_ACTIVATION_SECS)** — the bond plus PoW make it redundant, and a permanent authority-set rate limit would be a censorship vector.

## Difficulty adjustment

Target: 100 claims per 600s window. Window fills before expiry → +1 bit; window expires before fill → −1 bit. Range 1–28. Initial: 12.

## Layout

```
programs/terminuscoin/   on-chain Anchor program (Rust)
tests/                   integration tests (ts-mocha)
scripts/                 operational scripts (TS + bash)
miner-ui/                React + Vite mining client
target/                  build artifacts (gitignored)
```

## Local development

Requires Solana CLI 2.x, Anchor 0.32, Rust 1.89, Node 18+, yarn.

```bash
# Build the program
anchor build

# Start a local validator (separate terminal)
solana-test-validator --reset

# Deploy + initialize + sanity-mine 3 rounds
solana program deploy target/deploy/terminuscoin.so \
  --keypair ~/.config/solana/devnet-wallet.json \
  --program-id target/deploy/terminuscoin-keypair.json
yarn demo

# Run the full test suite
yarn test
```

### Available yarn scripts

| Command | Purpose |
|---|---|
| `yarn test` | Full test suite (27 tests, ~1 min) |
| `yarn demo` | Initialize program + stake pool + bond + 3 sanity claims (idempotent) |
| `yarn vesting --team-wallet <PUBKEY>` | Reserve 100M for team vesting (idempotent) |
| `yarn rate-limit <seconds>` | Set per-wallet claim cooldown |
| `yarn metadata [--uri <URL>]` | Attach Metaplex token metadata (idempotent) |
| `yarn measure` | Measure compute units + fee for a single claim |

All scripts default to `http://127.0.0.1:8899`. Override with `ANCHOR_PROVIDER_URL` for devnet/mainnet.

## Devnet launch

The full sequence is wrapped in `scripts/devnet-launch.sh`:

```bash
# Fund the deployer wallet with ~3.5 SOL of devnet SOL
solana airdrop 2 --url devnet
solana airdrop 2 --url devnet

# Run the full launch — deploys, initializes, reserves vesting, sets rate limit
bash scripts/devnet-launch.sh <TEAM_WALLET_PUBKEY>

# Point the mining UI at devnet
echo "VITE_RPC_URL=https://api.devnet.solana.com" > miner-ui/.env
cd miner-ui && npm run dev
```

> The devnet deploy intentionally **retains** the upgrade authority on the deployer wallet so we can iterate. Before mainnet, this must be sunset — see [`MAINNET_CHECKLIST.md`](./MAINNET_CHECKLIST.md) item 1. The devnet-launch script prints a reminder at the end.

## Authority management

The program has **three distinct authority concepts**, each with its own lifecycle:

| Authority | Controls | Devnet posture | Mainnet posture |
|---|---|---|---|
| Solana **upgrade authority** | Ability to ship new program code | Retained (deployer wallet) | **Must be transferred to multisig OR locked with `--final` before public mainnet announcement.** See [`MAINNET_CHECKLIST.md`](./MAINNET_CHECKLIST.md). |
| Program `authority` | `set_paused`, `set_rate_limit`, `disable_freeze_authority`, vesting init | Deployer wallet | Multisig (Squads recommended) |
| `freeze_authority` | `set_freeze` (soft-block specific wallets from claiming) | Deployer wallet | Multisig — and consider calling `disable_freeze_authority()` to permanently remove the capability |

All three are **separate keys** at the protocol level. Compromise of one does not compromise the others. The mainnet plan is to separate them across distinct multisigs.

### Two-step transfer (program authority + freeze authority)

Both `authority` and `freeze_authority` use a **two-step transfer** to prevent bricking the program with a typo or unreachable address:

```
propose_authority(new_pubkey)   ← signed by current authority
accept_authority()              ← signed by new_pubkey (becomes authority)
cancel_authority_transfer()     ← signed by current authority (clears pending)
```

Same flow for the freeze authority (`propose_freeze_authority`, `accept_freeze_authority`, `cancel_freeze_authority_transfer`).

### Permanently disabling freeze

Once Sybil resistance from the bond + PoW is proven sufficient, the program authority can call `disable_freeze_authority()` to set `freeze_authority = Pubkey::default()`. This is **irreversible** — no one can ever satisfy the `has_one` constraint again, so `set_freeze` permanently fails. Recommended graduation step before mainnet for credibility.

## License

ISC
