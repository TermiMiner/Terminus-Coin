// Tip math — mirrors the on-chain emission/burn split in
// programs/terminuscoin/src/lib.rs so the UI can bound relayer-tip presets to
// what a claim can actually pay. The program enforces `tip <= net_reward`
// (lib.rs:261) and `tip <= MAX_TIP_TERM` (5 TERM). A tip is chosen BEFORE the
// nonce is found, and the lucky-block multiplier only ever RAISES the reward,
// so the safe ceiling for a pre-committed tip is the minimum (bonus_bits = 0)
// net reward of the CURRENT epoch. These constants are not exposed through the
// IDL — keep them in sync with lib.rs.

// raw TERM units (6 decimals) throughout.
const INITIAL_BASE_REWARD = 3_400_000n;        // lib.rs:27  (3.4 TERM @ epoch 0)
const EPOCH_SECONDS       = 5n * 31_557_600n;  // lib.rs:29  (5 × 365.25-day years)
const MAX_EPOCHS          = 10n;               // lib.rs:30
const BURN_BPS_MIN        = 25n;               // lib.rs:58
const BURN_BPS_MAX        = 500n;              // lib.rs:59
const BURN_DIFF_BITS_LOW  = 8n;                // lib.rs:60
const BURN_DIFF_BITS_HIGH = 24n;               // lib.rs:61
const TREASURY_BPS        = 300n;              // lib.rs:62
const BPS_DENOM           = 10_000n;           // lib.rs:63

export const MAX_TIP_TERM = 5_000_000n;        // lib.rs MAX_TIP_TERM (5 TERM)

// floor(log2(x)) for x >= 1 — mirrors `63 - u64::leading_zeros()` in lib.rs.
function log2Floor(x: bigint): bigint {
  let bits = 0n;
  while (x > 1n) { x >>= 1n; bits++; }
  return bits;
}

// Mirror of burn_bps_for() (lib.rs:969): linear in log2(difficulty) between
// BURN_DIFF_BITS_LOW/HIGH, clamped to [BURN_BPS_MIN, BURN_BPS_MAX].
function burnBpsFor(difficulty: bigint): bigint {
  const bits = difficulty <= 0n ? 0n : log2Floor(difficulty);
  if (bits <= BURN_DIFF_BITS_LOW) return BURN_BPS_MIN;
  if (bits >= BURN_DIFF_BITS_HIGH) return BURN_BPS_MAX;
  const progress = bits - BURN_DIFF_BITS_LOW;
  const span = BURN_DIFF_BITS_HIGH - BURN_DIFF_BITS_LOW;
  return BURN_BPS_MIN + (BURN_BPS_MAX - BURN_BPS_MIN) * progress / span;
}

// Gross base reward (bonus_bits = 0) for the current epoch — INITIAL_BASE_REWARD
// halved per 5-yr epoch, clamped to MAX_EPOCHS. Mirrors lib.rs emission. The
// lucky multiplier (2^bonus_bits) scales this; callers shift left by the bits.
export function baseRewardForEpoch(launchTime: bigint, nowSec: bigint): bigint {
  const elapsed = nowSec > launchTime ? nowSec - launchTime : 0n;
  let epoch = elapsed / EPOCH_SECONDS;
  if (epoch > MAX_EPOCHS - 1n) epoch = MAX_EPOCHS - 1n;
  return INITIAL_BASE_REWARD >> epoch;
}

// Minimum net reward (bonus_bits = 0) a claim pays out in the current epoch,
// raw TERM units. Mirrors the emission schedule + reward split (lib.rs:240-256).
export function minNetReward(launchTime: bigint, difficulty: bigint, nowSec: bigint): bigint {
  const baseReward = baseRewardForEpoch(launchTime, nowSec);  // bonus_bits = 0
  const burn = baseReward * burnBpsFor(difficulty) / BPS_DENOM;
  const treasury = baseReward * TREASURY_BPS / BPS_DENOM;
  const net = baseReward - burn - treasury;
  return net > 0n ? net : 0n;
}

// min(MAX_TIP_TERM, minNetReward) — the largest tip that both satisfies the
// protocol cap and clears `tip <= net_reward` on a base (worst-case) block.
export function tipCeiling(minNet: bigint): bigint {
  return minNet < MAX_TIP_TERM ? minNet : MAX_TIP_TERM;
}

export interface TipChoice { raw: number; label: string; }

const fmtTerm = (raw: number) => parseFloat((raw / 1_000_000).toFixed(3)).toString();

// Derive the relayer-tip preset ladder. `floorRaw` is the relayer's advertised
// floor (0 = none); `tipCeilRaw` = tipCeiling(minNetReward). Rules:
//   - floor > 0: ladder = floor / 2x / 4x, dropping any rung above the ceiling.
//     OFF is not offered (repeat claims must meet the floor). If even the floor
//     exceeds the ceiling it is still shown, flagged infeasible (clears only on
//     lucky/bonus blocks, where net reward is higher).
//   - floor == 0: absolute fallback OFF / 0.5 / 1 / 2, each dropped above ceiling.
export function deriveTipChoices(floorRaw: number, tipCeilRaw: number): {
  choices: TipChoice[];
  floorInfeasible: boolean;
} {
  if (floorRaw > 0) {
    const floorInfeasible = floorRaw > tipCeilRaw;
    const rungs = floorInfeasible
      ? [floorRaw]
      : [floorRaw, floorRaw * 2, floorRaw * 4].filter((r) => r <= tipCeilRaw);
    const uniq = Array.from(new Set(rungs.length ? rungs : [floorRaw]));
    return { choices: uniq.map((raw) => ({ raw, label: fmtTerm(raw) })), floorInfeasible };
  }
  const rungs = [0, 500_000, 1_000_000, 2_000_000].filter((r) => r === 0 || r <= tipCeilRaw);
  return {
    choices: rungs.map((raw) => ({ raw, label: raw === 0 ? "off" : fmtTerm(raw) })),
    floorInfeasible: false,
  };
}
