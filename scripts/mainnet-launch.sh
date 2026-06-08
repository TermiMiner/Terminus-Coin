#!/usr/bin/env bash
#
# mainnet-launch.sh — guarded mainnet-beta launch sequence.
#
# Mirrors devnet-launch.sh, hardened for irreversible mainnet:
#   • RPC_URL and DEPLOYER are REQUIRED (no devnet/public defaults — fail loud).
#   • The cluster's genesis hash is verified to be mainnet-beta before anything
#     touches chain.
#   • Every irreversible step needs an explicit "yes".
#   • Initialize uses initialize_program.ts, which mints NOTHING — no insider
#     pre-launch balance (the devnet pow_demo sanity-mine is intentionally NOT
#     used here).
#   • TS steps are invoked directly with explicit env — NOT via `yarn`, whose
#     package.json scripts hardcode localhost/devnet (MAINNET_CHECKLIST item #4).
#
# It deliberately does NOT perform (separate, hardware-wallet / day-0 ceremonies
# — the script stops and prints exact next steps):
#   • the upgrade-authority + program-authority transfer to the Squads multisig
#     and the freeze-authority sunset (MAINNET_CHECKLIST §1, §2),
#   • Raydium liquidity seeding,
#   • the Vercel env flip (VITE_RPC_URL / RPC_URL → mainnet).
#
# DEPLOYER must be a keypair FILE: the initialize/vesting/rate-limit steps run
# through AnchorProvider, which cannot sign with a Ledger directly. Use a fresh
# keypair (§3) and move it to cold storage afterward; §1 hands UPGRADE authority
# to the hardware-wallet multisig.
#
# Usage:
#   RPC_URL=<mainnet RPC> DEPLOYER=<path/to/deployer-keypair.json> \
#     [METADATA_URI=<arweave-json-url>] \
#     bash scripts/mainnet-launch.sh <TEAM_WALLET_PUBKEY>

set -euo pipefail

# ─── Required configuration (no defaults) ─────────────────────────────────────
RPC="${RPC_URL:-}"
WALLET="${DEPLOYER:-}"
TEAM_WALLET="${1:-}"
METADATA_URI="${METADATA_URI:-}"

PROGRAM_ID="FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y"
PROGRAM_KEYPAIR="$(dirname "$0")/../target/deploy/terminuscoin-keypair.json"
PROGRAM_BINARY="$(dirname "$0")/../target/deploy/terminuscoin.so"
RATE_LIMIT_SECONDS=60
MIN_SOL_REQUIRED=4.5
MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"

cd "$(dirname "$0")/.."

# ─── Helpers ──────────────────────────────────────────────────────────────────
section() { echo ""; echo "━━━ $1 ━━━"; }
confirm() {
  echo ""
  echo "⚠ $1"
  read -r -p "   Type 'yes' to proceed (anything else aborts): " _ans
  [[ "${_ans:-}" == "yes" ]] || { echo "Aborted."; exit 1; }
}

# ─── Validate args / env (fail loud) ──────────────────────────────────────────
fail=0
[[ -z "$RPC" ]]         && { echo "ERROR: set RPC_URL to your private mainnet RPC (no public default — it's rate-limited)."; fail=1; }
[[ -z "$WALLET" ]]      && { echo "ERROR: set DEPLOYER to the mainnet deployer keypair FILE (fresh per §3, NOT the devnet wallet)."; fail=1; }
[[ -z "$TEAM_WALLET" ]] && { echo "ERROR: pass <TEAM_WALLET_PUBKEY> as the first argument."; fail=1; }
if [[ "$fail" == 1 ]]; then
  echo ""
  echo "Usage: RPC_URL=<rpc> DEPLOYER=<keypair.json> [METADATA_URI=<url>] bash $0 <TEAM_WALLET_PUBKEY>"
  exit 1
fi
[[ -f "$WALLET" ]]          || { echo "ERROR: deployer keypair file not found: $WALLET"; exit 1; }
[[ -f "$PROGRAM_BINARY" ]]  || { echo "ERROR: program binary not found: $PROGRAM_BINARY"; echo "Build the AUDITED binary first: anchor build --verifiable"; exit 1; }
[[ -f "$PROGRAM_KEYPAIR" ]] || { echo "ERROR: program keypair not found: $PROGRAM_KEYPAIR"; exit 1; }

# ─── Pre-flight ───────────────────────────────────────────────────────────────
section "Pre-flight"
WALLET_PUBKEY=$(solana-keygen pubkey "$WALLET")
BINARY_SHA=$(sha256sum "$PROGRAM_BINARY" | awk '{print $1}')
echo "Deployer wallet : $WALLET_PUBKEY"
echo "Team wallet     : $TEAM_WALLET"
echo "RPC             : $RPC"
echo "Program ID      : $PROGRAM_ID"
echo "Binary sha256   : $BINARY_SHA"
echo "  ↳ MUST match the hash the auditor reproduced from 'anchor build --verifiable'."

# ─── Cluster verification: refuse to run off-mainnet ──────────────────────────
section "Cluster verification"
GENESIS=$(solana genesis-hash --url "$RPC")
echo "Genesis hash    : $GENESIS"
if [[ "$GENESIS" != "$MAINNET_GENESIS" ]]; then
  echo "ERROR: RPC genesis hash != mainnet-beta ($MAINNET_GENESIS)."
  echo "       Refusing to run a mainnet launch against a non-mainnet cluster."
  exit 1
fi
echo "✓ Confirmed mainnet-beta."

# ─── Deployer guards ──────────────────────────────────────────────────────────
DEVNET_WALLET="$HOME/.config/solana/devnet-wallet.json"
if [[ -f "$DEVNET_WALLET" ]]; then
  DEVNET_PUBKEY=$(solana-keygen pubkey "$DEVNET_WALLET" 2>/dev/null || echo "")
  if [[ -n "$DEVNET_PUBKEY" && "$DEVNET_PUBKEY" == "$WALLET_PUBKEY" ]]; then
    echo "ERROR: deployer is your DEVNET wallet. Mainnet must use a fresh keypair (§3)."
    exit 1
  fi
fi

BALANCE_SOL=$(solana balance "$WALLET" --url "$RPC" 2>/dev/null | awk '{print $1}')
echo "Balance         : $BALANCE_SOL SOL"
if (( $(echo "$BALANCE_SOL < $MIN_SOL_REQUIRED" | bc -l) )); then
  echo "ERROR: need at least $MIN_SOL_REQUIRED SOL, have $BALANCE_SOL"
  exit 1
fi

confirm "LAUNCH ON MAINNET-BETA with real SOL — program $PROGRAM_ID, deployer $WALLET_PUBKEY. Proceed?"

# ─── 1. Deploy program ────────────────────────────────────────────────────────
section "1. Deploy program"
PROGRAM_ON_CHAIN=$(curl -s -X POST "$RPC" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$PROGRAM_ID\",{\"encoding\":\"base64\"}]}" \
  | python3 -c "import sys,json; print('YES' if json.load(sys.stdin)['result']['value'] else 'NO')")
if [[ "$PROGRAM_ON_CHAIN" == "YES" ]]; then
  echo "Program already deployed at $PROGRAM_ID — skipping deploy."
else
  confirm "Deploy the binary above (sha256 $BINARY_SHA) to mainnet now? Irreversible; spends ~$MIN_SOL_REQUIRED SOL of rent."
  solana program deploy "$PROGRAM_BINARY" \
    --url "$RPC" \
    --keypair "$WALLET" \
    --program-id "$PROGRAM_KEYPAIR"
fi

# ─── 2. Initialize (mints NOTHING) ────────────────────────────────────────────
section "2. Initialize program + stake pool + bond vault (initialize_program.ts — no mint)"
confirm "Run the initialize sequence on mainnet? (GlobalState + mint + stake pool + bond vault; mints nothing)"
ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" \
  npx ts-node -P tsconfig.json scripts/initialize_program.ts

# ─── 3. Team vesting (reserve 100M against the cap) ───────────────────────────
section "3. Initialize team vesting — reserve 100M for $TEAM_WALLET"
confirm "Reserve 100M TERM for the team wallet $TEAM_WALLET?"
ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" \
  npx ts-node -P tsconfig.json scripts/initialize_vesting.ts --team-wallet "$TEAM_WALLET"

# ─── 4. Rate limit ────────────────────────────────────────────────────────────
section "4. Set per-wallet rate limit to ${RATE_LIMIT_SECONDS}s"
ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" \
  npx ts-node -P tsconfig.json scripts/set_rate_limit.ts "$RATE_LIMIT_SECONDS"

# ─── 5. Token metadata ────────────────────────────────────────────────────────
section "5. Token metadata"
if [[ -n "$METADATA_URI" ]]; then
  confirm "Attach Metaplex metadata from $METADATA_URI ?"
  # Direct call (NOT 'yarn metadata' — that script hardcodes localhost/devnet env).
  ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" \
    npx ts-node -P tsconfig.json scripts/create_metadata.ts --uri "$METADATA_URI"
else
  echo "METADATA_URI not set — skipping. Upload the Metaplex JSON to Arweave (§4), then run:"
  echo "  ANCHOR_PROVIDER_URL=$RPC ANCHOR_WALLET=$WALLET npx ts-node -P tsconfig.json scripts/create_metadata.ts --uri <ARWEAVE_URL>"
fi

# ─── Summary + manual next steps ──────────────────────────────────────────────
section "On-chain launch sequence complete"
echo "Mainnet RPC     : $RPC"
echo "Program ID      : $PROGRAM_ID"
echo "Deployer        : $WALLET_PUBKEY"
echo "Team wallet     : $TEAM_WALLET"
echo "Rate limit      : ${RATE_LIMIT_SECONDS}s per wallet"
echo "Explorer        : https://explorer.solana.com/address/$PROGRAM_ID"
echo ""
echo "⚠ NOT done by this script — execute deliberately (MAINNET_CHECKLIST):"
echo "  §1  Transfer UPGRADE authority to the Squads 2-of-3 multisig (hardware wallets):"
echo "        solana program set-upgrade-authority $PROGRAM_ID \\"
echo "          --new-upgrade-authority <SQUADS_VAULT> --upgrade-authority $WALLET --url $RPC"
echo "  §2  Transfer program authority to the same vault (propose_authority / accept_authority),"
echo "      then plan the freeze-authority sunset (disable_freeze_authority, >=30 days in)."
echo "  §4  Token metadata on Arweave (if you skipped step 5)."
echo "  Liquidity: seed Raydium CPMM (5 SOL + 5M TERM) and burn the LP — atomically with mining open."
echo "  UI: set VITE_RPC_URL (build env) and RPC_URL (functions) to mainnet on Vercel, then redeploy."
echo ""
echo "Verify before announcing (§9):"
echo "  solana program show $PROGRAM_ID --url $RPC          # upgrade authority == vault"
echo "  • init-tx logs read 'Burn 0.25-5pct | Treasury 3pct'  (corrected economics)"
echo "  • a sanity claim from a FRESH wallet works end-to-end"
