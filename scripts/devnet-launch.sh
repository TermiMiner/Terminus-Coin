#!/usr/bin/env bash
#
# devnet-launch.sh — one-shot devnet launch sequence.
#
# Steps:
#   1. Verify wallet has enough SOL (~3.5 SOL minimum)
#   2. Deploy program (skipped if already deployed)
#   3. yarn demo            (initialize program + stake pool, idempotent)
#   4. yarn vesting         (reserve 100M for team, idempotent)
#   5. yarn rate-limit 60   (enable per-wallet cooldown)
#   6. Print final state summary
#
# Usage:
#   bash scripts/devnet-launch.sh <TEAM_WALLET_PUBKEY>
#
# Example:
#   bash scripts/devnet-launch.sh FNg7UWMETwFxrdmNgkp2Hg42LHBxUgT8b3tS9Q6XiD4R

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
RPC="https://api.devnet.solana.com"
WALLET="$HOME/.config/solana/devnet-wallet.json"
PROGRAM_ID="FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y"
PROGRAM_KEYPAIR="$(dirname "$0")/../target/deploy/terminuscoin-keypair.json"
PROGRAM_BINARY="$(dirname "$0")/../target/deploy/terminuscoin.so"
RATE_LIMIT_SECONDS=60
MIN_SOL_REQUIRED=4.3  # Rent for ~607KB program binary + tx fees + bond rent

# ─── Args ────────────────────────────────────────────────────────────────────
TEAM_WALLET="${1:-}"
if [[ -z "$TEAM_WALLET" ]]; then
  echo "Usage: $0 <TEAM_WALLET_PUBKEY>"
  echo "Example: $0 FNg7UWMETwFxrdmNgkp2Hg42LHBxUgT8b3tS9Q6XiD4R"
  exit 1
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────
section() { echo ""; echo "━━━ $1 ━━━"; }

# ─── Pre-flight checks ───────────────────────────────────────────────────────
section "Pre-flight"

WALLET_PUBKEY=$(solana-keygen pubkey "$WALLET")
echo "Deployer wallet : $WALLET_PUBKEY"
echo "Team wallet     : $TEAM_WALLET"
echo "RPC             : $RPC"
echo "Program ID      : $PROGRAM_ID"

if [[ ! -f "$PROGRAM_BINARY" ]]; then
  echo "ERROR: program binary not found at $PROGRAM_BINARY"
  echo "Run 'cargo build-sbf' first."
  exit 1
fi

BALANCE_SOL=$(solana balance "$WALLET" --url "$RPC" 2>/dev/null | awk '{print $1}')
echo "Balance         : $BALANCE_SOL SOL"
if (( $(echo "$BALANCE_SOL < $MIN_SOL_REQUIRED" | bc -l) )); then
  echo "ERROR: Need at least $MIN_SOL_REQUIRED SOL, have $BALANCE_SOL"
  exit 1
fi

# ─── 1. Deploy program ───────────────────────────────────────────────────────
section "1. Deploy program"

PROGRAM_ON_CHAIN=$(curl -s -X POST "$RPC" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$PROGRAM_ID\",{\"encoding\":\"base64\"}]}" \
  | python3 -c "import sys,json; print('YES' if json.load(sys.stdin)['result']['value'] else 'NO')")

if [[ "$PROGRAM_ON_CHAIN" == "YES" ]]; then
  echo "Program already deployed at $PROGRAM_ID — skipping deploy."
else
  echo "Deploying $PROGRAM_BINARY → $PROGRAM_ID …"
  solana program deploy "$PROGRAM_BINARY" \
    --url "$RPC" \
    --keypair "$WALLET" \
    --program-id "$PROGRAM_KEYPAIR"
fi

# ─── 2. Initialize (program + stake pool + bond vault + bond + mining test) ──
section "2. Initialize program, stake pool, bond vault, bond + sanity-mine (yarn demo, idempotent)"

ANCHOR_PROVIDER_URL="$RPC" \
ANCHOR_WALLET="$WALLET" \
npx ts-node -P tsconfig.json scripts/pow_demo.ts

# ─── 3. Initialize team vesting ──────────────────────────────────────────────
section "3. Initialize team vesting (yarn vesting, idempotent)"

ANCHOR_PROVIDER_URL="$RPC" \
ANCHOR_WALLET="$WALLET" \
npx ts-node -P tsconfig.json scripts/initialize_vesting.ts \
  --team-wallet "$TEAM_WALLET"

# ─── 4. Set rate limit ───────────────────────────────────────────────────────
section "4. Set per-wallet rate limit to ${RATE_LIMIT_SECONDS}s"

ANCHOR_PROVIDER_URL="$RPC" \
ANCHOR_WALLET="$WALLET" \
npx ts-node -P tsconfig.json scripts/set_rate_limit.ts "$RATE_LIMIT_SECONDS"

# ─── 5. Final summary ────────────────────────────────────────────────────────
section "Launch complete"

echo "Devnet RPC      : $RPC"
echo "Program ID      : $PROGRAM_ID"
echo "Team wallet     : $TEAM_WALLET"
echo "Rate limit      : ${RATE_LIMIT_SECONDS}s per wallet"
echo ""
echo "Next steps:"
echo "  • Set miner-ui RPC: echo 'VITE_RPC_URL=$RPC' > miner-ui/.env"
echo "  • (Optional) Attach token metadata: ANCHOR_PROVIDER_URL=$RPC ANCHOR_WALLET=$WALLET yarn metadata --uri <ARWEAVE_URL>"
echo "  • Verify in browser: open https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
echo ""
echo "⚠ Upgrade authority is RETAINED on this devnet deploy (intentional — lets us iterate)."
echo "  Currently held by: $WALLET_PUBKEY"
echo "  Verify: solana program show $PROGRAM_ID --url $RPC"
echo ""
echo "BEFORE MAINNET — read MAINNET_CHECKLIST.md and execute the upgrade-authority"
echo "sunset (transfer to multisig OR lock with --final). This step is non-reversible"
echo "so it must be a deliberate decision, not a launch-day surprise."
