use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use mpl_token_metadata::{
    instructions::CreateMetadataAccountV3CpiBuilder,
    types::DataV2,
};
use solana_keccak_hasher as keccak;

declare_id!("FfA5srQxRjZtTpZ1qq2Rivkp6PaRRii3R9712onMJH5Y");

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPLY_CAP: u64 = 1_000_000_000_000_000;      // 1 B tokens × 10^6
// Lucky-block reward: a claim's payout is base × 2^bonus_bits where bonus_bits
// = floor(log2( (max_valid_hash) / hash_high )), capped at BONUS_CAP. The hash
// itself is the entropy source — no oracles, no extra accounts. EV per claim
// = (BONUS_CAP / 2 + 1) × base, so with cap=8 and base=3.4 TERM the expected
// emission per claim is 17 TERM at epoch 0 → ~894M total over 50 years
// (unchanged from the deterministic-reward design).
//
// Distribution per claim (epoch 0):
//   50%   → 3.4 TERM     (just barely valid)
//   25%   → 6.8 TERM
//   12.5% → 13.6 TERM
//   ...
//   0.39% → 870 TERM     (jackpot)
const INITIAL_BASE_REWARD: u64 = 3_400_000;          // 3.4 TERM base, 5x EV → 17 TERM expected/claim
const BONUS_CAP: u32 = 8;                            // max bonus bits → max payout = 256× base
const EPOCH_SECONDS: i64 = 5 * 31_557_600;           // 5 × 365.25-day years in seconds
const MAX_EPOCHS: u32 = 10;                           // 50-year programme (10 epochs × 5 yrs)

// ─── Team vesting tranches ────────────────────────────────────────────────────
// 4 discrete unlocks; total = 100M TERM (10% of supply cap).
// Tokens are reserved against total_minted at initialize_vesting time.
const TRANCHE_AMOUNTS: [u64; 4] = [
    50_000_000_000_000,  // 50M TERM =  5.0% — unlocks at launch
    25_000_000_000_000,  // 25M TERM =  2.5% — unlocks at year 5
    15_000_000_000_000,  // 15M TERM =  1.5% — unlocks at year 7
    10_000_000_000_000,  // 10M TERM =  1.0% — unlocks at year 10
];
const TRANCHE_UNLOCK_SECONDS: [i64; 4] = [
    0,                       // launch (cliff — fully claimable immediately)
    EPOCH_SECONDS,           // year 5  (start of linear vest)
    7 * 31_557_600,          // year 7  (start of linear vest)
    2 * EPOCH_SECONDS,       // year 10 (start of linear vest)
];
// Linear vesting period AFTER each tranche's unlock time. Tranche 0 has zero
// linear period (immediate cliff), the rest vest smoothly over 1 year to avoid
// market shock from sudden full-amount unlocks.
const TRANCHE_LINEAR_PERIODS: [i64; 4] = [
    0,                       // immediate
    31_557_600,              // 1 year linear after year 5
    31_557_600,              // 1 year linear after year 7
    31_557_600,              // 1 year linear after year 10
];
// Dynamic burn: scales with network heat. Anchored on log2(difficulty) so the
// curve responds smoothly to exponential difficulty growth. See burn_bps_for().
const BURN_BPS_MIN: u64 = 25;                         // 0.25% at low difficulty (network cold)
const BURN_BPS_MAX: u64 = 500;                        // 5%    at high difficulty (network hot)
const BURN_DIFF_BITS_LOW: u32 = 8;                    // diff = 256 → BURN_BPS_MIN
const BURN_DIFF_BITS_HIGH: u32 = 24;                  // diff = 16M → BURN_BPS_MAX
const TREASURY_BPS: u64 = 300;                        // 3%   — meaningful staker yield (was 0.5%)
const BPS_DENOM: u64 = 10_000;
const YIELD_PRECISION: u128 = 1_000_000_000_000;     // 1e12 fixed-point

// Fixed per-claim fee added to staking treasury when stakers exist.
// In late epochs when base_reward shrinks toward zero, this becomes the
// dominant treasury source — providing a perpetual security budget that
// doesn't depend on emissions.
const CLAIM_FEE: u64 = 10_000;                        // 0.01 TERM

// ─── Anti-Sybil bond ──────────────────────────────────────────────────────────
// Each miner must hold a per-wallet `BondAccount` PDA. Two payment options:
//
//   1. SOL bond (`deposit_bond`): the ~0.001 SOL of account rent IS the bond.
//      Universally available — no chicken-and-egg for first-time miners.
//
//   2. TERM bond (`deposit_bond_term`): 20 TERM transferred to the bond_term_vault
//      (~0.001 SOL of rent is unavoidable account overhead, but the *bond* is the
//      locked TERM). Endogenous skin-in-the-game for established miners; removes
//      TERM from circulation while held.
//
// Mutually exclusive — Anchor's `init` enforces one BondAccount per wallet.
// Both refundable via the corresponding `withdraw_bond[_term]` after cooldown.
const BOND_WITHDRAW_COOLDOWN: i64 = 3600;             // 1 hour after last claim
const TERM_BOND_AMOUNT: u64 = 20_000_000;             // 20 TERM (with 6 decimals)
const BOND_KIND_SOL: u8 = 0;
const BOND_KIND_TERM: u8 = 1;

// ─── Phase 2 activation ───────────────────────────────────────────────────────
// At year 1, the authority-set rate limit becomes redundant: the bond plus
// PoW already deter spam, and centralized rate limiting becomes a censorship
// vector. The rate-limit field stays in state for compatibility but is
// ignored once we cross this threshold.
const PHASE2_ACTIVATION_SECS: i64 = 31_557_600;       // 1 year

// ─── Difficulty adjustment ────────────────────────────────────────────────────
// Continuous target: a hash is valid if its first 8 bytes (interpreted as
// big-endian u64) are <= u64::MAX / difficulty. Probability ≈ 1/difficulty.
//
// Adjustment formula at each window trigger (Bitcoin-style):
//   factor = (claims_in_window * TARGET_WINDOW) / (TARGET_CLAIMS * actual_window)
//   new_difficulty = old * factor, clamped to [old/2, old*2] (max 2× per step)
//   then clamped to [MIN_DIFFICULTY, MAX_DIFFICULTY].
//
// Triggers:
//   • claims_in_window >= TARGET_CLAIMS (window filled)
//   • elapsed >= TARGET_WINDOW (window timed out)
const TARGET_WINDOW: i64 = 600;                           // 10 minutes
const TARGET_CLAIMS_PER_WINDOW: u64 = 100;
const MIN_DIFFICULTY: u64 = 16;                           // ~4 bits floor
const MAX_DIFFICULTY: u64 = 1_099_511_627_776;            // 2^40 ceiling
const INITIAL_DIFFICULTY: u64 = 4_096;                    // ~12 bits, matches old default

// ─── Program ─────────────────────────────────────────────────────────────────

#[program]
pub mod terminuscoin {
    use super::*;

    // ── initialize ────────────────────────────────────────────────────────────

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let s = &mut ctx.accounts.global_state;
        s.authority = ctx.accounts.authority.key();
        s.freeze_authority = ctx.accounts.authority.key();
        s.pending_authority = Pubkey::default();
        s.pending_freeze_authority = Pubkey::default();
        s.paused = false;
        s.difficulty = INITIAL_DIFFICULTY;
        s.launch_time = now;
        s.last_claim_window = now;
        s.total_claims = 0;
        s.claims_in_window = 0;
        s.total_minted = 0;
        s.rate_limit_seconds = 0;
        s.last_hash = keccak::hash(b"terminus-coin-genesis").0;

        msg!("=== TERMINUS COIN INITIALIZED ===");
        msg!("Hard cap : 1,000,000,000 TERM");
        msg!("Emission : 17 TERM/claim epoch 0, halving every 5 yrs, 50yr programme (~894M total mined)");
        msg!("Team     : 100M TERM (10%%) in 4 tranches over 10 years");
        msg!("Mechanism: PoW keccak256 | Burn 1pct | Treasury 3pct + 0.01 TERM/claim fee -> staking");
        msg!("Authority: {}", ctx.accounts.authority.key());
        msg!("Source code is public and verifiable on-chain.");
        Ok(())
    }

    // ── initialize_stake_pool ─────────────────────────────────────────────────

    pub fn initialize_stake_pool(ctx: Context<InitializeStakePool>) -> Result<()> {
        let pool = &mut ctx.accounts.stake_pool;
        pool.total_staked = 0;
        pool.reward_per_token_stored = 0;
        pool.treasury_balance = 0;
        msg!("Stake pool ready. Vault: {}", ctx.accounts.stake_vault.key());
        Ok(())
    }

    // ── initialize_vesting ────────────────────────────────────────────────────

    pub fn initialize_vesting(
        ctx: Context<InitializeVesting>,
        team_wallet: Pubkey,
    ) -> Result<()> {
        let total: u64 = TRANCHE_AMOUNTS.iter().sum();
        require!(
            ctx.accounts.global_state.total_minted.saturating_add(total) <= SUPPLY_CAP,
            ErrorCode::SupplyCapReached
        );

        // Reserve the full 100M against the supply cap immediately so miners
        // can never claim tokens that belong to the team.
        ctx.accounts.global_state.total_minted =
            ctx.accounts.global_state.total_minted.saturating_add(total);

        let v = &mut ctx.accounts.team_vest_state;
        v.team_wallet = team_wallet;
        v.start_time = Clock::get()?.unix_timestamp;
        v.claimed = [0u64; 4];

        msg!("Team vesting initialised for {}", team_wallet);
        msg!("Tranche 0: 50,000,000 TERM — unlocks at launch");
        msg!("Tranche 1: 25,000,000 TERM — unlocks at year 5");
        msg!("Tranche 2: 15,000,000 TERM — unlocks at year 7");
        msg!("Tranche 3: 10,000,000 TERM — unlocks at year 10");
        msg!("100,000,000 TERM reserved against supply cap.");
        Ok(())
    }

    // ── claim ─────────────────────────────────────────────────────────────────

    pub fn claim(ctx: Context<Claim>, nonce: u64) -> Result<()> {
        require!(!ctx.accounts.global_state.paused, ErrorCode::ContractPaused);

        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;
        let user_key = ctx.accounts.authority.key();

        // ── Freeze check ──────────────────────────────────────────────────────
        require!(!ctx.accounts.user_state.frozen, ErrorCode::AccountFrozen);

        // ── Rate limit (Phase 1 only — sunsets at year 1) ─────────────────────
        let elapsed_since_launch = current_time
            .saturating_sub(ctx.accounts.global_state.launch_time)
            .max(0);
        let in_phase1 = elapsed_since_launch < PHASE2_ACTIVATION_SECS;

        let rate_limit = ctx.accounts.global_state.rate_limit_seconds;
        if in_phase1 && rate_limit > 0 {
            let last = ctx.accounts.user_state.last_claim_time;
            require!(
                current_time.saturating_sub(last) >= rate_limit,
                ErrorCode::RateLimitExceeded
            );
        }

        // ── PoW verification ──────────────────────────────────────────────────
        let mut hash_input = [0u8; 72];
        hash_input[..8].copy_from_slice(&nonce.to_le_bytes());
        hash_input[8..40].copy_from_slice(&ctx.accounts.global_state.last_hash);
        hash_input[40..72].copy_from_slice(user_key.as_ref());
        let hash_result = keccak::hash(&hash_input);
        require!(
            meets_difficulty(&hash_result.0, ctx.accounts.global_state.difficulty),
            ErrorCode::InvalidProofOfWork
        );

        // ── Emission schedule ─────────────────────────────────────────────────
        let elapsed = current_time.saturating_sub(ctx.accounts.global_state.launch_time).max(0);
        let epoch = ((elapsed / EPOCH_SECONDS) as u32).min(MAX_EPOCHS - 1);
        let base_unscaled = INITIAL_BASE_REWARD >> epoch;
        let (base_reward, bonus_bits) = lucky_reward(
            base_unscaled,
            &hash_result.0,
            ctx.accounts.global_state.difficulty,
        );

        // ── Reward split ──────────────────────────────────────────────────────
        let burn_bps = burn_bps_for(ctx.accounts.global_state.difficulty);
        let burn_amount     = base_reward * burn_bps / BPS_DENOM;
        let treasury_amount = base_reward * TREASURY_BPS / BPS_DENOM;
        let net_reward = base_reward
            .saturating_sub(burn_amount)
            .saturating_sub(treasury_amount);

        // ── Supply cap ────────────────────────────────────────────────────────
        // Reserve treasury share + fixed fee now (if stakers exist) so
        // claim_yield can never mint past the cap. When nobody is staking the
        // treasury portion is not created — consistent with how burn_amount
        // is handled.
        let treasury_committed = if ctx.accounts.stake_pool.total_staked > 0 {
            treasury_amount.saturating_add(CLAIM_FEE)
        } else {
            0
        };
        let to_commit = net_reward.saturating_add(treasury_committed);
        require!(
            ctx.accounts.global_state.total_minted.saturating_add(to_commit) <= SUPPLY_CAP,
            ErrorCode::SupplyCapReached
        );

        // ── Update user state ─────────────────────────────────────────────────
        ctx.accounts.user_state.last_claim_time = current_time;
        ctx.accounts.bond_account.last_claim_time = current_time;

        // ── Update global state ───────────────────────────────────────────────
        {
            let s = &mut ctx.accounts.global_state;
            s.total_minted = s.total_minted.saturating_add(to_commit);
            s.total_claims = s.total_claims.saturating_add(1);
            s.claims_in_window = s.claims_in_window.saturating_add(1);
            s.last_hash = hash_result.0;

            let window_elapsed = current_time.saturating_sub(s.last_claim_window);
            let window_full    = s.claims_in_window >= TARGET_CLAIMS_PER_WINDOW;
            let window_expired = window_elapsed >= TARGET_WINDOW;

            if window_full || window_expired {
                let old_diff = s.difficulty;
                // Continuous adjustment: factor = (claims * TARGET_WINDOW) / (TARGET_CLAIMS * actual_window)
                let denom = (TARGET_CLAIMS_PER_WINDOW as u128).saturating_mul(window_elapsed.max(1) as u128);
                let numer = (old_diff as u128)
                    .saturating_mul(s.claims_in_window as u128)
                    .saturating_mul(TARGET_WINDOW as u128);
                let proposed = (numer / denom).min(u64::MAX as u128) as u64;
                // Bound change to 2× per adjustment in either direction
                let lower = (old_diff / 2).max(MIN_DIFFICULTY);
                let upper = old_diff.saturating_mul(2).min(MAX_DIFFICULTY);
                let new_diff = proposed.clamp(lower, upper);
                emit!(DifficultyAdjusted {
                    old: old_diff,
                    new: new_diff,
                    claims_in_window: s.claims_in_window,
                    window_seconds: window_elapsed,
                });
                msg!("Diff {} → {} | claims={} window={}s",
                    old_diff, new_diff, s.claims_in_window, window_elapsed);
                s.difficulty = new_diff;
                s.claims_in_window = 0;
                s.last_claim_window = current_time;
            }
        }

        // ── Credit treasury → staking pool ────────────────────────────────────
        // Only distributes when stakers exist; supply cap was reserved above.
        // Treasury delta = % of base_reward + fixed CLAIM_FEE.
        if ctx.accounts.stake_pool.total_staked > 0 {
            let pool = &mut ctx.accounts.stake_pool;
            let treasury_total = treasury_amount.saturating_add(CLAIM_FEE);
            pool.treasury_balance = pool.treasury_balance.saturating_add(treasury_total);
            let delta = (treasury_total as u128)
                .saturating_mul(YIELD_PRECISION)
                .saturating_div(pool.total_staked as u128);
            pool.reward_per_token_stored = pool.reward_per_token_stored.saturating_add(delta);
        }

        // ── Mint then burn — produces an on-chain burn event ─────────────────
        // Mint net_reward + burn_amount to the user, then burn burn_amount back.
        // Net balance change for the user is net_reward. The burn_amount is
        // visible as a real on-chain burn in any block explorer.
        let mint_amount = net_reward.saturating_add(burn_amount);
        let bump = ctx.bumps.mint_authority;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[&[b"mint_authority", &[bump]]],
            ),
            mint_amount,
        )?;
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            burn_amount,
        )?;

        emit!(ClaimMined {
            miner: user_key,
            nonce,
            bonus_bits,
            net_reward,
            burn_amount,
            treasury_committed,
            epoch,
            difficulty: ctx.accounts.global_state.difficulty,
            total_minted: ctx.accounts.global_state.total_minted,
        });
        msg!(
            "Mined: net={} bonus_bits={} burn={} treasury={} | epoch={} diff={} committed={}",
            net_reward,
            bonus_bits,
            burn_amount,
            treasury_committed,
            epoch,
            ctx.accounts.global_state.difficulty,
            ctx.accounts.global_state.total_minted,
        );
        Ok(())
    }

    // ── stake ─────────────────────────────────────────────────────────────────

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        // Settle pending yield before modifying position
        let pending = {
            let pool = &ctx.accounts.stake_pool;
            let user = &ctx.accounts.user_stake_account;
            pending_yield(pool.reward_per_token_stored, user.reward_debt, user.amount)
        };
        ctx.accounts.user_stake_account.pending_yield =
            ctx.accounts.user_stake_account.pending_yield.saturating_add(pending);

        // Transfer user tokens → vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;

        ctx.accounts.stake_pool.total_staked =
            ctx.accounts.stake_pool.total_staked.saturating_add(amount);
        let rpts = ctx.accounts.stake_pool.reward_per_token_stored;
        let user = &mut ctx.accounts.user_stake_account;
        user.authority = ctx.accounts.authority.key();
        user.amount = user.amount.saturating_add(amount);
        user.reward_debt = rpts;

        emit!(Staked {
            user: ctx.accounts.authority.key(),
            amount,
            total_staked: ctx.accounts.stake_pool.total_staked,
        });
        msg!("Staked {} TERM. Pool total: {}", amount, ctx.accounts.stake_pool.total_staked);
        Ok(())
    }

    // ── unstake ───────────────────────────────────────────────────────────────

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(ctx.accounts.user_stake_account.amount >= amount, ErrorCode::InsufficientStake);

        // Settle pending yield
        let pending = {
            let pool = &ctx.accounts.stake_pool;
            let user = &ctx.accounts.user_stake_account;
            pending_yield(pool.reward_per_token_stored, user.reward_debt, user.amount)
        };
        ctx.accounts.user_stake_account.pending_yield =
            ctx.accounts.user_stake_account.pending_yield.saturating_add(pending);

        // Transfer vault → user (stake_pool PDA signs for vault)
        let bump = ctx.bumps.stake_pool;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.stake_pool.to_account_info(),
                },
                &[&[b"stake_pool", &[bump]]],
            ),
            amount,
        )?;

        ctx.accounts.stake_pool.total_staked =
            ctx.accounts.stake_pool.total_staked.saturating_sub(amount);
        let rpts = ctx.accounts.stake_pool.reward_per_token_stored;
        let user = &mut ctx.accounts.user_stake_account;
        user.amount = user.amount.saturating_sub(amount);
        user.reward_debt = rpts;

        emit!(Unstaked {
            user: ctx.accounts.authority.key(),
            amount,
            total_staked: ctx.accounts.stake_pool.total_staked,
        });
        msg!("Unstaked {} TERM. Pool total: {}", amount, ctx.accounts.stake_pool.total_staked);
        Ok(())
    }

    // ── claim_yield ───────────────────────────────────────────────────────────

    pub fn claim_yield(ctx: Context<ClaimYield>) -> Result<()> {
        let accrued = {
            let pool = &ctx.accounts.stake_pool;
            let user = &ctx.accounts.user_stake_account;
            pending_yield(pool.reward_per_token_stored, user.reward_debt, user.amount)
        };
        let total = ctx.accounts.user_stake_account.pending_yield.saturating_add(accrued);
        require!(total > 0, ErrorCode::NoYieldAvailable);
        // treasury_balance is the authoritative limit — supply cap was reserved
        // against total_minted when these tokens were accrued in claim().
        require!(ctx.accounts.stake_pool.treasury_balance >= total, ErrorCode::InsufficientTreasury);

        ctx.accounts.stake_pool.treasury_balance =
            ctx.accounts.stake_pool.treasury_balance.saturating_sub(total);
        let rpts = ctx.accounts.stake_pool.reward_per_token_stored;
        let user = &mut ctx.accounts.user_stake_account;
        user.pending_yield = 0;
        user.reward_debt = rpts;

        let bump = ctx.bumps.mint_authority;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[&[b"mint_authority", &[bump]]],
            ),
            total,
        )?;

        emit!(YieldClaimed {
            user: ctx.accounts.authority.key(),
            amount: total,
        });
        msg!("Yield claimed: {}", total);
        Ok(())
    }

    // ── claim_team_vest ───────────────────────────────────────────────────────

    pub fn claim_team_vest(ctx: Context<ClaimTeamVest>) -> Result<()> {
        let clock = Clock::get()?;
        let elapsed = clock.unix_timestamp
            .saturating_sub(ctx.accounts.team_vest_state.start_time)
            .max(0);

        // Sum unclaimed tokens across all tranches that have any vested amount.
        // Linear vesting (tranches 1–3) means partial amounts can be available.
        let mut claimable: u64 = 0;
        let mut new_claimed: [u64; 4] = ctx.accounts.team_vest_state.claimed;
        for i in 0..4usize {
            let vested = tranche_vested(i, elapsed);
            let already = ctx.accounts.team_vest_state.claimed[i];
            let unclaimed = vested.saturating_sub(already);
            if unclaimed > 0 {
                claimable = claimable.saturating_add(unclaimed);
                new_claimed[i] = vested;
            }
        }
        require!(claimable > 0, ErrorCode::NothingVested);

        // Supply cap was already reserved in initialize_vesting — no total_minted update.
        ctx.accounts.team_vest_state.claimed = new_claimed;

        let bump = ctx.bumps.mint_authority;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.team_token_account.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[&[b"mint_authority", &[bump]]],
            ),
            claimable,
        )?;

        let total_claimed: u64 = ctx.accounts.team_vest_state.claimed.iter().sum();
        let total_allocation: u64 = TRANCHE_AMOUNTS.iter().sum();
        emit!(TeamVestClaimed {
            team_wallet: ctx.accounts.team_wallet.key(),
            amount: claimable,
            total_claimed,
        });
        msg!("Team vest: {} TERM claimed ({}/{})", claimable, total_claimed, total_allocation);
        Ok(())
    }

    // ── get_team_vest_status ──────────────────────────────────────────────────

    pub fn get_team_vest_status(ctx: Context<GetTeamVestStatus>) -> Result<TeamVestStatus> {
        let v = &ctx.accounts.team_vest_state;
        let clock = Clock::get()?;
        let elapsed = clock.unix_timestamp.saturating_sub(v.start_time).max(0);

        let total_allocation: u64 = TRANCHE_AMOUNTS.iter().sum();
        let total_claimed: u64 = v.claimed.iter().sum();

        let mut total_claimable: u64 = 0;
        let mut tranche_unlocked = [false; 4];
        let mut tranche_vested_arr = [0u64; 4];
        for i in 0..4usize {
            let vested = tranche_vested(i, elapsed);
            tranche_vested_arr[i] = vested;
            if elapsed >= TRANCHE_UNLOCK_SECONDS[i] {
                tranche_unlocked[i] = true;
            }
            total_claimable = total_claimable.saturating_add(vested.saturating_sub(v.claimed[i]));
        }

        msg!("=== TEAM VESTING STATUS ===");
        msg!("Beneficiary    : {}", v.team_wallet);
        msg!("Total alloc    : {}.{:06} TERM", total_allocation / 1_000_000, total_allocation % 1_000_000);
        msg!("Total claimed  : {}.{:06} TERM", total_claimed / 1_000_000, total_claimed % 1_000_000);
        msg!("Total claimable: {}.{:06} TERM", total_claimable / 1_000_000, total_claimable % 1_000_000);
        for i in 0..4usize {
            msg!("Tranche {}  alloc={} vested={} claimed={} unlocked={}",
                i, TRANCHE_AMOUNTS[i], tranche_vested_arr[i], v.claimed[i], tranche_unlocked[i]);
        }

        Ok(TeamVestStatus {
            team_wallet: v.team_wallet,
            total_allocation,
            total_claimed,
            total_claimable,
            elapsed_seconds: elapsed,
            tranche_amounts: TRANCHE_AMOUNTS,
            tranche_claimed: v.claimed,
            tranche_unlocked,
            tranche_vested: tranche_vested_arr,
        })
    }

    // ── propose_authority ─────────────────────────────────────────────────────
    // Two-step transfer: current authority sets a `pending_authority`, who must
    // then call `accept_authority`. Prevents bricking the program by transferring
    // to an address with no controlled keypair.

    pub fn propose_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.global_state.pending_authority = new_authority;
        msg!("Authority transfer proposed → {}", new_authority);
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let s = &mut ctx.accounts.global_state;
        require!(s.pending_authority != Pubkey::default(), ErrorCode::NoPendingTransfer);
        s.authority = s.pending_authority;
        s.pending_authority = Pubkey::default();
        msg!("Authority transfer accepted by {}", s.authority);
        Ok(())
    }

    pub fn cancel_authority_transfer(ctx: Context<AuthorityOnly>) -> Result<()> {
        ctx.accounts.global_state.pending_authority = Pubkey::default();
        msg!("Pending authority transfer cancelled.");
        Ok(())
    }

    // ── propose_freeze_authority ──────────────────────────────────────────────

    pub fn propose_freeze_authority(
        ctx: Context<FreezeAuthorityOnly>,
        new_freeze_authority: Pubkey,
    ) -> Result<()> {
        ctx.accounts.global_state.pending_freeze_authority = new_freeze_authority;
        msg!("Freeze authority transfer proposed → {}", new_freeze_authority);
        Ok(())
    }

    pub fn accept_freeze_authority(ctx: Context<AcceptFreezeAuthority>) -> Result<()> {
        let s = &mut ctx.accounts.global_state;
        require!(s.pending_freeze_authority != Pubkey::default(), ErrorCode::NoPendingTransfer);
        s.freeze_authority = s.pending_freeze_authority;
        s.pending_freeze_authority = Pubkey::default();
        msg!("Freeze authority transfer accepted by {}", s.freeze_authority);
        Ok(())
    }

    pub fn cancel_freeze_authority_transfer(ctx: Context<FreezeAuthorityOnly>) -> Result<()> {
        ctx.accounts.global_state.pending_freeze_authority = Pubkey::default();
        msg!("Pending freeze authority transfer cancelled.");
        Ok(())
    }

    // ── disable_freeze_authority ──────────────────────────────────────────────
    // PERMANENTLY disables freezing by setting freeze_authority (and any pending)
    // to Pubkey::default(). Since no one can sign as the zero address, the
    // existing has_one constraint on set_freeze will reject all future freeze
    // attempts. Authority-only — one-way "graduation" once Sybil resistance from
    // bond + PoW is proven sufficient.

    pub fn disable_freeze_authority(ctx: Context<AuthorityOnly>) -> Result<()> {
        let s = &mut ctx.accounts.global_state;
        s.freeze_authority = Pubkey::default();
        s.pending_freeze_authority = Pubkey::default();
        msg!("Freeze authority permanently disabled. Set_freeze can never succeed again.");
        Ok(())
    }

    // ── set_paused ────────────────────────────────────────────────────────────

    pub fn set_paused(ctx: Context<AuthorityOnly>, paused: bool) -> Result<()> {
        ctx.accounts.global_state.paused = paused;
        msg!("Contract paused: {}", paused);
        Ok(())
    }

    // ── set_freeze ────────────────────────────────────────────────────────────

    pub fn set_freeze(ctx: Context<SetFreeze>, frozen: bool) -> Result<()> {
        ctx.accounts.user_state.frozen = frozen;
        msg!("Wallet {} frozen: {}", ctx.accounts.target.key(), frozen);
        Ok(())
    }

    // ── set_rate_limit ────────────────────────────────────────────────────────

    pub fn set_rate_limit(ctx: Context<AuthorityOnly>, seconds: i64) -> Result<()> {
        require!(seconds >= 0, ErrorCode::InvalidAmount);
        ctx.accounts.global_state.rate_limit_seconds = seconds;
        msg!("Rate limit: {}s", seconds);
        Ok(())
    }

    // ── deposit_bond ──────────────────────────────────────────────────────────
    // SOL bond path: locks ~0.001 SOL of rent in a per-user BondAccount PDA.
    // Recoverable via `withdraw_bond` after cooldown.

    pub fn deposit_bond(ctx: Context<DepositBond>) -> Result<()> {
        let bond = &mut ctx.accounts.bond_account;
        bond.kind = BOND_KIND_SOL;
        bond.term_amount = 0;
        emit!(BondDeposited {
            miner: ctx.accounts.authority.key(),
            kind: BOND_KIND_SOL,
            term_amount: 0,
        });
        msg!("SOL bond deposited.");
        Ok(())
    }

    // ── deposit_bond_term ─────────────────────────────────────────────────────
    // TERM bond path: transfers TERM_BOND_AMOUNT from the user's token account
    // into the shared bond_term_vault. Must call initialize_bond_vault first
    // (one-time, authority). Recoverable via `withdraw_bond_term` after cooldown.

    pub fn deposit_bond_term(ctx: Context<DepositBondTerm>) -> Result<()> {
        let bond = &mut ctx.accounts.bond_account;
        bond.kind = BOND_KIND_TERM;
        bond.term_amount = TERM_BOND_AMOUNT;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.bond_term_vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            TERM_BOND_AMOUNT,
        )?;

        emit!(BondDeposited {
            miner: ctx.accounts.authority.key(),
            kind: BOND_KIND_TERM,
            term_amount: TERM_BOND_AMOUNT,
        });
        msg!("TERM bond deposited: {} TERM", TERM_BOND_AMOUNT / 1_000_000);
        Ok(())
    }

    // ── withdraw_bond ─────────────────────────────────────────────────────────
    // Closes the SOL bond PDA and returns rent to authority. Only allowed once
    // BOND_WITHDRAW_COOLDOWN seconds have passed since the wallet's last claim.

    pub fn withdraw_bond(ctx: Context<WithdrawBond>) -> Result<()> {
        require!(
            ctx.accounts.bond_account.kind == BOND_KIND_SOL,
            ErrorCode::WrongBondKind
        );
        let now = Clock::get()?.unix_timestamp;
        let last = ctx.accounts.bond_account.last_claim_time;
        require!(
            now.saturating_sub(last) >= BOND_WITHDRAW_COOLDOWN,
            ErrorCode::BondLocked
        );
        emit!(BondWithdrawn {
            miner: ctx.accounts.authority.key(),
            kind: BOND_KIND_SOL,
            term_amount: 0,
        });
        msg!("SOL bond withdrawn.");
        Ok(())
    }

    // ── withdraw_bond_term ────────────────────────────────────────────────────
    // Returns the bonded TERM to the user's token account and closes the
    // BondAccount (refunding the small SOL rent). Cooldown applies.

    pub fn withdraw_bond_term(ctx: Context<WithdrawBondTerm>) -> Result<()> {
        require!(
            ctx.accounts.bond_account.kind == BOND_KIND_TERM,
            ErrorCode::WrongBondKind
        );
        let now = Clock::get()?.unix_timestamp;
        let last = ctx.accounts.bond_account.last_claim_time;
        require!(
            now.saturating_sub(last) >= BOND_WITHDRAW_COOLDOWN,
            ErrorCode::BondLocked
        );

        let amount = ctx.accounts.bond_account.term_amount;
        let bump = ctx.bumps.bond_vault_authority;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bond_term_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.bond_vault_authority.to_account_info(),
                },
                &[&[b"bond_vault_authority", &[bump]]],
            ),
            amount,
        )?;

        emit!(BondWithdrawn {
            miner: ctx.accounts.authority.key(),
            kind: BOND_KIND_TERM,
            term_amount: amount,
        });
        msg!("TERM bond withdrawn: {} TERM", amount / 1_000_000);
        Ok(())
    }

    // ── initialize_bond_vault ─────────────────────────────────────────────────
    // One-time setup: creates the shared TERM bond escrow vault. Authority-only.
    // Must be called once after the program is initialized; required before any
    // miner can use `deposit_bond_term`.

    pub fn initialize_bond_vault(ctx: Context<InitializeBondVault>) -> Result<()> {
        msg!("TERM bond vault initialised: {}", ctx.accounts.bond_term_vault.key());
        Ok(())
    }

    // ── create_metadata ───────────────────────────────────────────────────────
    // CPIs into Metaplex Token Metadata, signing with the mint_authority PDA.
    // update_authority is set to the caller (authority wallet) so the URI
    // can be updated later once an image is ready.

    pub fn create_metadata(
        ctx: Context<CreateMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        let bump = ctx.bumps.mint_authority;

        CreateMetadataAccountV3CpiBuilder::new(&ctx.accounts.metadata_program)
            .metadata(&ctx.accounts.metadata)
            .mint(&ctx.accounts.mint.to_account_info())
            .mint_authority(&ctx.accounts.mint_authority)
            .payer(&ctx.accounts.authority)
            .update_authority(&ctx.accounts.authority, true)
            .system_program(&ctx.accounts.system_program)
            .data(DataV2 {
                name: name.clone(),
                symbol: symbol.clone(),
                uri: uri.clone(),
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            })
            .is_mutable(true)
            .invoke_signed(&[&[b"mint_authority", &[bump]]])?;

        msg!("Metadata created: {} ({}) — uri={}", name, symbol, uri);
        Ok(())
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn meets_difficulty(hash: &[u8; 32], difficulty: u64) -> bool {
    if difficulty <= 1 { return true; }
    // Take first 8 bytes of the hash as a big-endian u64 and require it
    // to be <= u64::MAX / difficulty (probability ≈ 1 / difficulty).
    let hash_high = u64::from_be_bytes([
        hash[0], hash[1], hash[2], hash[3],
        hash[4], hash[5], hash[6], hash[7],
    ]);
    hash_high <= u64::MAX / difficulty
}

/// Apply lucky-block multiplier based on how much the hash overshoots the
/// difficulty threshold. Returns (final_reward, bonus_bits).
///
/// Each "extra zero bit" (the hash being half the threshold value) doubles
/// the reward, capped at 2^BONUS_CAP. EV per unit of compute is constant
/// (2× the work to find a 2× bonus), so miners are indifferent between
/// strategies — and `last_hash` rotation makes "submit immediately" the
/// dominant strategy regardless.
fn lucky_reward(base: u64, hash: &[u8; 32], difficulty: u64) -> (u64, u32) {
    if base == 0 || difficulty <= 1 { return (base, 0); }

    let hash_high = u64::from_be_bytes([
        hash[0], hash[1], hash[2], hash[3],
        hash[4], hash[5], hash[6], hash[7],
    ]);
    let max_valid = u64::MAX / difficulty;

    // Defensive: caller should have already verified meets_difficulty.
    if hash_high > max_valid { return (base, 0); }

    // hash_high == 0 → astronomically lucky (1 in 2^64). Give max bonus.
    if hash_high == 0 {
        return (base.saturating_mul(1u64 << BONUS_CAP), BONUS_CAP);
    }

    // ratio = how many times "luckier" than threshold.
    // bonus_bits = floor(log2(ratio)), clamped to BONUS_CAP.
    let ratio = max_valid / hash_high;
    if ratio == 0 { return (base, 0); }
    let bonus_bits = (63 - ratio.leading_zeros()).min(BONUS_CAP);
    (base.saturating_mul(1u64 << bonus_bits), bonus_bits)
}

/// Amount of tranche `i` vested at `elapsed` seconds since vesting start.
/// Tranches 1–3 linearly vest over TRANCHE_LINEAR_PERIODS[i] after their
/// unlock time. Tranche 0 is a cliff (period = 0 → fully vested at unlock).
fn tranche_vested(i: usize, elapsed: i64) -> u64 {
    let unlock = TRANCHE_UNLOCK_SECONDS[i];
    let total = TRANCHE_AMOUNTS[i];
    if elapsed < unlock { return 0; }
    let period = TRANCHE_LINEAR_PERIODS[i];
    if period == 0 { return total; }
    let since_unlock = (elapsed - unlock).min(period);
    ((total as u128) * (since_unlock as u128) / (period as u128)) as u64
}

/// Linearly interpolate burn rate between BURN_BPS_MIN and BURN_BPS_MAX
/// based on log2(difficulty). Below BITS_LOW → MIN; above BITS_HIGH → MAX.
fn burn_bps_for(difficulty: u64) -> u64 {
    let bits = if difficulty == 0 { 0 } else { 63 - difficulty.leading_zeros() };
    if bits <= BURN_DIFF_BITS_LOW { return BURN_BPS_MIN; }
    if bits >= BURN_DIFF_BITS_HIGH { return BURN_BPS_MAX; }
    let progress = (bits - BURN_DIFF_BITS_LOW) as u64;
    let span = (BURN_DIFF_BITS_HIGH - BURN_DIFF_BITS_LOW) as u64;
    BURN_BPS_MIN + (BURN_BPS_MAX - BURN_BPS_MIN) * progress / span
}

fn pending_yield(reward_per_token_stored: u128, reward_debt: u128, amount: u64) -> u64 {
    (reward_per_token_stored
        .saturating_sub(reward_debt)
        .saturating_mul(amount as u128)
        / YIELD_PRECISION) as u64
}

// ─── Data accounts ────────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct GlobalState {
    pub authority: Pubkey,                 // 32
    pub freeze_authority: Pubkey,          // 32
    pub pending_authority: Pubkey,         // 32 — two-step transfer
    pub pending_freeze_authority: Pubkey,  // 32 — two-step transfer
    pub paused: bool,                      // 1
    pub difficulty: u64,                   // 8  — continuous target multiplier
    pub launch_time: i64,                  // 8
    pub last_claim_window: i64,            // 8
    pub total_claims: u64,                 // 8
    pub claims_in_window: u64,             // 8
    pub total_minted: u64,                 // 8
    pub rate_limit_seconds: i64,           // 8
    pub last_hash: [u8; 32],               // 32
}
// borsh total: 217 bytes → fits within space = 8 + 256

#[account]
#[derive(Default)]
pub struct StakePool {
    pub total_staked: u64,              // 8
    pub reward_per_token_stored: u128,  // 16
    pub treasury_balance: u64,          // 8
}
// borsh total: 32 bytes → space = 8 + 64

#[account]
#[derive(Default)]
pub struct UserStakeAccount {
    pub authority: Pubkey,  // 32
    pub amount: u64,        // 8
    pub reward_debt: u128,  // 16
    pub pending_yield: u64, // 8
}
// borsh total: 64 bytes → space = 8 + 80

#[account]
#[derive(Default)]
pub struct UserState {
    pub last_claim_time: i64, // 8
    pub frozen: bool,         // 1
}
// borsh total: 9 bytes → space = 8 + 16

#[account]
#[derive(Default)]
pub struct BondAccount {
    pub last_claim_time: i64, // 8  — last activity, gates withdrawal cooldown
    pub kind: u8,             // 1  — 0 = SOL bond, 1 = TERM bond
    pub term_amount: u64,     // 8  — TERM held in vault (0 unless kind = TERM)
}
// borsh total: 17 bytes → space = 8 + 17 = 25

#[account]
#[derive(Default)]
pub struct TeamVestState {
    pub team_wallet: Pubkey,    // 32
    pub start_time: i64,        // 8
    pub claimed: [u64; 4],      // 32 — per-tranche claimed amounts
}
// borsh total: 72 bytes → space = 8 + 80

// ─── Return types ─────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct TeamVestStatus {
    pub team_wallet: Pubkey,
    pub total_allocation: u64,
    pub total_claimed: u64,
    pub total_claimable: u64,
    pub elapsed_seconds: i64,
    pub tranche_amounts: [u64; 4],
    pub tranche_claimed: [u64; 4],
    pub tranche_unlocked: [bool; 4],   // unlock time has passed
    pub tranche_vested: [u64; 4],      // amount vested so far (linear curve)
}

// ─── Accounts structs ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 256,
        seeds = [b"global_state_final_2026"],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,

    /// Mint is created here, atomically with global state.
    /// Authority is immediately the PDA — no external setAuthority call needed.
    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = mint_authority,
        seeds = [b"mint"],
        bump
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: PDA used as mint authority — owns no data, signs mint CPIs
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeStakePool<'info> {
    #[account(seeds = [b"global_state_final_2026"], bump, has_one = authority @ ErrorCode::NotAuthority)]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init,
        payer = authority,
        space = 8 + 64,
        seeds = [b"stake_pool"],
        bump
    )]
    pub stake_pool: Account<'info, StakePool>,

    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = stake_pool,
        seeds = [b"stake_vault"],
        bump
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeVesting<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 80,
        seeds = [b"team_vest"],
        bump
    )]
    pub team_vest_state: Account<'info, TeamVestState>,

    #[account(
        mut,
        seeds = [b"global_state_final_2026"],
        bump,
        has_one = authority @ ErrorCode::NotAuthority
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// Relayer pays the SOL fee — enables gasless UX for miners.
    /// May equal `authority` for self-funded claims.
    #[account(mut)]
    pub fee_payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global_state_final_2026"],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [b"stake_pool"],
        bump
    )]
    pub stake_pool: Account<'info, StakePool>,

    #[account(mut, seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,

    #[account(mut, token::mint = mint)]
    pub user_token_account: Account<'info, TokenAccount>,

    /// CHECK: PDA mint authority — validated by seeds constraint
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// The miner. Their pubkey is baked into the PoW hash to prevent front-running.
    /// Also the payer for first-claim user_state rent — prevents griefing relayers
    /// who would otherwise pay rent on attacker-generated wallets.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Per-user state (rate limit + freeze). Created on first claim, paid by
    /// the authority (not fee_payer) so a malicious miner can't drain a relayer
    /// of rent across many fake wallets.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + 16,
        seeds = [b"user_state", authority.key().as_ref()],
        bump
    )]
    pub user_state: Account<'info, UserState>,

    /// Anti-Sybil bond — must be deposited via `deposit_bond` before mining.
    /// Existence is the proof of bond; the account rent (~0.001 SOL) is the
    /// locked capital. Updated each claim to track withdrawal cooldown.
    #[account(
        mut,
        seeds = [b"bond", authority.key().as_ref()],
        bump
    )]
    pub bond_account: Account<'info, BondAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        mut,
        seeds = [b"stake_pool"],
        bump
    )]
    pub stake_pool: Account<'info, StakePool>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + 80,
        seeds = [b"user_stake", authority.key().as_ref()],
        bump
    )]
    pub user_stake_account: Account<'info, UserStakeAccount>,

    #[account(
        mut,
        seeds = [b"stake_vault"],
        bump
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        mut,
        seeds = [b"stake_pool"],
        bump
    )]
    pub stake_pool: Account<'info, StakePool>,

    #[account(
        mut,
        seeds = [b"user_stake", authority.key().as_ref()],
        bump,
        has_one = authority @ ErrorCode::NotAuthority
    )]
    pub user_stake_account: Account<'info, UserStakeAccount>,

    #[account(
        mut,
        seeds = [b"stake_vault"],
        bump
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimYield<'info> {
    #[account(
        mut,
        seeds = [b"stake_pool"],
        bump
    )]
    pub stake_pool: Account<'info, StakePool>,

    #[account(
        mut,
        seeds = [b"user_stake", authority.key().as_ref()],
        bump,
        has_one = authority @ ErrorCode::NotAuthority
    )]
    pub user_stake_account: Account<'info, UserStakeAccount>,

    #[account(mut, seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    /// CHECK: PDA mint authority
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimTeamVest<'info> {
    #[account(
        mut,
        seeds = [b"team_vest"],
        bump,
        has_one = team_wallet @ ErrorCode::NotAuthority
    )]
    pub team_vest_state: Account<'info, TeamVestState>,

    #[account(mut, seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub team_token_account: Account<'info, TokenAccount>,

    /// CHECK: PDA mint authority
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    pub team_wallet: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct GetTeamVestStatus<'info> {
    #[account(seeds = [b"team_vest"], bump)]
    pub team_vest_state: Account<'info, TeamVestState>,
}


#[derive(Accounts)]
pub struct SetFreeze<'info> {
    #[account(
        seeds = [b"global_state_final_2026"],
        bump,
        has_one = freeze_authority @ ErrorCode::NotFreezeAuthority
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [b"user_state", target.key().as_ref()],
        bump
    )]
    pub user_state: Account<'info, UserState>,

    /// CHECK: the wallet being frozen/unfrozen — pubkey only
    pub target: UncheckedAccount<'info>,

    pub freeze_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    #[account(
        mut,
        seeds = [b"global_state_final_2026"],
        bump,
        has_one = authority @ ErrorCode::NotAuthority
    )]
    pub global_state: Account<'info, GlobalState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositBond<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 17,
        seeds = [b"bond", authority.key().as_ref()],
        bump
    )]
    pub bond_account: Account<'info, BondAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositBondTerm<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 17,
        seeds = [b"bond", authority.key().as_ref()],
        bump
    )]
    pub bond_account: Account<'info, BondAccount>,

    #[account(
        mut,
        seeds = [b"bond_term_vault"],
        bump
    )]
    pub bond_term_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawBondTerm<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"bond", authority.key().as_ref()],
        bump
    )]
    pub bond_account: Account<'info, BondAccount>,

    #[account(
        mut,
        seeds = [b"bond_term_vault"],
        bump
    )]
    pub bond_term_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    /// CHECK: PDA that owns the bond_term_vault — signs CPI for transfer out
    #[account(seeds = [b"bond_vault_authority"], bump)]
    pub bond_vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeBondVault<'info> {
    #[account(
        seeds = [b"global_state_final_2026"],
        bump,
        has_one = authority @ ErrorCode::NotAuthority
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = bond_vault_authority,
        seeds = [b"bond_term_vault"],
        bump
    )]
    pub bond_term_vault: Account<'info, TokenAccount>,

    /// CHECK: PDA that owns the bond_term_vault — used as `token::authority`
    #[account(seeds = [b"bond_vault_authority"], bump)]
    pub bond_vault_authority: UncheckedAccount<'info>,

    #[account(seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct WithdrawBond<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"bond", authority.key().as_ref()],
        bump
    )]
    pub bond_account: Account<'info, BondAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FreezeAuthorityOnly<'info> {
    #[account(
        mut,
        seeds = [b"global_state_final_2026"],
        bump,
        has_one = freeze_authority @ ErrorCode::NotFreezeAuthority
    )]
    pub global_state: Account<'info, GlobalState>,
    pub freeze_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        mut,
        seeds = [b"global_state_final_2026"],
        bump,
        has_one = pending_authority @ ErrorCode::NotPendingAuthority
    )]
    pub global_state: Account<'info, GlobalState>,
    pub pending_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptFreezeAuthority<'info> {
    #[account(
        mut,
        seeds = [b"global_state_final_2026"],
        bump,
        has_one = pending_freeze_authority @ ErrorCode::NotPendingAuthority
    )]
    pub global_state: Account<'info, GlobalState>,
    pub pending_freeze_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateMetadata<'info> {
    #[account(
        seeds = [b"global_state_final_2026"],
        bump,
        has_one = authority @ ErrorCode::NotAuthority
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,

    /// CHECK: Metaplex metadata PDA — address validated against mint by seeds constraint
    #[account(
        mut,
        seeds = [b"metadata", mpl_token_metadata::ID.as_ref(), mint.key().as_ref()],
        seeds::program = mpl_token_metadata::ID,
        bump
    )]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: PDA mint authority — signs the Metaplex CPI
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Metaplex Token Metadata program
    #[account(address = mpl_token_metadata::ID)]
    pub metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ─── Events ───────────────────────────────────────────────────────────────────
// Indexable events — consumed by indexers (Helius, Triton) and UIs.

#[event]
pub struct ClaimMined {
    pub miner: Pubkey,
    pub nonce: u64,
    pub bonus_bits: u32,         // 0..=BONUS_CAP — indexers filter ≥4 to surface "jackpots"
    pub net_reward: u64,
    pub burn_amount: u64,
    pub treasury_committed: u64,
    pub epoch: u32,
    pub difficulty: u64,
    pub total_minted: u64,
}

#[event]
pub struct DifficultyAdjusted {
    pub old: u64,
    pub new: u64,
    pub claims_in_window: u64,
    pub window_seconds: i64,
}

#[event]
pub struct BondDeposited {
    pub miner: Pubkey,
    pub kind: u8,           // 0 = SOL, 1 = TERM
    pub term_amount: u64,   // 0 unless kind = 1
}

#[event]
pub struct BondWithdrawn {
    pub miner: Pubkey,
    pub kind: u8,
    pub term_amount: u64,
}

#[event]
pub struct TeamVestClaimed {
    pub team_wallet: Pubkey,
    pub amount: u64,
    pub total_claimed: u64,
}

#[event]
pub struct Staked {
    pub user: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct Unstaked {
    pub user: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct YieldClaimed {
    pub user: Pubkey,
    pub amount: u64,
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Invalid proof of work — nonce does not meet difficulty target")]
    InvalidProofOfWork,
    #[msg("Hard supply cap of 1 billion TERM reached")]
    SupplyCapReached,
    #[msg("Claim too soon — rate limit active")]
    RateLimitExceeded,
    #[msg("This wallet is frozen")]
    AccountFrozen,
    #[msg("Signer is not the program authority")]
    NotAuthority,
    #[msg("Signer is not the freeze authority")]
    NotFreezeAuthority,
    #[msg("Vesting cliff period has not passed")]
    CliffNotReached,
    #[msg("No tokens vested or all already claimed")]
    NothingVested,
    #[msg("No staking yield available")]
    NoYieldAvailable,
    #[msg("Insufficient treasury balance for yield distribution")]
    InsufficientTreasury,
    #[msg("Insufficient staked amount")]
    InsufficientStake,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Bond is locked — wait for cooldown to withdraw")]
    BondLocked,
    #[msg("Wrong bond kind — use the matching withdraw instruction (SOL vs TERM)")]
    WrongBondKind,
    #[msg("Signer is not the pending authority")]
    NotPendingAuthority,
    #[msg("No pending transfer to accept")]
    NoPendingTransfer,
}
