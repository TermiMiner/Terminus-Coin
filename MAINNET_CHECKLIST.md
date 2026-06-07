# Mainnet launch checklist

Operational items that must be completed before mainnet deploy. Listed in execution order, with the most consequential and irreversible items first. **Do not skip these on launch day.**

---

## 1. Upgrade-authority sunset (non-reversible)

**Devnet posture:** upgrade authority is *retained* by the deployer wallet (`BmorV43rrjPVfm5pJRvs6d9ytqsx2cxTn656n1J2aNDs`). This is intentional — we need to iterate on the program.

**Decision (2026-05-18):** option (a) — Squads multisig, **2-of-3**, all three signers on hardware wallets. Signers: Aaron + two trusted contributors. Hardware wallets being sourced.

**Mainnet ceremony:**
```
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_PUBKEY> \
  --upgrade-authority <CURRENT_DEPLOYER_KEY> \
  --url mainnet-beta
```

> **Verify after the change:**
> ```
> solana program show <PROGRAM_ID> --url mainnet-beta
> ```
> The `Upgrade Authority` field should show the Squads vault address.

**Path NOT chosen:** option (b) `--final` lockdown was rejected to preserve the ability to ship security fixes. Same multisig will eventually transfer authority to a DAO (Realms / SPL Governance) on a 24-36 month horizon.

> **Verify after the change:**
> ```
> solana program show <PROGRAM_ID> --url mainnet-beta
> ```
> The `Upgrade Authority` field should show the multisig address (option a) or `none` (option b).

---

## Devnet dry-run (completed 2026-05-19)

The full Squads 2-of-3 ceremony was rehearsed against the live devnet program using `@sqds/multisig` v2.1.4 with three throwaway software signers. **All six phases executed cleanly:**

| Phase | Operation | Mechanism validated |
|---|---|---|
| 1 | Funded 3 test signers from deployer | — |
| 2 | Created multisig (createKey → multisigPda → vaultPda index 0) | Vault PDA derivation, ProgramConfig lookup |
| 3 | `solana program set-upgrade-authority --skip-new-upgrade-authority-signer-check` | PDA can be set as upgrade authority |
| 4 | Funded vault, then 2-of-3 vote on SOL transfer out | Squads create → proposal → 2 approves → execute |
| 5 | `propose_authority(VAULT)` from deployer, `accept_authority()` from vault via Squads | Anchor authority handoff works with vault as new authority |
| 6 | Unwind: vault `propose_authority(deployer)`, deployer `accept_authority()`, vault `SetAuthority(deployer)` on bpf_loader | Authority can be transferred back — no risk of stuck state |

**What this proves for mainnet day:** the on-chain mechanics for §1 (upgrade authority transfer) and §2 (`propose_authority`/`accept_authority`) are correct. The exact same operations against the mainnet program will work the same way, swapping the test signers for the three hardware-wallet pubkeys.

**What this did NOT cover:**
- Hardware-wallet + Squads UI flow (rehearse when Ledgers arrive — that *is* the real ceremony)
- Executing a `bpf_loader_upgradeable::Upgrade` instruction through the vault (i.e. actually shipping a code upgrade via multisig). Not launch-critical; defer until first real upgrade needed.

Scripts and state preserved at `/tmp/squads-dryrun/` for reference. Test signer pubkeys + test multisig (`7SZkb4Sdn5XSej1A534ugL4UPPgN7FoVyKtbw8JE5FVb`) remain on devnet — harmless.

---

## TERM-fee relayer market (design locked 2026-05-23)

**Decision:** instead of a project-operated SOL-paying relayer, ship a permissionless TERM-fee relayer market. Miners sign claims that atomically tip N TERM (out of the mint) to whoever broadcast the tx. Third-party relayers pay SOL gas, capture the TERM tip, swap to SOL via DEX when convenient. Project doesn't run ongoing relayer infrastructure (beyond a bootstrap relayer; see below).

**Why this over SOL-paying relayer:**
- Self-funding market — no ongoing project cost
- Cleaner compliance posture — project isn't intermediating gas payments steady-state
- Permissionless — anyone can compete; fees compress naturally
- Aligned incentives — relayers want TERM price up

### On-chain design (~70 LOC across `claim` + bond paths)

**`claim()` instruction:**
- New parameter: `relayer_tip_term: u64` (0 = self-fund path, unchanged behavior)
- New account: `fee_payer_token_account: Account<TokenAccount>` with Anchor constraint `token::authority = fee_payer` — makes "you pay gas, you get the tip" a structural invariant, not UI-trusted
- After existing mint + burn, atomically transfer `relayer_tip_term` TERM from `user_token_account` to `fee_payer_token_account`
- Guards: `tip ≤ MAX_TIP_TERM` and `tip ≤ net_reward` (preventing UI-malice and underflow respectively)
- New event: `TipPaid { miner, relayer, tip_term }` — observable on-chain for indexers
- **Critical one-line fix in the same diff:** `user_state` in `Claim` changes `payer = authority` → `payer = fee_payer`. Without this, a 0-SOL wallet cannot have UserState initialized — first-claim onboarding via relayer is broken. UserState rent (~0.001 SOL) becomes a permanent leak to fee_payer (UserState has no close instruction; cost is bounded customer-acquisition expense for the bootstrap relayer).

**`MAX_TIP_TERM = 5_000_000` (5 TERM) — HARDCODED, not governance-settable.**

Hardcoded because the cap's job is narrow: it's a UX safety rail against a malicious/buggy frontend tricking users into oversized tips. It's not an economic dial — market competition sets actual tip rates. Permanent immutability removes one perpetual question ("is the cap still appropriate?") and removes one attack surface (one fewer authority knob to phish).

**Launch-post talking points** (publish so the answer is durable):

1. The cap exists for one purpose: prevent malicious/buggy UI from signing `tip = net_reward`, draining the miner's claim. UX safety rail, not economic dial.
2. `tip ≤ net_reward` is the primary constraint always. The cap only bites when net_reward exceeds 5 TERM — i.e. on lucky-block claims (50% of claims, bonus_bits ≥ 1).
3. At MAX_TIP_TERM = 5, worst-case malicious extraction per claim is 5 TERM regardless of jackpot size. On a 256× lucky block (0.4% of claims, net ≈ 840 TERM), an attacker can grab at most 5 TERM (0.6%), not all 840.
4. Honest-tip headroom: at TERM ≈ $0.001 / SOL ≈ $80, honest tip ≈ 0.5 TERM. Cap gives 10× headroom over honest market price in healthy regimes.
5. In extreme regimes (severe congestion + crashed TERM price), cap may bind on honest tips → relayers refuse → users self-fund. Graceful degradation. Acceptable failure mode.
6. Cap dormant at epoch 9 (base 0.006 TERM, max possible net ≈ 1.7 TERM even at bonus_bits = 8). Value holds across the full 50-year emission curve.

### Bond rent_payer (~25 LOC across deposit + withdraw paths)

**Problem:** without tracking who paid bond rent, gasless onboarding creates a griefing attack — relayer pays bond rent for a fresh wallet, miner withdraws bond, miner keeps the SOL refund.

**Design:**
- `BondAccount` gains `rent_payer: Pubkey` field (32 bytes — borsh total grows 17 → 49 bytes; account size 25 → 57 bytes; rent grows ~0.000174 → ~0.000397 SOL)
- `DepositBond` and `DepositBondTerm` gain a `rent_payer: Signer<'info>` slot (separate from `authority`). May equal authority for self-fund. `payer = rent_payer` in init.
- `WithdrawBond` and `WithdrawBondTerm` close to `rent_payer` instead of `authority`. `has_one = rent_payer @ ErrorCode::WrongRentPayer` enforces the rent_payer pubkey matches what was recorded at deposit.
- `authority` still signs withdrawal (binds PDA seed); `rent_payer` is a passive `SystemAccount` recipient.
- **Self-fund mode is transparent**: same keypair signs both slots, Solana de-dupes the signature.

**Known unfixed parallel:** ATA rent (~0.002 SOL) is owned by the miner and refunded to them on close, regardless of who paid creation. This is structural to SPL Token, not fixable cleanly without breaking the "user owns their TERM" model. Bounded per-wallet cost, accepted as known cost (documented for bootstrap relayer operators).

### Devnet upgrade approach

**Decision: reset + announce, no migration instruction.**

The `BondAccount` layout change (25 → 57 bytes) makes existing devnet bonds undeserializable, which breaks `Claim`/`Withdraw` for affected wallets. Two paths considered:

- ❌ **Add `migrate_bond_account()` ix** — rejected. Adds ~30 LOC of permanent program surface for a one-time devnet inconvenience. Mainnet doesn't need it (starts fresh). The cost-benefit doesn't pay off.
- ✅ **Reset + announce** — adopted. Pre-announce upgrade in testers channel. Affected miners re-deposit bond after upgrade. Each strands 0.001 SOL of old-bond rent (devnet, $0 cost). Old bond PDAs become inert. UI surface: detect deserialization failure on `Claim`, route to deposit flow with "Re-bond required" prompt.

Devnet upgrade day doubles as the first real Squads-multisig program upgrade rehearsal (we transferred upgrade authority back to deployer during the dry-run; will need to re-transfer to a real multisig before this upgrade, or push the upgrade from the deployer wallet directly).

Mainnet: nothing special. New program deploys with new layout on day 0.

### Bootstrap relayer (operational plan)

A project-operated time-boxed bootstrap relayer bridges the gap until community relayers come online (or until the project decides the relayer market should be permanently subsidy-only as a long-tail).

**Operator:** project (Aaron), Vercel functions, extending existing `miner-ui/api/relay.ts` infrastructure.

**Duration:** 90 days active + 30 days deprecation tail = **120 days total**.

**Tip policy:**
- **First-claim subsidy** — accepts `relayer_tip_term = 0` only for wallets where `UserState` PDA doesn't exist yet, OR exists with `last_claim_time == 0` (defensive belt-and-suspenders). After first claim, this wallet must pay tips like any other.
- **MIN_BOOTSTRAP_TIP = 0.5 TERM** (static) for all non-first claims. Below this, the relayer returns a friendly 429 with "tip below floor; self-fund or use a community relayer." Dynamic gas-pricing version (`baseline_gas × 1.2 / TERM_price`) is more correct but unnecessary operational complexity for a 120-day window.

**Per-wallet onboarding cost reality check:**

| Item | Amount | Refundable? |
|---|---|---|
| Bond rent | ~0.001 SOL | Yes (via `rent_payer`) |
| UserState rent | ~0.001 SOL | No (permanent leak to fee_payer) |
| ATA rent | ~0.002 SOL | Refundable to user on close (leakable to user, not griefable by relayer beyond ATA close) |
| Tx gas | ~0.0004 SOL | No |
| **Total** | **~0.004 SOL ≈ $0.34** at $80/SOL | |

**Capacity / cost ceiling:** at 1 SOL/day cap and ~0.004 SOL/wallet onboarding cost, ~250 wallets/day capacity. Over 90 days, ~22,500 wallet ceiling. Worst-case relayer bleed ~$3,000 leakable + gas; expect $1-2k actual. **Budget: $5k of operational SOL (conservative).**

**Sybil gates:** same KV pattern already deployed (per-wallet quota, per-IP rate limit, daily SOL spend cap). No on-chain change.

**Sunset signaling:**
- Days 1-76 (active): `deprecation: null` in every API response
- Days 76-90 (active, with warning): `deprecation: { sunset_date, days_remaining: N, message: "..." }` in every API response. UI renders a banner.
- Day 91+: paid-relay endpoint returns `410 Gone` with pointer to alternatives. First-claim subsidy endpoint continues if contingency triggers.
- Day 121: hard cutover. Full shutdown unless contingency.

**Early-sunset override:** if ≥2 non-project relayers operate profitably for ≥21 consecutive days (observable via `TipPaid` events with `relayer != project_wallet`), project may announce early shutdown with 7-day notice.

**Onboarding tx (single tx, atomically):**
1. `deposit_bond` — `rent_payer = bootstrap_relayer`, `authority = miner`. Bond rent refundable on withdraw.
2. `createAssociatedTokenAccountIdempotent` — payer = bootstrap_relayer. ATA rent leakable to user.
3. `claim` with `relayer_tip_term = 0`, `fee_payer = bootstrap_relayer`, `fee_payer_token_account = bootstrap_relayer's ATA` (recipient of the 0-TERM tip, no-op transfer).

Three logical signers (relayer-as-fee_payer, relayer-as-rent_payer, user-as-authority); two unique signatures since Solana de-dupes by pubkey.

**Contingency plan — if no community relayer emerges by day 90:**

Real possibility. TERM may not be valuable enough for community-relayer spread to be profitable. Default fallback: project keeps the **first-claim subsidy only** running indefinitely at ~$14/day-equivalent (~0.17 SOL/day). Cheap enough to sustain solo. Reframe at 1-year mark. Paid-relay endpoint stays shut after day 121 regardless. This is NOT the announced plan; it's the silent contingency if community emergence fails.

### Liquidity seeding

**Decision:** seed Raydium CPMM with **5 SOL + 5M TERM** (implied price ~$0.00008/TERM, compute-cost-adjacent), burn the LP tokens at creation. Atomic with public mining open.

**Why these specific numbers:**
- **5M TERM = 0.5% of total supply** — drawn from team's day-0 vesting tranche (50M TERM unlocked at launch; this uses 10% of that tranche)
- **5 SOL ≈ $400** — well under launch operational budget, not a meaningful capital outlay
- **$0.00008/TERM implied price** — compute-cost-adjacent (CPU miner spends ~$0.0001 to mine ~16 TERM EV → break-even ~$0.000006/TERM; seed price is ~13× compute cost, leaving headroom for any organic demand)
- **Implied FDV at seed: ~$80k** — defensibly conservative for an unproven asset, characterizable as "we seeded near production cost, let the market discover upward"

**Why this beats the alternatives:**
- ❌ "No seed at all" — defensible, but leaves the TERM-fee relayer market dormant until someone else creates a pool. Could be week 1, could be never. $400 buys "relayer market viable from day 1."
- ❌ "Seed at $0.016/TERM" (earlier plan) — implied $16M FDV. Arb bots would drain the SOL out of the pool as price discovered downward to compute-cost-adjacent levels. Wealth transfer to arbitrageurs. **Avoided.**
- ❌ "12-month LP timelock" (earlier plan) — illusory optionality (capital-constrained team won't realistically rebalance). Burn forecloses the decision and is unequivocal.

**Asymmetric risk reasoning:** under-pricing the seed has bounded downside (if true price is higher, arbs buy TERM from pool → we gain SOL → "loss" is in TERM, which is our natural exposure). Over-pricing has unbounded downside (arbs sell TERM to pool → we lose SOL → SOL hard to recover). Compute-cost anchor under-prices on purpose.

**Pool:** Raydium CPMM (xy=k). Largest TVL on Solana, most aggregator routing (Jupiter integrates by default), simplest UX. CLMM/Whirlpool migration is a v1.1 question once depth grows enough to justify range management.

**Timing:** seed atomically with public mining open. Don't give team or insiders any pre-pool trading window — that's the worst possible launch optic.

**LP token management:** burn at creation. Permanent. No future operational burden. If the pool structure proves wrong later, additional LP can be added separately; the burned LP stays locked.

**Contingency if TERM has no demand:** worst case, the $400 of SOL stays in the pool forever, available to traders who want to trade TERM cheaply. No loss recoverable, no further intervention possible. Acceptable bounded loss.

### Status

- Design: ✅ complete (this section)
- Code: ⏳ not yet written (separate work item)
- Tests: ⏳ list specified in design notes
- Devnet rollout: ⏳ pending implementation
- External audit: must include this scope
- Bootstrap relayer infra: ⏳ extends existing `miner-ui/api/relay.ts` once on-chain code is implemented
- Liquidity seeding: ⏳ day-0 launch action, executed atomically with mining open

---

## 2. Program authority + freeze authority

The program-level `authority` (separate from the Solana upgrade authority) controls `set_paused`, `set_rate_limit`, `disable_freeze_authority`, `propose_authority`, etc.

**Decision (2026-05-18):** the SAME Squads vault from §1 holds both the upgrade authority AND the program `authority`. (Same signers, same threshold — keeps governance surface small.)

**Pre-launch ceremony:**
- [ ] Use `propose_authority(SQUADS_VAULT)` from the current deployer key
- [ ] `accept_authority()` from the Squads vault (requires 2-of-3 signers)
- [ ] Verify on-chain: read GlobalState, confirm `authority == SQUADS_VAULT`

**Freeze authority decision (2026-05-18):** hold at launch (on the multisig), burn after launch. Plan:
- Day 0–N: `freeze_authority == SQUADS_VAULT` (lever available for emergency Sybil response)
- Day ≥30 of mainnet operation, assuming no critical incident: multisig signs `disable_freeze_authority()` — one-way, permanent
- After that, the program is censorship-proof: no key, multisig, or DAO can freeze any wallet

**Freeze scope (audited 2026-05-31):** the `frozen` flag is checked by `claim` and `claim_yield`. Other handlers are intentionally left open:
- `stake` / `unstake` / `withdraw_bond*` — only move pre-existing principal. Blocking would seize assets rather than stop earning, which is hostile and out of scope for a Sybil flag.
- `deposit_bond*` — meaningless without `claim`, which is already blocked.
- `claim_team_vest` — gated by `has_one = team_wallet`; not user-facing.

Rationale: freeze is a "stop further earning" lever, not an asset freeze. `claim_yield` had to be added explicitly because a frozen wallet that pre-staked would otherwise keep accruing yield from other miners' claims and could extract it post-freeze.

---

## 3. Deployer wallet hygiene

- [ ] **Mainnet deployer must be a fresh hardware-wallet keypair** — not the devnet wallet, which has been used in scripts/CI/etc.
- [ ] Wallet has ≥4 SOL of mainnet SOL
- [ ] After deploy, the deployer keypair file should be moved off-line (cold storage)

---

## 4. Token metadata

- [ ] Logo PNG, ≥512×512, ≤200 KB
- [ ] Metaplex JSON uploaded to **Arweave** (not GitHub/jsdelivr — those expire; Arweave is permanent)
- [ ] `yarn metadata --uri <ARWEAVE_URL>` after init sequence

---

## 5. Security audit

- [ ] External audit completed (Neodyme / OtterSec / Halborn typical for Solana programs at this complexity)
- [ ] All critical and high findings resolved
- [ ] Audit report published

---

## 6. Closed beta on devnet

- [ ] At least 30 days of devnet operation with multiple miners
- [ ] No critical bugs reported
- [ ] Difficulty adjustment observed working under varying load
- [ ] Bond deposit/withdrawal flows exercised by external testers

---

## 7. miner-ui hosting

- [ ] Production build deployed to Vercel/Netlify/Cloudflare Pages
- [ ] `VITE_RPC_URL` points to a private RPC (Helius/QuickNode/Triton — public mainnet RPC is rate-limited)
- [ ] Custom domain wired up

### UX / onboarding (new-user friendliness)

- [x] **In-UI FAQ** explaining every option in plain language: routing modes (AUTO / SELF-FUND / SHARED / LOCAL), the RELAYERS panel (relayer list, ● ready / ○ down, ★ auto / 📌 pin, add-relayer URL), claim tips (the floor + presets), burner vs Phantom wallets, and the anti-Sybil bond. New crypto users need this in-context, not buried in external docs.
- [x] **One-click start for newcomers** — opening the page and pressing **Start mining** should Just Work with everything on AUTO: auto-generate a burner when no wallet is connected, keep `modePreference = AUTO`, and route automatically (relayer for a 0-SOL burner). Goal: zero config and zero crypto knowledge required to begin mining.
- [ ] **Load distribution across ≥2 production relayers** (deferred; not testable until a second production relayer exists). Relayer selection is currently deterministic *prefer-home* — cheapest-feasible, near-ties broken toward the bundled/same-origin relayer; the randomized weighting in `selectCheapest` was removed as dead code. When a second relayer is real, design a ranking signal (health / least-loaded / reputation) and implement it as a STABLE per-probe choice held in state — **never a render-time `Math.random`** (selection runs in App's render body, so random there re-rolls the relayer on every re-render).

---

## 8. Communications

- [ ] Discord server live
- [ ] X/Twitter account live
- [ ] Landing page (description, tokenomics, mining instructions, links to UI/explorer)
- [ ] Initial announcement post drafted

---

## 9. Final verification (after deploy, before announcement)

- [ ] Run a sanity claim from a fresh wallet on mainnet
- [ ] Confirm metadata appears correctly in Phantom and Solscan
- [ ] Confirm `solana program show <PROGRAM_ID>` shows the expected upgrade authority
- [ ] Confirm `getAccountInfo` for GlobalState shows expected values (initial difficulty, total_minted = 100M reserved for team, etc.)
- [ ] Verify miner-ui can connect, derive PDAs, and submit a real claim

---

**Reminder:** the upgrade-authority sunset (item 1) is the single most important step. It is the difference between a credibly trustless token and a token that the deployer can rewrite at will. Do not skip it.
