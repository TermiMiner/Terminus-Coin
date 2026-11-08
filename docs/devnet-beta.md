# Devnet closed beta — plan

*Satisfies [`MAINNET_CHECKLIST.md`](../MAINNET_CHECKLIST.md) §6. Runs concurrently with the external audit (§5), not after it.*

## Why this needs a plan at all

§6 asks for "30 days of devnet operation with multiple miners" and "difficulty adjustment observed working under varying load." The second half is not satisfiable by waiting, and the arithmetic says why.

Difficulty holds steady at `TARGET_CLAIMS_PER_WINDOW / TARGET_WINDOW` — 100 claims per 600s, i.e. **one claim every 6 seconds**. The devnet per-wallet rate limit is 60s, so one wallet contributes at most 1 claim/min.

**Holding difficulty flat therefore needs ≥10 wallets mining continuously.** Below that, difficulty falls, though not always by half. A full 600s window with N claims scales it by N/100, and the 2× clamp only stops it falling faster than half per adjustment: it halves at 50 claims per window or fewer (≤5 claims/min), while 8 claims/min takes off 20%. It also adjusts only when a claim lands, so with no mining at all it stays where it is. Under light but continuous mining it halves every 10 minutes and reaches the `MIN_DIFFICULTY` floor of 16 from the initial 4,096 in about **80 minutes**. Devnet sits at that floor today (difficulty 16, last claim 2026-10-24; checked 2026-11-07).

Ten-plus strangers continuously mining a worthless devnet token is not a realistic recruitment target. So the beta is **driven, not observed**: we generate the load ourselves and use external testers for the things load cannot produce.

## Three tracks

### A. Synthetic baseline — `scripts/devnet_load.ts`

A schedule of claim rates, sent one claim at a time across a pool of wallets funded from the deployer. Keeps difficulty live and makes the network look alive to arriving testers.

**One claim in flight, because only one can land.** Every landed claim rotates `last_hash`, so claims mined against the same state race each other: one lands and the rest fail, and those that get past preflight still pay the fee. Wallets mining in parallel add collisions, not load. So the harness re-reads `last_hash` before every claim, sets load in claims per minute, and keeps a pool only because of the per-wallet rate limit. It reads that limit from chain and sizes the pool for the fastest phase: 24 wallets for 20 claims/min at 60s. Since the harness never collides with itself, a stale-nonce failure means a tester's claim landed first, so the stale rate measures real contention.

The wallet pool persists to `scripts/.devnet-load-wallets.json` so restarts reuse wallets that already hold a bond, ATA and `user_state` instead of paying that rent again.

The harness refuses to run against mainnet-beta (genesis-hash check), the same guard `mainnet-launch.sh` and the relayer endpoints use.

### B. External testers — the real signal

5–15 people. Their value is **not** hashrate; it is everything the harness cannot produce:

- wallet variety — Phantom, Solflare, Backpack, Ledger
- browser and OS spread
- the bond deposit → cooldown → withdraw cycle, both SOL and TERM bonds
- the TERM sweep to a self-custody address
- copy that reads as confusing or alarming to someone who has never mined

Tell them up front that `BOND_WITHDRAW_COOLDOWN` is 3,600s, so withdrawal is blocked for an hour after their last claim. Otherwise it gets filed as a bug.

### C. Evidence collection

Every §6 criterion maps to an event the program already emits, so the checkboxes are mechanically provable rather than a judgment call:

| §6 criterion | Evidence |
|---|---|
| 30 days of operation with multiple miners | `ClaimMined` — distinct `miner` pubkeys per day, uptime calendar |
| Difficulty adjustment under varying load | `DifficultyAdjusted` — `old`/`new`/`claims_in_window`/`window_seconds` across the ramp |
| Bond deposit/withdrawal exercised by external testers | `BondDeposited` / `BondWithdrawn` — distinct pubkeys, both bond kinds |
| No critical bugs reported | Issue tracker plus a written triage rubric (below) |

`devnet_load.ts` writes JSONL (`claim_ok`; `claim_fail` with the program error code and a kind of `stale`, `ratelimit`, `error` or `terminal`; `difficulty`; `phase_start/end` with the target and achieved rate) so a run replays into the table above without a separate indexer. A terminal error (program paused, or supply cap reached) stops the run.

## The load profile

The default phase schedule in `devnet_load.ts`; override with `--phases <file>`. The target is 10 claims/min (100 per 600s window), so each rate is a multiple of it.

| Phase | Claims/min | vs target | Duration | Expected |
|---|---|---|---|---|
| baseline | 10 | 1× | 60m | roughly steady |
| ramp-up | 20 | 2× | 60m | doubles every ~5 min |
| drop | 2 | 0.2× | 60m | halves every 10 min |
| recover | 15 | 1.5× | 60m | ×1.5 every ~7 min |

The 2× clamp applies per adjustment, and an adjustment runs when the window reaches 100 claims or 600 seconds, whichever comes first. At 20 claims/min the window fills in about 5 minutes, so difficulty can double every ~5 minutes: floor to 4,096 is eight doublings, about 40 minutes. A ramp much shorter than that shows only a few adjustments.

The harness mines on one CPU core (about 125k hashes/s on the machine it was tested on), and a claim takes `difficulty` hashes on average. That caps what each rate can sustain: at 20 claims/min there are 3 seconds per claim, so on devnet the climb flattens somewhere around 200k, where the achieved rate falls below target. Starting from the floor, the default ramp tops out near 65k, under that cap. `phase_end` records the achieved rate beside the target. The ceiling belongs to the load generator, not the protocol. A second copy on another core adds hashrate, but give it its own `WALLET_FILE` and `LOG_FILE` (two copies on one pool file would claim with the same wallets), and expect stale failures between them: the copies still race each other for `last_hash`.

Run the ramp at least twice on different days. One run is an anecdote; two that agree are evidence.

## Operating rules

**Do not change `programs/terminuscoin/src/lib.rs` while the audit is in flight.** The engagement is frozen at tag `audit-scope-v1`; a mid-audit program change invalidates the report and the scope every quote was priced against. Beta findings in the program go into the **remediation round**. Frontend and relayer fixes are out of audit scope and can ship any time.

**Fund synthetic wallets from the deployer, not `/api/topup`.** The relayer defaults to `MAX_TOPUPS_PER_IP_PER_HR=5`; a harness starting 20 wallets from one IP throttles itself and consumes quota real testers need.

**Record devnet's own outages.** Solana devnet is periodically reset or congested. A 30-day run will hit downtime that is not our bug, and the evidence log needs to distinguish the two — otherwise a gap looks like an outage we caused.

## Triage rubric — what counts as "critical"

§6 says "no critical bugs reported," which needs a definition agreed *before* findings arrive.

- **Critical** — loss or lock-up of funds; mint beyond the supply cap; a claim that pays the wrong party; authority or freeze state reachable by a non-authority; the program unable to make progress. Blocks mainnet.
- **High** — a documented invariant violated without direct loss; difficulty or emission materially off-schedule; bond recoverable early or not at all. Blocks mainnet unless explicitly accepted in writing.
- **Medium / low** — UX, copy, relayer operations, recoverable client-side errors. Do not block §6.

A critical or high finding in the program resets the "no critical bugs" clock; one in the frontend or relayer does not.

## Dependencies

**§6 needs part of §8.** Testers have to be recruited and their reports collected somewhere, and Discord/X are still unchecked. Minimum viable: a Discord server plus a GitHub issue template.

**There is no allocation bucket to pay testers from.** Tokenomics is 900M mining + 100M team = 100% of supply; there is no community or airdrop reserve. Promising mainnet TERM for testing would mean taking it from the team tranches or changing the cap — immediately before an audit priced against the current numbers. Offer recognition instead: credit in the launch post, an early-contributor role.

## Timeline

Thirty days from a start in early November completes in early December. The audit runs mid-to-late November through early-to-mid December plus remediation, so the two overlap almost entirely and beta findings can fold into the remediation round rather than becoming post-audit changes.

The audit is the critical path. The beta is not — provided it starts now.
