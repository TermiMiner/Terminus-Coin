# Terminus Coin (TERM) — Security Audit Scope

*Reusable scope statement for soliciting audit quotes. Paste into quote requests / RFP emails.*

## Project

Terminus Coin (TERM) — a Solana proof-of-work SPL token. Single Anchor program. Mining is permissionless: miners solve a PoW against a rotating on-chain hash and claim freshly-minted TERM; emission follows a halving schedule with on-chain difficulty adjustment.

## Scope (in)

- **`programs/terminuscoin/src/lib.rs`** — ~1,880 LOC, ~25 instructions. A 12-line `#[cfg(test)]` hook at the end of the file is not compiled into the program.
- **Stack:** Anchor 0.32.0, **classic SPL Token** (`anchor_spl::token`, `Tokenkeg…` — `Program<Token>` throughout; 82-byte mint, no extensions), `init-if-needed`. Note: anchor-spl's `spl-token-2022` cargo feature is enabled but **unused** — the program has no token-2022 code paths, accounts, or extensions.
- **Frozen source:** audit ref is tag **`audit-scope-v2`** (`git checkout audit-scope-v2`). The program's logic is unchanged since `1256c10`. At the tag, `lib.rs` is byte-identical to `4c8bd4e` and `Cargo.lock` to `e32fae9`; everything after those commits touches only the frontend and relayer, docs, scripts and tests.
- **Replaces `audit-scope-v1`.** The two differ in 14 lines of build input and in no program logic. Twelve are a `#[cfg(test)]` block at the end of `lib.rs` that includes the property tests; it is compiled out of the deployed program, and the tests themselves live outside the program's directory. Two are in `Cargo.lock`: `ctutils` 0.4.2 → 0.4.5 for RUSTSEC-2026-0385, a crate the program links through `solana-program` → `blake3` → `digest`.
- **Build:** Solana 3.1.12 (`cargo build-sbf`, platform-tools v1.52). The program binary is 630,544 bytes, sha256 `3679aaf2494298916a7fed98725d10096a4bcfec01d90dc1a74f3a0e2c852985`. CI builds it on every commit and prints the hash, and the integration suite runs against it. The Anchor verifiable-build image gives the same bytes when it is given the same toolchain (`anchor build --verifiable --solana-version 3.1.12`). Without the pin that image uses Solana 2.3.0, whose cargo cannot read an edition-2024 crate in the lockfile, and the build fails.

### Subsystems to review
1. **PoW `claim(nonce, relayer_tip_term)`** — nonce verified against a rotating `last_hash`; halving emission schedule; on-chain difficulty adjustment; lucky-bonus multiplier (`2^bits`); and an **atomic relayer-tip market** — the claim can tip N TERM (out of the mint) to whoever broadcasts the tx, capped at `MAX_TIP_TERM` = 5 TERM (hardcoded, not governance-settable).
2. **Anti-Sybil bonds** — SOL and TERM bonds (`deposit_bond`/`deposit_bond_term`/`withdraw_bond*`) with `rent_payer` tracking to make gasless onboarding griefing-resistant.
3. **Staking + yield** — `stake` / `unstake` / `claim_yield`.
4. **Team vesting** — `claim_team_vest`, 10-year / 4-tranche, gated by `has_one = team_wallet`.
5. **Governance / safety** — two-step authority transfer (`propose_authority`/`accept_authority`/`cancel_*`), two-step freeze-authority transfer, one-way `disable_freeze_authority`, `set_paused`, `set_freeze`, `set_rate_limit`. Authority intended to be a Squads 2-of-3 multisig at launch.

## Scope (out)

- The **`miner-ui`** React/TypeScript frontend and the **Vercel serverless relayer functions** — no on-chain trust surface (the PoW preimage binds the authority pubkey, so a relayer cannot steal or alter a claim).
- **npm advisories** are already triaged: 9 upstream-blocked transitive advisories in the Solana SDK / wallet-adapter chain, none with a non-breaking fix. The on-chain program has no npm dependency surface. (Detail available on request.)

## Areas we already know are subtle (threat-model pointers)

- PoW **nonce ↔ `last_hash`** binding (rotation invalidates a held nonce — by design).
- Bond **`rent_payer` griefing** vector on gasless onboarding (relayer pays bond rent → miner withdraws → keeps refund). Mitigation in the deposit/withdraw paths.
- **Freeze scope:** the `frozen` flag is checked only by `claim` and `claim_yield`; exit paths (`stake`/`unstake`/`withdraw_bond*`) are intentionally left open (freeze = "stop further earning," not asset seizure).
- **Emission / halving math** and difficulty adjustment arithmetic (overflow/rounding).
- **`MAX_TIP_TERM`** cap enforcement and the `tip <= net_reward` invariant.
- Two-step **authority / freeze-authority** transfer state machines.

## Existing assurance

- **Anchor TypeScript integration test suite** (`tests/terminus-coin.ts`): 45 tests against a local validator.
- **Rust property tests** (`tests/property_tests.rs`): 20 host-side tests that check the five pure helpers against independent definitions and conservation laws, plus a model of the staking pool's bookkeeping. Mutation-checked: 15 planted bugs, all caught.
- **CI:** `cargo build-sbf`, `cargo fmt`, `cargo clippy -D warnings`, `cargo test`, `cargo audit`, and the integration suite against a local validator.
- **Static analysis:** Sec3 X-Ray runs in CI and is clean except one baselined false positive (`IntegerDivOverflow` in the lucky-reward path — unsigned `u64::MAX / difficulty`, guarded so `difficulty >= 2`).

## Deliverable wanted

Manual security audit with a published report; all critical and high findings remediated and re-reviewed (one remediation round).

## What we need from you (quote)

- Fixed price
- Earliest start date + lead time
- Auditor-weeks allocated to the engagement
- Whether one remediation re-review is included
- Report-publishing terms

---

## Firm shortlist (send the same package to 3–4 in parallel)

**Budget / mid-market**
- **Sec3** — natural continuity; we already run their open-source X-Ray in CI.
- **Accretion**
- **Offside Labs**
- **Bramah Systems**
- **Hashlock**
- **MadShield**

**Contest / marketplace** (often cheapest for a contained, single-program scope)
- **Cantina** (Spearbit) — can match a solo Solana auditor *or* run a competitive review; produces a named report.
- **Sherlock**
- **Code4rena**

**Premium** (most expensive — reference / price-anchor only)
- Neodyme / OtterSec / Halborn

**Selection:** compare on (price ÷ auditor-weeks) and Solana/Anchor track record, not headline price. A cheap quote with half the auditor-time isn't cheaper per unit of coverage.

## Scope emphasis

The **relayer-tip market** is in scope, and it is a live money path. In the same instruction that mints a claim, the miner authorises a `token::transfer` of `relayer_tip_term` from their own ATA to the broadcaster's, bounded by both `MAX_TIP_TERM` and `tip <= net_reward` (post-burn, post-treasury). See subsystem 1 above. Please price it explicitly rather than treating `claim` as a plain PoW handler — it materially affects the quote.
