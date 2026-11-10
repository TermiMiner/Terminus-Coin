// Property tests for the program's pure arithmetic.
//
// The TypeScript suite in `tests/` checks these helpers against JavaScript
// re-implementations of the same formulas. A mirror shares its author's mental
// model: if the model is wrong, both sides agree and the test passes. These
// tests state what each helper must guarantee instead — an independent
// definition, a conservation law, a bound — and check it over randomized and
// boundary inputs.
//
// Run with `cargo test -p terminuscoin`. They run on the host, and are compiled
// only under `cfg(test)`: this file is pulled into `src/lib.rs` with `include!`
// and is not part of the deployed program.
//
// It lives here, beside the TypeScript suite, and not in the program's own
// directory, on purpose. Sec3 X-Ray reads every `.rs` file anywhere under
// `programs/terminuscoin/` with its own Rust grammar, which cannot parse this
// file and aborts the whole scan. `cargo fmt` does not follow `include!`
// either; CI runs rustfmt on this file by name.
//
// No test dependencies on purpose: inputs come from a small deterministic
// generator below, so `Cargo.toml` and `Cargo.lock` are untouched and a
// failure reproduces exactly from the seed in the test.

use super::*;

// ─── Input generation ────────────────────────────────────────────────────────

/// SplitMix64. Deterministic and tiny; more than enough to drive test inputs.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[lo, hi]`. Modulo bias is irrelevant for test inputs.
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        debug_assert!(lo <= hi);
        let span = hi - lo;
        if span == u64::MAX {
            self.next_u64()
        } else {
            lo + self.next_u64() % (span + 1)
        }
    }

    /// A u64 biased toward the places arithmetic bugs live: zero, the maximum,
    /// powers of two and their neighbours. Roughly half the draws are uniform.
    fn edgy(&mut self) -> u64 {
        match self.next_u64() % 8 {
            0 => self.range(0, 3),
            1 => u64::MAX - self.range(0, 3),
            2 => 1u64 << self.range(0, 63),
            3 => (1u64 << self.range(1, 63)).wrapping_sub(1),
            4 => (1u64 << self.range(0, 62)) + 1,
            _ => self.next_u64(),
        }
    }

    /// Like `edgy`, but confined to `[lo, hi]`.
    fn edgy_in(&mut self, lo: u64, hi: u64) -> u64 {
        match self.next_u64() % 6 {
            0 => lo,
            1 => hi,
            2 => lo.saturating_add(self.range(0, 2)).min(hi),
            3 => hi.saturating_sub(self.range(0, 2)).max(lo),
            _ => self.range(lo, hi),
        }
    }

    /// A difficulty the protocol can actually be at.
    fn difficulty(&mut self) -> u64 {
        self.edgy_in(MIN_DIFFICULTY, MAX_DIFFICULTY)
    }
}

/// A 32-byte hash whose leading eight bytes, read big-endian, equal `high`.
/// The remaining bytes are filled from `rng`; no helper may depend on them.
fn hash_with_high(high: u64, rng: &mut Rng) -> [u8; 32] {
    let mut hash = [0u8; 32];
    hash[..8].copy_from_slice(&high.to_be_bytes());
    for chunk in hash[8..].chunks_mut(8) {
        chunk.copy_from_slice(&rng.next_u64().to_le_bytes());
    }
    hash
}

const CASES: usize = 50_000;
const YEAR: i64 = 31_557_600;

// ─── meets_difficulty ────────────────────────────────────────────────────────

/// The definition, stated without division: a hash is valid when
/// `hash_high × difficulty` does not exceed `u64::MAX`.
fn valid_by_definition(high: u64, difficulty: u64) -> bool {
    difficulty <= 1 || (high as u128) * (difficulty as u128) <= u64::MAX as u128
}

#[test]
fn meets_difficulty_matches_its_definition() {
    let mut rng = Rng(1);
    for _ in 0..CASES {
        let (high, difficulty) = (rng.edgy(), rng.edgy());
        assert_eq!(
            meets_difficulty(&hash_with_high(high, &mut rng), difficulty),
            valid_by_definition(high, difficulty),
            "high={high} difficulty={difficulty}"
        );
    }
}

#[test]
fn meets_difficulty_accepts_exactly_the_hashes_below_its_threshold() {
    // For each difficulty the accepted set is [0, threshold]: the threshold is
    // accepted, its successor is not, and acceptance is monotone in the hash.
    // The accepted fraction is then within one part in 2^24 of 1/difficulty
    // across the protocol's whole range.
    let mut rng = Rng(2);
    for _ in 0..CASES {
        let difficulty = rng.difficulty();
        let threshold = u64::MAX / difficulty;
        assert!(meets_difficulty(
            &hash_with_high(threshold, &mut rng),
            difficulty
        ));
        assert!(!meets_difficulty(
            &hash_with_high(threshold + 1, &mut rng),
            difficulty
        ));

        let (a, b) = (rng.edgy(), rng.edgy());
        let (low, high) = (a.min(b), a.max(b));
        if meets_difficulty(&hash_with_high(high, &mut rng), difficulty) {
            assert!(meets_difficulty(&hash_with_high(low, &mut rng), difficulty));
        }

        // accepted × difficulty lands in [2^64, 2^64 + difficulty).
        let accepted = threshold as u128 + 1;
        let excess = accepted * difficulty as u128 - (1u128 << 64);
        assert!(excess < difficulty as u128, "difficulty={difficulty}");
    }
}

#[test]
fn meets_difficulty_reads_the_first_eight_bytes_big_endian() {
    // 0x01 in the most significant byte is 2^56: valid up to difficulty 255,
    // invalid from 256. A little-endian or wrong-offset read would not agree.
    let mut hash = [0u8; 32];
    hash[0] = 0x01;
    assert!(meets_difficulty(&hash, 255));
    assert!(!meets_difficulty(&hash, 256));

    // Bytes 8..32 never matter.
    let mut noisy = [0xFFu8; 32];
    noisy[..8].copy_from_slice(&hash[..8]);
    assert!(meets_difficulty(&noisy, 255));
    assert!(!meets_difficulty(&noisy, 256));
}

// ─── lucky_reward ────────────────────────────────────────────────────────────

/// Bonus bits, stated without division or logarithms: the largest `k` up to
/// the cap for which the hash would still be valid at `difficulty × 2^k`.
fn bonus_by_definition(high: u64, difficulty: u64) -> u32 {
    let product = (high as u128) * (difficulty as u128);
    (0..=BONUS_CAP)
        .rev()
        .find(|k| product <= (u64::MAX >> k) as u128)
        .unwrap_or(0)
}

#[test]
fn lucky_reward_matches_its_definition() {
    let mut rng = Rng(3);
    for _ in 0..CASES {
        let (base, high, difficulty) = (rng.edgy(), rng.edgy(), rng.edgy());
        let hash = hash_with_high(high, &mut rng);
        let expected = if base == 0 || !valid_by_definition(high, difficulty) || difficulty <= 1 {
            (base, 0)
        } else {
            let bits = bonus_by_definition(high, difficulty);
            (base.saturating_mul(1u64 << bits), bits)
        };
        assert_eq!(
            lucky_reward(base, &hash, difficulty),
            expected,
            "base={base} high={high} difficulty={difficulty}"
        );
    }
}

#[test]
fn lucky_reward_pays_no_bonus_without_valid_proof_of_work() {
    let mut rng = Rng(4);
    for _ in 0..CASES {
        let (base, high, difficulty) = (rng.edgy(), rng.edgy(), rng.difficulty());
        let hash = hash_with_high(high, &mut rng);
        let (reward, bits) = lucky_reward(base, &hash, difficulty);
        assert!(bits <= BONUS_CAP);
        assert!(reward >= base);
        if !meets_difficulty(&hash, difficulty) {
            assert_eq!((reward, bits), (base, 0));
        }
    }
}

#[test]
fn lucky_reward_is_an_exact_power_of_two_multiple_at_every_epoch() {
    // At every base the emission schedule can produce, the payout is exactly
    // base × 2^bits, never saturates, and tops out at 256 × base.
    let mut rng = Rng(5);
    for epoch in 0..MAX_EPOCHS {
        let base = INITIAL_BASE_REWARD >> epoch;
        assert!(base > 0, "epoch {epoch} would mine nothing");
        for _ in 0..CASES / MAX_EPOCHS as usize {
            let difficulty = rng.difficulty();
            let high = rng.edgy_in(0, u64::MAX / difficulty);
            let (reward, bits) = lucky_reward(base, &hash_with_high(high, &mut rng), difficulty);
            assert_eq!(reward, base << bits);
            assert!(reward <= base * 256);
        }
    }
}

#[test]
fn lucky_reward_never_shrinks_as_the_hash_gets_luckier() {
    let mut rng = Rng(6);
    for _ in 0..CASES {
        let difficulty = rng.difficulty();
        let threshold = u64::MAX / difficulty;
        let (a, b) = (rng.edgy_in(0, threshold), rng.edgy_in(0, threshold));
        let (luckier, unluckier) = (a.min(b), a.max(b));
        let (_, more) = lucky_reward(1, &hash_with_high(luckier, &mut rng), difficulty);
        let (_, less) = lucky_reward(1, &hash_with_high(unluckier, &mut rng), difficulty);
        assert!(
            more >= less,
            "difficulty={difficulty} {luckier}->{more} {unluckier}->{less}"
        );
    }
}

#[test]
fn expected_lucky_multiplier_is_five() {
    // The emission schedule (README: 17 TERM expected per claim at epoch 0,
    // ~894M over 50 years) rests on the multiplier averaging 5× over valid
    // hashes. Count the hashes at each bonus level exactly — pinning each
    // level's boundary to the function itself — and check the mean.
    let mut rng = Rng(7);
    for _ in 0..2_000 {
        let difficulty = rng.difficulty();
        // count[k] = number of hashes earning at least k bonus bits.
        let mut count = [0u128; BONUS_CAP as usize + 1];
        for k in 0..=BONUS_CAP {
            let boundary = (u64::MAX >> k) / difficulty;
            let (_, at) = lucky_reward(1, &hash_with_high(boundary, &mut rng), difficulty);
            let (_, past) = lucky_reward(1, &hash_with_high(boundary + 1, &mut rng), difficulty);
            assert!(at >= k, "difficulty={difficulty} k={k}");
            assert!(
                past < k || k == 0,
                "difficulty={difficulty} k={k} boundary+1 still earns {past}"
            );
            count[k as usize] = boundary as u128 + 1;
        }
        // Σ multiplier over all valid hashes.
        let mut total = (1u128 << BONUS_CAP) * count[BONUS_CAP as usize];
        for k in 0..BONUS_CAP as usize {
            total += (1u128 << k) * (count[k] - count[k + 1]);
        }
        let valid = count[0];
        assert!(
            4_999 * valid <= 1_000 * total && 1_000 * total <= 5_001 * valid,
            "difficulty={difficulty} mean multiplier = {total}/{valid}"
        );
    }
}

// ─── burn_bps_for ────────────────────────────────────────────────────────────

#[test]
fn burn_rate_is_bounded_and_never_falls_as_difficulty_rises() {
    let mut rng = Rng(8);
    for _ in 0..CASES {
        let (a, b) = (rng.edgy(), rng.edgy());
        let (lower, higher) = (a.min(b), a.max(b));
        let (cool, hot) = (burn_bps_for(lower), burn_bps_for(higher));
        assert!((BURN_BPS_MIN..=BURN_BPS_MAX).contains(&cool));
        assert!((BURN_BPS_MIN..=BURN_BPS_MAX).contains(&hot));
        assert!(cool <= hot, "burn({lower})={cool} > burn({higher})={hot}");
    }
}

#[test]
fn burn_rate_depends_only_on_the_bit_length_of_difficulty() {
    let mut rng = Rng(9);
    for bits in 0..64u32 {
        let floor = 1u64 << bits;
        let ceiling = floor | (floor - 1);
        for _ in 0..200 {
            let difficulty = rng.edgy_in(floor, ceiling);
            assert_eq!(burn_bps_for(difficulty), burn_bps_for(floor));
        }
    }
}

#[test]
fn burn_rate_climbs_in_even_steps_between_its_bands() {
    // Flat at the minimum through 8 bits, flat at the maximum from 24 bits,
    // and in between each extra bit of difficulty adds the same amount, give
    // or take the rounding: 475 bps over 16 steps is 29 or 30 a step.
    for bits in 0..BURN_DIFF_BITS_LOW {
        assert_eq!(burn_bps_for(1 << bits), BURN_BPS_MIN, "{bits} bits");
    }
    for bits in BURN_DIFF_BITS_LOW..BURN_DIFF_BITS_HIGH {
        let step = burn_bps_for(1 << (bits + 1)) - burn_bps_for(1 << bits);
        assert!(
            step == 29 || step == 30,
            "{bits} -> {} bits: +{step}",
            bits + 1
        );
    }
    for bits in BURN_DIFF_BITS_HIGH..64 {
        assert_eq!(burn_bps_for(1 << bits), BURN_BPS_MAX, "{bits} bits");
    }
}

#[test]
fn burn_rate_matches_the_published_table() {
    // README "Dynamic burn" table, in basis points.
    assert_eq!(burn_bps_for(0), 25);
    assert_eq!(burn_bps_for(MIN_DIFFICULTY), 25);
    assert_eq!(burn_bps_for(256), 25); // ≤ 256      → 0.25%
    assert_eq!(burn_bps_for(INITIAL_DIFFICULTY), 143); // 4,096      → 1.4%
    assert_eq!(burn_bps_for(65_536), 262); // 65,536     → 2.6%
    assert_eq!(burn_bps_for(1_048_576), 381); // 1,048,576  → 3.8%
    assert_eq!(burn_bps_for(16_777_216), 500); // ≥ 2^24     → 5%
    assert_eq!(burn_bps_for(MAX_DIFFICULTY), 500);
    assert_eq!(burn_bps_for(u64::MAX), 500);
}

#[test]
fn burn_and_treasury_always_leave_the_miner_most_of_the_reward() {
    // The two deductions taken in `claim` total at most 8%, so net_reward is
    // positive at every epoch, bonus level and difficulty — which is what lets
    // `tip <= net_reward` bound the relayer tip by something real.
    const _: () = assert!(BURN_BPS_MAX + TREASURY_BPS <= 800);
    let mut rng = Rng(10);
    for epoch in 0..MAX_EPOCHS {
        for bits in 0..=BONUS_CAP {
            let reward = (INITIAL_BASE_REWARD >> epoch) << bits;
            for _ in 0..50 {
                let burn = reward * burn_bps_for(rng.difficulty()) / BPS_DENOM;
                let treasury = reward * TREASURY_BPS / BPS_DENOM;
                assert!(reward - burn - treasury >= reward / 100 * 92);
            }
        }
    }
}

// ─── tranche_vested ──────────────────────────────────────────────────────────

/// An elapsed time anywhere a clock could plausibly or implausibly be.
fn any_elapsed(rng: &mut Rng) -> i64 {
    match rng.next_u64() % 6 {
        0 => i64::MIN + rng.range(0, 3) as i64,
        1 => i64::MAX - rng.range(0, 3) as i64,
        2 => -(rng.range(0, 20 * YEAR as u64) as i64),
        _ => rng.range(0, 20 * YEAR as u64) as i64,
    }
}

#[test]
fn vesting_never_exceeds_its_tranche_and_never_moves_backwards() {
    let mut rng = Rng(11);
    for _ in 0..CASES {
        let i = rng.range(0, 3) as usize;
        let (a, b) = (any_elapsed(&mut rng), any_elapsed(&mut rng));
        let (earlier, later) = (a.min(b), a.max(b));
        let (before, after) = (tranche_vested(i, earlier), tranche_vested(i, later));
        assert!(
            before <= after,
            "tranche {i}: {earlier}s->{before} {later}s->{after}"
        );
        assert!(after <= TRANCHE_AMOUNTS[i]);
    }
}

#[test]
fn vesting_follows_the_published_schedule() {
    // Tranche 0: everything at launch, nothing before it.
    assert_eq!(tranche_vested(0, -1), 0);
    assert_eq!(tranche_vested(0, 0), 50_000_000_000_000);

    // Tranches 1–3: nothing until their year, then linear over one year.
    for (i, unlock_year) in [(1usize, 5i64), (2, 7), (3, 10)] {
        let unlock = unlock_year * YEAR;
        let total = TRANCHE_AMOUNTS[i];
        assert_eq!(tranche_vested(i, unlock - 1), 0);
        assert_eq!(tranche_vested(i, unlock), 0);
        assert_eq!(tranche_vested(i, unlock + YEAR / 2), total / 2);
        assert_eq!(
            tranche_vested(i, unlock + YEAR - 1),
            total - total.div_ceil(YEAR as u64)
        );
        assert_eq!(tranche_vested(i, unlock + YEAR), total);
        assert_eq!(tranche_vested(i, i64::MAX), total);
    }

    // Fully vested, the team holds exactly 100M TERM: 10% of the supply cap.
    let vested: u64 = (0..4).map(|i| tranche_vested(i, i64::MAX)).sum();
    assert_eq!(vested, 100_000_000_000_000);
    assert_eq!(vested, SUPPLY_CAP / 10);
}

#[test]
fn vesting_is_linear_inside_its_window() {
    // A linear schedule rounded down is superadditive by at most one unit:
    // vested(a) + vested(b) ≤ vested(a + b) ≤ vested(a) + vested(b) + 1.
    let mut rng = Rng(12);
    for _ in 0..CASES {
        let i = rng.range(1, 3) as usize;
        let unlock = TRANCHE_UNLOCK_SECONDS[i];
        let period = TRANCHE_LINEAR_PERIODS[i] as u64;
        let a = rng.edgy_in(0, period);
        let b = rng.edgy_in(0, period - a);
        let at = |s: u64| tranche_vested(i, unlock + s as i64);
        let (parts, whole) = (at(a) + at(b), at(a + b));
        assert!(
            parts <= whole && whole <= parts + 1,
            "tranche {i}: a={a} b={b}"
        );
    }
}

// ─── pending_yield ───────────────────────────────────────────────────────────

/// `floor(delta × amount / YIELD_PRECISION)` by a different route than the
/// program's single multiply: split `delta` into quotient and remainder first.
/// Returns `None` only when the true value does not fit in a u128.
fn exact_yield(delta: u128, amount: u64) -> Option<u128> {
    let amount = amount as u128;
    let (quotient, remainder) = (delta / YIELD_PRECISION, delta % YIELD_PRECISION);
    // remainder < 1e12 and amount < 2^64, so this product cannot overflow.
    quotient
        .checked_mul(amount)?
        .checked_add(remainder * amount / YIELD_PRECISION)
}

/// Everything a staker can be owed is bounded by what `claim` ever credits to
/// the treasury, and every credit is reserved against the supply cap. So over
/// one accrual interval `(rps − debt) × amount ≤ SUPPLY_CAP × YIELD_PRECISION`.
const REACHABLE_PRODUCT: u128 = SUPPLY_CAP as u128 * YIELD_PRECISION;

#[test]
fn pending_yield_is_exact_wherever_the_program_can_reach() {
    let mut rng = Rng(13);
    for _ in 0..CASES {
        let amount = rng.edgy_in(0, SUPPLY_CAP);
        let max_delta = REACHABLE_PRODUCT / (amount.max(1) as u128);
        let delta = wide_edgy_in(&mut rng, max_delta);
        let debt = wide_edgy_in(&mut rng, REACHABLE_PRODUCT);
        let owed = pending_yield(debt + delta, debt, amount);
        assert_eq!(
            Some(owed as u128),
            exact_yield(delta, amount),
            "delta={delta} amount={amount}"
        );
        assert!(owed <= SUPPLY_CAP);
    }
}

#[test]
fn pending_yield_never_overpays_on_any_input() {
    // Over the entire input space — far beyond anything reachable — the result
    // never exceeds the exact entitlement. The saturating multiply and the
    // truncating cast can only ever round a staker's yield down.
    let mut rng = Rng(14);
    for _ in 0..CASES {
        let (stored, debt) = (wide_edgy(&mut rng), wide_edgy(&mut rng));
        let amount = rng.edgy();
        let owed = pending_yield(stored, debt, amount) as u128;
        // `None` means the true value exceeds u128, so any u64 is below it.
        if let Some(exact) = exact_yield(stored.saturating_sub(debt), amount) {
            assert!(owed <= exact, "stored={stored} debt={debt} amount={amount}");
        }
        if stored <= debt || amount == 0 {
            assert_eq!(owed, 0);
        }
    }
}

#[test]
fn pending_yield_truncation_is_far_outside_the_reachable_range() {
    // The `as u64` cast drops high bits once the exact value reaches 2^64,
    // which needs (rps − debt) × amount ≥ 2^64 × YIELD_PRECISION. The supply
    // cap keeps the program more than 18,000× below that.
    const WRAPS_FROM: u128 = (1u128 << 64) * YIELD_PRECISION;
    const _: () = assert!(WRAPS_FROM / REACHABLE_PRODUCT >= 18_000);

    // Just inside the limit the result is still exact …
    assert_eq!(
        pending_yield(WRAPS_FROM - 1, 0, 1) as u128,
        exact_yield(WRAPS_FROM - 1, 1).unwrap()
    );
    // … and at the limit the staker is underpaid, never overpaid. Written as an
    // inequality so it keeps holding if the cast is later made to saturate.
    assert!((pending_yield(WRAPS_FROM, 0, 1) as u128) < exact_yield(WRAPS_FROM, 1).unwrap());
}

fn wide_edgy(rng: &mut Rng) -> u128 {
    match rng.next_u64() % 4 {
        0 => rng.edgy() as u128,
        1 => u128::MAX - rng.edgy() as u128,
        2 => (rng.edgy() as u128) << 64,
        _ => ((rng.next_u64() as u128) << 64) | rng.next_u64() as u128,
    }
}

fn wide_edgy_in(rng: &mut Rng, max: u128) -> u128 {
    match rng.next_u64() % 5 {
        0 => 0,
        1 => max,
        2 => max - (rng.range(0, 2) as u128).min(max),
        _ if max == u128::MAX => wide_edgy(rng),
        _ => wide_edgy(rng) % (max + 1),
    }
}

// ─── Staking pool model ──────────────────────────────────────────────────────
//
// `claim_yield` mints, and `set_paused` does not stop it, so its accounting has
// to be right on its own. The handlers are not pure functions, so this drives a
// hand-kept copy of their bookkeeping — the same lines as `claim`'s treasury
// credit, `stake`, `unstake` and `claim_yield`, calling the real
// `pending_yield` — through random histories and checks the laws that keep the
// pool solvent. Keep it in step with the handlers if they change.

#[derive(Default)]
struct Pool {
    total_staked: u64,
    reward_per_token_stored: u128,
    treasury_balance: u64,
}

#[derive(Default)]
struct Staker {
    wallet: u64,
    amount: u64,
    reward_debt: u128,
    pending_yield: u64,
}

impl Pool {
    /// `claim`: credit the treasury share of one mined block.
    fn credit(&mut self, treasury_total: u64) -> bool {
        if self.total_staked == 0 {
            return false;
        }
        self.treasury_balance = self.treasury_balance.saturating_add(treasury_total);
        let delta = (treasury_total as u128)
            .saturating_mul(YIELD_PRECISION)
            .saturating_div(self.total_staked as u128);
        self.reward_per_token_stored = self.reward_per_token_stored.saturating_add(delta);
        true
    }

    fn settle(&self, staker: &mut Staker) {
        let pending = pending_yield(
            self.reward_per_token_stored,
            staker.reward_debt,
            staker.amount,
        );
        staker.pending_yield = staker.pending_yield.saturating_add(pending);
    }

    /// `stake`
    fn stake(&mut self, staker: &mut Staker, amount: u64) {
        self.settle(staker);
        staker.wallet -= amount;
        self.total_staked = self.total_staked.saturating_add(amount);
        staker.amount = staker.amount.saturating_add(amount);
        staker.reward_debt = self.reward_per_token_stored;
    }

    /// `unstake`
    fn unstake(&mut self, staker: &mut Staker, amount: u64) {
        self.settle(staker);
        staker.wallet += amount;
        self.total_staked = self.total_staked.saturating_sub(amount);
        staker.amount = staker.amount.saturating_sub(amount);
        staker.reward_debt = self.reward_per_token_stored;
    }

    /// `claim_yield`: returns the amount minted, or `None` where the handler
    /// would reject with InsufficientTreasury.
    fn claim_yield(&mut self, staker: &mut Staker) -> Option<u64> {
        let accrued = pending_yield(
            self.reward_per_token_stored,
            staker.reward_debt,
            staker.amount,
        );
        let total = staker.pending_yield.saturating_add(accrued);
        if total == 0 {
            return Some(0); // NoYieldAvailable: nothing minted
        }
        if self.treasury_balance < total {
            return None;
        }
        self.treasury_balance -= total;
        staker.pending_yield = 0;
        staker.reward_debt = self.reward_per_token_stored;
        staker.wallet += total;
        Some(total)
    }

    fn owed(&self, staker: &Staker) -> u128 {
        staker.pending_yield as u128
            + pending_yield(
                self.reward_per_token_stored,
                staker.reward_debt,
                staker.amount,
            ) as u128
    }
}

/// The treasury share `claim` credits for one block: 3% of the lucky reward
/// plus the fixed fee, at a random epoch and bonus level.
fn treasury_credit(rng: &mut Rng) -> u64 {
    let epoch = rng.range(0, MAX_EPOCHS as u64 - 1);
    let bits = rng.range(0, BONUS_CAP as u64);
    let reward = (INITIAL_BASE_REWARD >> epoch) << bits;
    reward * TREASURY_BPS / BPS_DENOM + CLAIM_FEE
}

#[test]
fn staking_pool_stays_solvent_through_random_histories() {
    for seed in 0..300u64 {
        let mut rng = Rng(1_000 + seed);
        let mut pool = Pool::default();

        // Wallets that together hold no more than the supply cap. Some
        // histories pit one-unit dust stakers against whales, which is where
        // reward_per_token_stored grows fastest.
        let mut stakers: Vec<Staker> = (0..rng.range(2, 6))
            .map(|_| Staker {
                wallet: match rng.next_u64() % 3 {
                    0 => rng.range(1, 10),
                    1 => rng.range(1, SUPPLY_CAP / 8),
                    _ => rng.range(1, 1_000_000_000),
                },
                ..Staker::default()
            })
            .collect();

        let (mut credited, mut paid) = (0u128, 0u128);
        let (mut credits, mut settlements) = (0u128, 0u128);
        let mut peak_staked = 0u64;

        for step in 0..600 {
            let who = rng.range(0, stakers.len() as u64 - 1) as usize;
            match rng.next_u64() % 10 {
                0..=4 => {
                    // One block's credit — or, one time in eight, a burst
                    // standing for a long run of blocks, which is what pushes
                    // reward_per_token_stored toward its supply-cap bound.
                    let room = (SUPPLY_CAP as u128 - credited) as u64;
                    let amount = if room > 0 && rng.next_u64() % 8 == 0 {
                        rng.edgy_in(1, room)
                    } else {
                        treasury_credit(&mut rng)
                    };
                    if credited + amount as u128 <= SUPPLY_CAP as u128 && pool.credit(amount) {
                        credited += amount as u128;
                        credits += 1;
                    }
                }
                5 | 6 if stakers[who].wallet > 0 => {
                    let amount = rng.edgy_in(1, stakers[who].wallet);
                    pool.stake(&mut stakers[who], amount);
                    settlements += 1;
                }
                7 if stakers[who].amount > 0 => {
                    let amount = rng.edgy_in(1, stakers[who].amount);
                    pool.unstake(&mut stakers[who], amount);
                    settlements += 1;
                }
                _ => {
                    let minted = pool
                        .claim_yield(&mut stakers[who])
                        .unwrap_or_else(|| panic!("seed {seed} step {step}: InsufficientTreasury"));
                    paid += minted as u128;
                    settlements += 1;
                }
            }
            peak_staked = peak_staked.max(pool.total_staked);

            // The pool's total is the sum of its positions.
            let staked: u128 = stakers.iter().map(|s| s.amount as u128).sum();
            assert_eq!(pool.total_staked as u128, staked, "seed {seed} step {step}");

            // Nothing is created or lost: every unit credited is either paid
            // out or still held by the treasury.
            assert_eq!(
                credited,
                paid + pool.treasury_balance as u128,
                "seed {seed} step {step}"
            );

            // Solvency: the treasury covers everything stakers are owed, so
            // claim_yield can never mint more than claim reserved.
            let owed: u128 = stakers.iter().map(|s| pool.owed(s)).sum();
            assert!(
                owed <= pool.treasury_balance as u128,
                "seed {seed} step {step}: owed {owed} > treasury {}",
                pool.treasury_balance
            );

            // And stakers are not short-changed beyond rounding: each credit
            // loses under one unit of reward-per-token across the pool, each
            // settlement under one token.
            let dust_bound = credits * (peak_staked as u128 / YIELD_PRECISION + 1)
                + settlements
                + stakers.len() as u128;
            assert!(
                pool.treasury_balance as u128 - owed <= dust_bound,
                "seed {seed} step {step}: {} undistributed, bound {dust_bound}",
                pool.treasury_balance as u128 - owed
            );
        }
    }
}
