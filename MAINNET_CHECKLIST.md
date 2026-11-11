# Mainnet launch checklist

Operational items that must be completed before mainnet deploy. Listed in execution order, with the most consequential and irreversible items first. **Do not skip these on launch day.**

> **Two launch gates (decided 2026-11-09).** Mainnet launches in two stages, and this checklist is split between them:
>
> 1. **Deploy** — program live, mining open, **no liquidity pool, explicitly unaudited.** Everything here except §5 and the liquidity seed.
> 2. **Liquidity** — the external audit (§5) is complete and its critical/high findings resolved **before** any TERM market is seeded.
>
> The audit gates *liquidity*, not deployment. A pool is what turns a program bug into SOL leaving our control; without one, an exploit mints tokens nobody can sell. If demand never appears, the pool is never seeded and the audit is never needed. Rationale and accepted risks: §5.

---

## 1. Upgrade-authority sunset (non-reversible)

**Devnet posture:** upgrade authority is *retained* by the deployer wallet (`BmorV43rrjPVfm5pJRvs6d9ytqsx2cxTn656n1J2aNDs`). This is intentional — we need to iterate on the program.

**Decision (2026-05-18):** option (a) — Squads multisig, **2-of-3**, all three signers on hardware wallets. Signers: Aaron + two trusted contributors. Hardware wallets being sourced.

**Mainnet ceremony:**
- [ ] Three hardware wallets in hand, one per signer; all three signers confirmed and reachable on launch day
- [ ] Squads 2-of-3 multisig created on mainnet from those three keys; the vault address recorded, and read back independently by a second signer
- [ ] Hardware-wallet + Squads UI flow rehearsed on devnet with the real devices (the 2026-05-19 dry-run below used software signers)
- [ ] Upgrade authority transferred to the vault:
  ```
  solana program set-upgrade-authority <PROGRAM_ID> \
    --new-upgrade-authority <SQUADS_VAULT_PUBKEY> \
    --upgrade-authority <CURRENT_DEPLOYER_KEY> \
    --skip-new-upgrade-authority-signer-check \
    --url mainnet-beta
  ```
  The vault is a PDA and cannot sign, so the CLI refuses without `--skip-new-upgrade-authority-signer-check` (phase 3 of the dry-run used it; this command previously omitted it). That flag also removes the CLI's only check on the address: a wrong `<SQUADS_VAULT_PUBKEY>` hands the program to nobody, irreversibly. Verify it character by character.
- [ ] `solana program show <PROGRAM_ID> --url mainnet-beta` shows the vault as `Upgrade Authority`

**Path NOT chosen:** option (b) `--final` lockdown was rejected to preserve the ability to ship security fixes. Same multisig will eventually transfer authority to a DAO (Realms / SPL Governance) on a 24-36 month horizon.

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
- Executing a `bpf_loader_upgradeable::Upgrade` instruction through the vault (i.e. actually shipping a code upgrade via multisig). Originally judged not launch-critical. **It is under the two-gate launch (2026-11-09):** post-launch patching now stands in for the pre-launch audit, so the patch path must be proven before mainnet. Now a §2 checkbox.

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

**TERM-tip economics (the income side):** the table above is the relayer's COST side; on mainnet it also EARNS — every non-first claim tips ≥ `MIN_TIP_TERM` (0.5 TERM) into the relayer's own TERM ATA (the `fee_payer_token_account`). So the wallet **drains SOL and accrues TERM**, and the operator loop is two-sided: refill SOL AND periodically **liquidate accumulated TERM tips → SOL** (sell on Raydium) to recover cost. `RELAYER_OPERATOR.md` covers the SOL-out monitoring + daily cap + refill cadence, and now also the **TERM-tip income & liquidation cadence** (documented 2026-07-13, §"TERM-tip income & liquidation").

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

**Decision:** seed Raydium CPMM with **5 SOL + 5M TERM** (implied price ~$0.00008/TERM, compute-cost-adjacent), burn the LP tokens at creation. **Gated on the audit (§5), not on mining open** — see Timing below.

**Why these specific numbers:**
- **5M TERM = 0.5% of total supply** — drawn from team's day-0 vesting tranche (50M TERM unlocked at launch; this uses 10% of that tranche)
- **5 SOL ≈ $400** — well under launch operational budget, not a meaningful capital outlay
- **$0.00008/TERM implied price** — compute-cost-adjacent (CPU miner spends ~$0.0001 to mine ~16 TERM EV → break-even ~$0.000006/TERM; seed price is ~13× compute cost, leaving headroom for any organic demand)
- **Implied FDV at seed: ~$80k** — defensibly conservative for an unproven asset, characterizable as "we seeded near production cost, let the market discover upward"

**Why this beats the alternatives:**
- ❌ "No seed at all" — defensible, but leaves the TERM-fee relayer market dormant until someone else creates a pool. Could be week 1, could be never. $400 buys "relayer market viable from day 1." **→ Accepted for the deploy stage (2026-11-09).** The two-gate launch takes this cost deliberately: until the audited seed, the relayer market is dormant and the project relayer is the only one. It earns TERM tips it cannot sell, so it runs on its SOL budget alone.
- ❌ "Seed at $0.016/TERM" (earlier plan) — implied $16M FDV. Arb bots would drain the SOL out of the pool as price discovered downward to compute-cost-adjacent levels. Wealth transfer to arbitrageurs. **Avoided.**
- ❌ "12-month LP timelock" (earlier plan) — illusory optionality (capital-constrained team won't realistically rebalance). Burn forecloses the decision and is unequivocal.

**Asymmetric risk reasoning:** under-pricing the seed has bounded downside (if true price is higher, arbs buy TERM from pool → we gain SOL → "loss" is in TERM, which is our natural exposure). Over-pricing has unbounded downside (arbs sell TERM to pool → we lose SOL → SOL hard to recover). Compute-cost anchor under-prices on purpose.

**Pool:** Raydium CPMM (xy=k). Largest TVL on Solana, most aggregator routing (Jupiter integrates by default), simplest UX. CLMM/Whirlpool migration is a v1.1 question once depth grows enough to justify range management.

**Timing:** seed only once the audit (§5) is complete — the liquidity gate. The pool still opens atomically with trading: before the seed there is no market at all, so nobody, insiders included, gets a pre-pool trading window.

**Third-party pools break that, and the gate cannot prevent them** — anyone can create a Raydium pool for any token. Two rules follow:
- **A third-party TERM market is itself an audit trigger** (§5). It creates exactly the extractable value the gate exists to prevent, whether or not we seeded it.
- **The team does not sell into a third-party pool before the official seed.** Otherwise the 50M day-0 tranche becomes the insider pre-pool window this section exists to rule out.

**LP token management:** burn at creation. Permanent. No future operational burden. If the pool structure proves wrong later, additional LP can be added separately; the burned LP stays locked.

**Contingency if TERM has no demand:** worst case, the $400 of SOL stays in the pool forever, available to traders who want to trade TERM cheaply. No loss recoverable, no further intervention possible. Acceptable bounded loss.

### Status

*(Corrected 2026-09-13 — the on-chain tip market shipped well before this block was last touched; it previously read "code not yet written", which understated the audit scope.)*

- Design: ✅ complete (this section)
- On-chain code: ✅ shipped — `claim(nonce, relayer_tip_term)`, the `MAX_TIP_TERM` = 5 TERM hard cap, the `tip <= net_reward` invariant, and bond `rent_payer` tracking are all in `programs/terminuscoin/src/lib.rs`
- Tests: ✅ covered in `tests/terminus-coin.ts` — atomic tip transfer alongside the claim, `TipExceedsCap`, `TipExceedsReward`, and the `rent_payer` deposit/withdraw paths
- Devnet rollout: ✅ live (operator runbook proven on devnet 2026-06-12)
- External audit: ⏳ deferred to the liquidity gate (§5) — the tip market stays in scope for it
- Bootstrap relayer infra: ✅ implemented in `miner-ui/api/relay.ts` — `BOOTSTRAP_MODE`, first-claim subsidy, `MIN_TIP_TERM` floor, deprecation signalling; ⏳ mainnet env configuration is still a launch-day step (§7)
- Liquidity seeding: ⏳ gated on the audit — no longer a day-0 action (two-gate launch, top of file)

---

## 2. Program authority + freeze authority

The program-level `authority` (separate from the Solana upgrade authority) controls `set_paused`, `set_rate_limit`, `disable_freeze_authority`, `propose_authority`, etc.

**Decision (2026-05-18):** the SAME Squads vault from §1 holds both the upgrade authority AND the program `authority`. (Same signers, same threshold — keeps governance surface small.)

**Pre-launch ceremony:**
- [ ] Use `propose_authority(SQUADS_VAULT)` from the current deployer key
- [ ] `accept_authority()` from the Squads vault (requires 2-of-3 signers)
- [ ] Verify on-chain: read GlobalState, confirm `authority == SQUADS_VAULT`
- [ ] **Hand over the freeze authority as well** — `propose_freeze_authority(SQUADS_VAULT)` from the deployer key, then `accept_freeze_authority()` from the vault. `initialize` sets *both* authorities to the deployer, and the handoff above moves only the program authority. Without this step the plan below (`freeze_authority == SQUADS_VAULT`) is not true, and a single cold-storage key can freeze any wallet's claims until the sunset.
- [ ] Verify on-chain: `freeze_authority == SQUADS_VAULT`

**Incident-response rehearsal — launch-critical under the two-gate launch.** With no audit before deploy, these two levers *are* the safety net, and both run through the 2-of-3 hardware multisig. Rehearse them with the real Ledgers and time them: a pause that takes six hours to coordinate is not an emergency brake.
- [ ] Emergency `set_paused(true)` signed through the Squads vault end to end, timed. Know what it does **not** stop — see §5, accepted risks.
- [ ] A real program upgrade (`bpf_loader_upgradeable::Upgrade`) executed through the vault on devnet. The 2026-05-19 dry-run skipped this; it is now the only fix for anything the pause can't stop.

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

- [ ] **Mainnet deployer is a fresh keypair *file*, generated for this launch and used for nothing else** — not the devnet wallet, which has been used in scripts/CI/etc. It cannot be a hardware wallet (this line used to ask for one): `mainnet-launch.sh` signs the initialize, vesting and rate-limit steps through AnchorProvider, which cannot sign with a Ledger. The key holds every authority only until §1 and §2 hand them to the hardware multisig, so do those as soon as the script finishes.
- [ ] Wallet has ≥4.5 SOL of mainnet SOL (the launch script refuses to start below that)
- [ ] The deployer keypair file is moved off-line (cold storage) — **after** the §1 and §2 handoffs and the §4 metadata-authority transfer. Until all three are done it still controls something.

### Team wallet — permanent, choose it before launch

`initialize_vesting` records the team wallet exactly once: the account is created with `init`, and no instruction can change it afterwards. That wallet receives 50M TERM at launch and 100M over ten years, and `claim_team_vest` is not stopped by the pause (§5).

- [ ] The team wallet is a multisig vault or a hardware wallet — not a keypair file on a laptop. A lost key strands the 50M that vest from year 5 on; a stolen one claims them. *If it is a Squads vault:* `scripts/claim_team_vest.ts` signs with a keypair file and will not work, so the claim has to be built as a Squads transaction — rehearse one on devnet first.
- [ ] The address passed to `mainnet-launch.sh <TEAM_WALLET_PUBKEY>` has been verified character by character against a second, independent source. A wrong address cannot be corrected.

---

## 4. Token metadata

- [ ] Logo final: ≥512×512, ≤200 KB. The asset in the repo is `metadata/logo.jpg`: 1024×1024 and 202,501 bytes (198 KiB), so right at the size limit. It is a **JPEG** (this line used to say PNG; `metadata/README.md` allows either), and `term.json` declares `image/jpeg`, so a re-export as PNG has to change the declared type too.
- [ ] **`metadata/term.json` finalized before it is uploaded.** An Arweave upload is permanent, and the file still carries devnet-era values:
  - `image` and `properties.files[0].uri` point at jsDelivr — replace with the Arweave URL of the logo
  - `extensions.twitter` and `extensions.discord` are empty — fill in once §8's accounts exist
  - `external_url` and `extensions.website` say `terminuscoin.xyz` — confirm that domain is registered and is the one §7 wires up
  - `description` says "Per-wallet two-step authority transfer"; the two-step transfer applies to the program and freeze authorities, not to wallets
- [ ] Metaplex JSON uploaded to **Arweave** (not GitHub/jsdelivr — those expire; Arweave is permanent)
- [ ] Attach metadata after the init sequence — call the script DIRECTLY, never `yarn metadata` (the yarn script hardcodes localhost/devnet env, and that inline assignment overrides any prefix, so it silently targets the wrong cluster):
  ```
  ANCHOR_PROVIDER_URL=<mainnet-rpc> ANCHOR_WALLET=<deployer-keypair.json> \
    npx ts-node -P tsconfig.json scripts/create_metadata.ts --uri <ARWEAVE_URL>
  ```
  (This is the exact command `mainnet-launch.sh` prints when `METADATA_URI` is deferred.)
- [ ] **Metaplex update authority moved off the deployer key.** `create_metadata` makes its caller the update authority, and `mainnet-launch.sh` runs it as the deployer, before the §2 handoff — which moves the program authority, not this one. Left alone, a single cold-storage key can rename the token or swap its logo at any time. Transfer the update authority to the Squads vault before the deployer key is retired. (If metadata is attached *after* §2 instead, only the vault can call `create_metadata`, and the vault holds the update authority from the start.)

---

## 5. Security audit — gates liquidity, not deployment

**Decision (2026-11-09):** the audit moves from a pre-deploy requirement to the **liquidity gate** (top of file). Deploy unaudited, with mining open and no pool; audit before any TERM market is seeded.

**Why:** a miner risks almost nothing — a ~0.001 SOL bond and compute — so the usual case for an audit, protecting user funds, is weak before a market exists. The program is upgradeable (§1), so bugs found later are patchable. And the cost is out of proportion to the project's scale before traction. A Sec3 quote was received 2026-11-01 (held privately; lapsed 2026-11-08) and is the reference point when the gate is reached.

**Gate — all three before seeding liquidity:**
- [ ] External audit completed
- [ ] All critical and high findings resolved
- [ ] Audit report published

**Triggers — commission the audit at the first of these:**
- [ ] Define the demand signal **before launch** (e.g. sustained distinct miners over N days), so the call isn't made under pressure. *Threshold: TBD.*
- The demand signal is met.
- **Any TERM market appears, including a third-party pool.** That creates the extractable value the gate exists to prevent, whether or not we seeded it.

Trigger to completed audit is realistically **4–6 weeks** — scheduling, two weeks of review, remediation — with value at risk throughout. Commission on the earliest trigger, not the latest.

**Accepted risks of an unaudited deploy:**
- **Irreversibility.** Pause and upgrade stop an exploit; they don't reverse it. TERM minted by an exploit stays minted, in wallets we don't control.
- **`set_paused` covers `claim` only** — it is enforced in exactly one place. Two other instructions also mint and are **not** stopped by it:
  - `claim_yield` — callable by any staker. Bounded by the staking treasury, so a bug drains stakers' yield rather than inflating supply without limit. It computes through `pending_yield`, whose result is cast `as u64` — a truncation, not a saturation. **Tested 2026-11-10** (`tests/property_tests.rs`): the cast cannot drop bits until the exact value reaches 2^64, and the supply cap keeps the program more than 18,000× below that; over the whole input space the function only ever rounds a staker's yield *down*, so it cannot over-mint; and a model of the pool's bookkeeping stays solvent through random histories. That model is a hand-kept copy of the handlers, so the handlers' own lines are still unreviewed.
  - `claim_team_vest` — team wallet only (`has_one = team_wallet`).

  Stopping either takes a program upgrade through the 2-of-3 multisig — hence the §2 rehearsal.
- **Disclosure.** The deploy must be described as unaudited (§8).

**Deploy the `audit-scope-v1` build,** so a later audit covers exactly what is live. If the program must change before deploy, re-cut the scope tag (`audit-scope-v2`) and update `docs/audit-scope-v1.md`; any post-deploy upgrade likewise moves what the audit must cover.

On `main`, `lib.rs` is no longer byte-identical to the tag: a `#[cfg(test)]` block that includes the property tests was appended on 2026-11-10. It is compiled out of the deployed program — CI's build of the program has the same sha256 with and without it — but until the tag is re-cut, build the deploy artifact from a checkout of the tag itself.

**Scope:** on-chain program only — `programs/terminuscoin/src/lib.rs` (~1,880 LOC, ~25 instructions). Frozen as of commit `1256c10` (later commits touch only frontend/relayer, docs and tests — never the program's logic); audit ref is tag `audit-scope-v1` (cut on the merge commit, `lib.rs` byte-identical to `1256c10`). Full reusable scope statement (paste into quote requests): [`docs/audit-scope-v1.md`](docs/audit-scope-v1.md).

> **Scope note:** the relayer-tip market is implemented in `claim()` and is in scope — it materially affects the quote. (§1's Status block previously described it as unwritten; corrected 2026-09-13.)

**Firm shortlist + quote-ask criteria:** see [`docs/audit-scope-v1.md`](docs/audit-scope-v1.md) — the tiered shortlist (budget / contest / premium) and the five quote-ask items live there, so there's a single source of truth.

### Dependency advisories (`npm audit`) — triaged 2026-06-08, re-triaged 2026-07-13

`miner-ui` after `npm audit fix` (non-breaking): **9 production advisories (3 high, 6 moderate)**, all transitive in the Solana SDK / wallet-adapter chain with no non-breaking fix. Triaged, not ignored:

- **3 high — `bigint-buffer` / `@solana/buffer-layout-utils` / `@solana/spl-token`** (buffer overflow in `bigint-buffer`). npm's only offered "fix" is downgrading `@solana/spl-token` to **0.1.8** (pre-0.2 API — would break the app); not viable. `bigint-buffer` (de)serializes fixed-width u64s from program-defined layouts, not attacker-controlled arbitrary-length buffers, so real exposure is low. Upstream-blocked — track `@solana/spl-token` dropping `bigint-buffer`.
- **6 moderate — `@solana/web3.js`, `@coral-xyz/anchor`, `jayson`, `uuid`, `@solana/wallet-adapter-solflare`, `@solflare-wallet/sdk`.** `web3.js`/`anchor`/`jayson`/`uuid` have **no fix**; the solflare pair only "fix" via a breaking downgrade. All transitive; accepted + tracked.
- **Cleared via `npm audit fix` (non-breaking, lockfile-only; build re-verified green each time):** `ws` 8.20.0 → 8.21.0 (uninitialized-memory disclosure, 2026-06-08). **Re-triage 2026-07-13** cleared a *new* `ws` high-sev advisory (`GHSA-96hv-2xvq-fx4p`, memory-exhaustion DoS) plus several build-tooling advisories — the production residual returned to the same **9 (3 high / 6 moderate)** listed above. No shipped-code residual gained a non-breaking fix.
- **Dev-only (NOT shipped):** the `@vercel/node` chain (`undici`, `path-to-regexp`, `minimatch`) and `vite-plugin-node-polyfills` (`elliptic`, `crypto-browserify`) — build/runtime tooling, absent from the browser bundle; the deployed serverless runtime is Vercel-managed.

**For the audit firm:** these are known, upstream-blocked transitive advisories flagged for awareness, not action items — the on-chain program (the audit's real scope) has no npm dependency surface. Re-run `npm audit` at each Solana SDK bump and adopt any that gain a non-breaking fix.

---

## 6. Closed beta on devnet

**Plan:** [`docs/devnet-beta.md`](docs/devnet-beta.md) — tracks, load profile, triage rubric and the §6 evidence mapping. **With the audit moved to the liquidity gate (§5), the beta is the principal pre-deploy assurance and sits on the deploy critical path** — 30 days from its start is the earliest the deploy gate can close.

> The second criterion below is not satisfiable by waiting. Difficulty holds steady only at 100 claims / 600s (one every 6s), and the 60s per-wallet rate limit caps a wallet at 1 claim/min — so **≥10 wallets must mine continuously** just to hold difficulty flat. Below that it falls (by half per window at ≤5 claims/min) to the floor of 16, where devnet sits now. `scripts/devnet_load.ts` drives that load at set claim rates; see the plan.

- [ ] At least 30 days of devnet operation with multiple miners
- [ ] No critical bugs reported
- [ ] Difficulty adjustment observed working under varying load
- [ ] Bond deposit/withdrawal flows exercised by external testers

---

## 7. miner-ui hosting

- [ ] Production build deployed to Vercel/Netlify/Cloudflare Pages
- [ ] **`VITE_RPC_URL` (frontend) → private RPC** — see the runbook below. The public RPC is rate-limited per-IP and 429s a sustained miner.
- [ ] **`RPC_URL` (relayer) → private RPC** — a *separate* key from the frontend's. See the runbook below.
- [ ] **Upstash Redis provisioned for the relayer** — backs the per-wallet quota, per-IP rate limit and daily spend cap. `/api/topup` and `/api/relay` both **fail closed** (503) without it, so a mainnet relayer with no Redis is non-functional rather than drainable. `ALLOW_UNGUARDED_TOPUP` is the devnet-only override and is ignored on mainnet-beta. See [`RELAYER_OPERATOR.md`](./RELAYER_OPERATOR.md) step 4.
- [ ] **Relayer quotas tightened for mainnet** — `MAX_TOPUPS_PER_WALLET=1`, `MAX_DAILY_LAMPORTS` set to the drain you'd accept overnight (0.5 SOL is a sensible start), dedicated funding wallet holding only the operator budget. See `RELAYER_OPERATOR.md` § Hardening for mainnet.
- [ ] Custom domain wired up

### Private RPC setup (runbook — proven on devnet 2026-06-12)

Both the miner UI and the relayer hit Solana RPC, and the **public RPC is rate-limited per-IP** — it 429s a sustained miner (a 30-request burst from a cold IP already lost ~30% to 429s). Two env vars, **two separate keys**:

| Env var | Used by | Vercel scope | Key restriction |
|---|---|---|---|
| `VITE_RPC_URL` | frontend (browser miner) | **Build** (Vite inlines it at build time) | **domain-locked** to the site domain |
| `RPC_URL` | relayer fns (`api/relay`, `topup`, `relayer-info`) | **Runtime** | **unrestricted** (server-side) |

Provider: Helius / Triton / QuickNode (free devnet tiers; paid mainnet tiers). URL form: `https://mainnet.helius-rpc.com/?api-key=<KEY>`.

1. Create **two** keys — one frontend, one relayer.
2. **Frontend key → domain-lock** it to the production domain(s) (Helius: the key → *Allowed Domains*). The frontend key ships in the public JS bundle, so the lock makes a scraped key useless off your domain.
3. **Relayer key → leave unrestricted.** The relayer makes server-side requests with **no `Origin` header**, so a domain-locked key would *block* it (`/api/relayer-info` → 500). ⚠️ Never reuse the domain-locked frontend key for `RPC_URL`.
4. Vercel → Settings → Environment Variables: set `VITE_RPC_URL` (frontend URL, Production scope) and `RPC_URL` (relayer URL).
5. **Redeploy.** `VITE_RPC_URL` is **build-time** — an env edit alone does nothing until a new build bakes it in. (`resolveRpcUrl()` is fail-loud, so a prod build with it unset white-screens rather than silently shipping the public-RPC fallback.)

**Verify (no auth needed):**
- Frontend — fetch the live `index-*.js` and grep for your RPC host (e.g. `helius-rpc.com`): confirms it's off the public RPC, and the bundle hash changing confirms the rebuild landed.
- Relayer — `curl https://<domain>/api/relayer-info` → `HTTP 200` with a `balance` (a successful server-side `getBalance` proves `RPC_URL` works and isn't domain-blocked).

**⚠️ Hardening — domain-lock the public-facing (frontend) key:** `VITE_RPC_URL`'s key is baked into the public JS bundle, so anyone can read it. **Set an Allowed-Domains restriction on the frontend key** (Helius: the key → *Allowed Domains* → your site domain(s)) so a scraped key only works from your origin. Do this **now — devnet included, if not already set**; it's free, and because the relayer uses a *separate* unrestricted key it won't break server-side calls. Re-check after any frontend-key rotation.

**Sizing:** RPC read-load grows ~linearly with concurrent miners (each polls chain state + broadcasts). Free tiers cover devnet / light load; **budget a paid tier for mainnet** and watch the provider's usage dashboard after launch.

**Devnet reference (2026-06-12):** done + verified live — `VITE_RPC_URL` + `RPC_URL` set to two separate Helius devnet keys; bundle confirmed on `devnet.helius-rpc.com`, `/api/relayer-info` 200. Remaining hardening on this devnet setup: confirm the **frontend** key has its Allowed-Domains set (see ⚠️ above) if not already — the relayer key stays unrestricted. Mainnet is the same with mainnet URLs.

### UX / onboarding (new-user friendliness)

- [x] **In-UI FAQ** explaining every option in plain language: routing modes (AUTO / SELF-FUND / SHARED / LOCAL), the RELAYERS panel (relayer list, ● ready / ○ down, ★ auto / 📌 pin, add-relayer URL), claim tips (the floor + presets), burner vs Phantom wallets, and the anti-Sybil bond. New crypto users need this in-context, not buried in external docs.
- [x] **One-click start for newcomers** — opening the page and pressing **Start mining** should Just Work with everything on AUTO: auto-generate a burner when no wallet is connected, keep `modePreference = AUTO`, and route automatically (relayer for a 0-SOL burner). Goal: zero config and zero crypto knowledge required to begin mining.
- [ ] **Load distribution across ≥2 production relayers** (deferred; not testable until a second production relayer exists). Relayer selection is currently deterministic *prefer-home* — cheapest-feasible, near-ties broken toward the bundled/same-origin relayer; the randomized weighting in `selectCheapest` was removed as dead code. When a second relayer is real, design a ranking signal (health / least-loaded / reputation) and implement it as a STABLE per-probe choice held in state — **never a render-time `Math.random`** (selection runs in App's render body, so random there re-rolls the relayer on every re-render).
- [ ] **Cached chain-state endpoint (RPC cost lever)** (deferred) — every miner independently fetches GlobalState (difficulty + `last_hash`) each round, so RPC read-load scales linearly with concurrent miners. Serve a short-cached GlobalState (~1–2s TTL — the stale-nonce retry already tolerates brief staleness) from the relayer so chain-state reads become ~constant regardless of miner count. The single biggest RPC-bill lever at scale.

### Mining wallet & custody — the burner "cash drawer" model

The supported **mining** wallet is the in-browser **burner** (instant local signing, fully autonomous). Phantom / hardware wallets are for **custody, not mining**: they simulate every tx before signing and block ones they can't simulate or that look likely to fail — and a PoW `claim` is fragile to that (validity hinges on a rotating `last_hash`). Devnet shows it as Phantom's *"failed to simulate the results of this request"* (devnet-RPC flakiness / blockhash propagation); on mainnet that eases, but the *staleness* flavor worsens as miner count grows and `last_hash` rotates faster. Net: **Phantom is not a viable continuous miner** — say so in the UI so users don't fight it. (A Phantom-held key can be imported as a burner — **[ IMPORT BURNER ]** accepts Phantom's base58 export — to mine autonomously.)

The burner is a **HOT wallet** (secret key in `localStorage`, readable by any extension/JS on the page). Treat it like a **cash drawer**: mine into it, sweep earnings to real custody regularly, never let large value sit there.

- [x] **In-UI "Withdraw TERM → \<address\>" — DONE** (Phase 1; commit `a501066`, live + on-chain-tested 2026-06-26). Classic SPL `transferChecked` from the wallet's token account to a self-custody destination (Phantom / Solflare / Ledger) — **no key export**; guards a token-account/self destination + SOL sufficiency + an irreversible confirm. **Stopping at Phase 1** — the full-exit bundle + auto-sweep (`docs/term-sweep-scope.md` Phase 2) are **descoped** to avoid feature creep. Legacy **[ EXPORT KEY ]** stays as a power-user fallback. Scope + guards: [`docs/term-sweep-scope.md`](docs/term-sweep-scope.md).
- **Exit cleanup (bond + residual SOL) — descoped** (it's the Phase 2 full-exit we're not building). The ~0.001 SOL bond stays recoverable on-chain via `withdraw_bond` / `withdraw_bond_term` for anyone who wants it; a burner's small residual SOL is left as-is — not worth dedicated UI at this value.
- [ ] **Receiving venue reality:** TERM is a **classic SPL token** (universally supported by Solana wallets), but **unlisted** — a CEX can't accept TERM deposits until it lists the token, so realistic sweep destinations are self-custody wallets (Phantom / Solflare / Ledger).

---

## 8. Communications

- [ ] Discord server live
- [ ] X/Twitter account live
- [ ] Landing page (description, tokenomics, mining instructions, links to UI/explorer)
- [ ] Initial announcement post drafted
- [ ] **Describe the trust model accurately** — the program is **multisig-gated upgradeable** (upgrades require the Squads 2-of-3 hardware multisig, → DAO later per §1), NOT "immutable" / "non-upgradeable." Publish: "no single party can unilaterally change the code; upgrades require 2-of-3 hardware signers." True immutability would be the `--final` path §1 deliberately rejects — don't imply it.
- [ ] **Say "unaudited" plainly** until the liquidity gate (§5) closes — landing page, announcement, and the miner UI. Implying an audit that hasn't happened is worse than not auditing. When the audit lands, publish the report and update this wording the same day.

---

## 9. Final verification (after deploy, before announcement)

- [ ] Run a sanity claim from a fresh wallet on mainnet
- [ ] Confirm metadata appears correctly in Phantom and Solscan
- [ ] Confirm `solana program show <PROGRAM_ID>` shows the expected upgrade authority
- [ ] **Confirm on-chain bytecode == the `audit-scope-v1` build** (there is no audited build yet at the deploy gate; this is the frozen commit any later audit will cover) — `solana program dump <PROGRAM_ID> /tmp/onchain.so --url <RPC>`, then compare `sha256sum` of its first N bytes (N = size of the `anchor build --verifiable` artifact) to that artifact, or run `solana-verify`. `mainnet-launch.sh` does this automatically right after deploy; re-run here if the program was deployed outside the script. (Verifies the *code* — `program show` only checks the authority.)
- [ ] Confirm `getAccountInfo` for GlobalState shows expected values (initial difficulty, total_minted = 100M reserved for team, etc.)
- [ ] Confirm the `initialize` tx logs show the correct economics (`Burn 0.25-5pct | Treasury 3pct`, hard cap, emission, team) — init-log strings audited + corrected 2026-06-06 (commit `54501a4`; only `Burn 1pct` was stale, the rest were already accurate). `initialize` runs **once** — its `init` constraint on GlobalState can never fire again, even across upgrades — so this log is permanent: spot-check the init tx on Solscan before announcing.
- [ ] Verify miner-ui can connect, derive PDAs, and submit a real claim

---

**Reminder:** the upgrade-authority sunset (item 1) is the single most important step. It is the difference between a credibly trustless token and a token that the deployer can rewrite at will. Do not skip it.
