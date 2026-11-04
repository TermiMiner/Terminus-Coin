# Devnet closed beta — plan

*Satisfies [`MAINNET_CHECKLIST.md`](../MAINNET_CHECKLIST.md) §6. Runs concurrently with the external audit (§5), not after it.*

## Why this needs a plan at all

§6 asks for "30 days of devnet operation with multiple miners" and "difficulty adjustment observed working under varying load." The second half is not satisfiable by waiting, and the arithmetic says why.

Difficulty holds steady at `TARGET_CLAIMS_PER_WINDOW / TARGET_WINDOW` — 100 claims per 600s, i.e. **one claim every 6 seconds**. The devnet per-wallet rate limit is 60s, so one wallet contributes at most 1 claim/min.

**Holding difficulty flat therefore needs ≥10 wallets mining continuously.** Below that every window expires under target, `factor < 1`, and difficulty halves. From the initial 4,096 that is eight halvings to the `MIN_DIFFICULTY` floor of 16 — roughly **80 minutes** — after which it pins and never moves again.

Ten-plus strangers continuously mining a worthless devnet token is not a realistic recruitment target. So the beta is **driven, not observed**: we generate the load ourselves and use external testers for the things load cannot produce.

## Three tracks

### A. Synthetic baseline — `scripts/devnet_load.ts`

N wallets on a phase schedule, self-funded from the deployer, claiming at the rate limit. Keeps difficulty live and makes the network look alive to arriving testers.

The wallet pool persists to `scripts/.devnet-load-wallets.json` so restarts reuse wallets that already hold a bond, ATA and `user_state` — re-creating them each run would waste rent and burn the relayer's per-wallet topup quota.

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

`devnet_load.ts` writes JSONL (`claim_ok`, `claim_fail`, `difficulty`, `phase_start/end`) so a run replays into the table above without a separate indexer.

## The load profile

The default phase schedule in `devnet_load.ts`; override with `--phases <file>`.

| Phase | Wallets | Duration | Expected |
|---|---|---|---|
| baseline | 12 | 60m | difficulty roughly stable |
| ramp-up | 30 | 120m | climbs, bounded 2×/window |
| drop | 2 | 90m | halves each window |
| recover | 12 | 120m | returns toward baseline |

Adjustment is clamped to 2× per 600s window, so a floor-to-4096 climb needs eight sustained windows (~80 minutes). Size ramps accordingly — a 30-minute ramp proves nothing.

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
