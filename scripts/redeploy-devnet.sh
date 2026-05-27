#!/usr/bin/env bash
#
# redeploy-devnet.sh — one-command program redeploy + IDL sync for devnet.
#
# Solves the workflow gap that bit us on 2026-05-26: program code changes
# need an explicit `solana program deploy`, but the UI auto-deploys via
# Vercel on push. Easy to commit program changes, push to main, see the UI
# update, and forget the program never updated. The UI then sends new claim
# signatures against an old binary and mining breaks with confusing errors.
#
# This script:
#   1. Builds the program (anchor build)
#   2. Checks deployer SOL balance
#   3. Deploys to devnet
#   4. Verifies the new slot
#   5. Syncs IDL to miner-ui/
#   6. Reminds about Vercel + announcement to testers
#
# Usage:
#   bash scripts/redeploy-devnet.sh

set -e

RPC="https://api.devnet.solana.com"
WALLET="$HOME/.config/solana/devnet-wallet.json"
PROGRAM_ID="FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y"
PROGRAM_KEYPAIR="$(dirname "$0")/../target/deploy/terminuscoin-keypair.json"
PROGRAM_BINARY="$(dirname "$0")/../target/deploy/terminuscoin.so"

cd "$(dirname "$0")/.."

# ─── 1. Build ────────────────────────────────────────────────────────────────
echo "── 1. Building program (anchor build)..."
anchor build > /tmp/anchor-build.log 2>&1 || {
  echo "  ✗ build failed — see /tmp/anchor-build.log"
  tail -20 /tmp/anchor-build.log
  exit 1
}
echo "  ✓ build OK ($(stat -c%s "$PROGRAM_BINARY" 2>/dev/null || stat -f%z "$PROGRAM_BINARY") bytes)"

# ─── 2. Check deployer balance ───────────────────────────────────────────────
DEPLOYER=$(solana-keygen pubkey "$WALLET")
BAL=$(solana balance "$DEPLOYER" --url "$RPC" 2>&1 | awk '{print $1}')
echo "── 2. Deployer: $DEPLOYER"
echo "     Balance: $BAL SOL"

# Need ~0.005 SOL for tx fees on a redeploy (buffer rent gets refunded on success)
NEED_SOL="0.5"
if (( $(echo "$BAL < $NEED_SOL" | bc -l) )); then
  echo "  ✗ insufficient SOL (need ≥ $NEED_SOL)"
  echo "    Try: solana airdrop 1 $DEPLOYER --url $RPC"
  exit 1
fi

# ─── 3. Capture pre-deploy slot ──────────────────────────────────────────────
OLD_SLOT=$(solana program show "$PROGRAM_ID" --url "$RPC" 2>&1 | grep "Last Deployed In Slot" | awk '{print $NF}')
echo "── 3. Current on-chain slot: $OLD_SLOT"

# ─── 4. Deploy ───────────────────────────────────────────────────────────────
echo "── 4. Deploying..."
solana program deploy "$PROGRAM_BINARY" \
  --url "$RPC" \
  --keypair "$WALLET" \
  --program-id "$PROGRAM_KEYPAIR" 2>&1 | tail -3

NEW_SLOT=$(solana program show "$PROGRAM_ID" --url "$RPC" 2>&1 | grep "Last Deployed In Slot" | awk '{print $NF}')
if [ "$NEW_SLOT" = "$OLD_SLOT" ]; then
  echo "  ✗ slot unchanged — deploy may have failed"
  exit 1
fi
echo "  ✓ slot: $OLD_SLOT → $NEW_SLOT"

# ─── 5. Sync IDL ─────────────────────────────────────────────────────────────
echo "── 5. Syncing IDL to miner-ui/..."
cp target/idl/terminuscoin.json miner-ui/idl/terminuscoin.json
echo "  ✓ IDL synced"

# ─── 6. Reminders ────────────────────────────────────────────────────────────
echo
echo "── Done. Next steps:"
echo "   • Commit the IDL change: git add miner-ui/idl/terminuscoin.json && git commit"
echo "   • Push: triggers Vercel UI redeploy"
echo "   • If BondAccount layout changed, ANNOUNCE to active testers — old bonds"
echo "     become undeserializable (stranded 0.001 SOL per affected wallet)"
echo "   • Smoke-test: BOOTSTRAP_URL=... npx ts-node scripts/test_bootstrap_relayer.ts"
