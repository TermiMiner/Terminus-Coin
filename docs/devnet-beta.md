# Devnet closed beta — plan

*Satisfies [`MAINNET_CHECKLIST.md`](../MAINNET_CHECKLIST.md) §6. With the audit moved to the liquidity gate (§5), this beta is the principal pre-deploy assurance.*

## Why this needs a plan at all

§6 asks for "30 days of devnet operation with multiple miners" and "difficulty adjustment observed working under varying load." The second half is not satisfiable by waiting, and the arithmetic says why.

Difficulty holds steady at `TARGET_CLAIMS_PER_WINDOW / TARGET_WINDOW` — 100 claims per 600s, i.e. **one claim every 6 seconds**. The devnet per-wallet rate limit is 60s, so one wallet contributes at most 1 claim/min.

**Holding difficulty flat therefore needs ≥10 wallets mining continuously.** Below that, difficulty falls, though not always by half. A full 600s window with N claims scales it by N/100, and the 2× clamp only stops it falling faster than half per adjustment: it halves at 50 claims per window or fewer (≤5 claims/min), while 8 claims/min takes off 20%. It also adjusts only when a claim lands, so with no mining at all it stays where it is. Under light but continuous mining it halves every 10 minutes and reaches the `MIN_DIFFICULTY` floor of 16 from the initial 4,096 in about **80 minutes**. On 2026-11-22 devnet sat at difficulty 113, where it had stopped when mining did on 2026-11-17.

Ten-plus strangers continuously mining a worthless devnet token is not a realistic recruitment target. So the beta is **driven, not observed**: we generate the load ourselves and use external testers for the things load cannot produce.

## Three tracks

### A. Synthetic baseline — `scripts/devnet_load.ts`

A schedule of claim rates, sent one claim at a time across a pool of wallets funded from the deployer. Keeps difficulty live and makes the network look alive to arriving testers.

**One claim in flight, because only one can land.** Every landed claim rotates `last_hash`, so claims mined against the same state race each other: one lands and the rest fail, and those that get past preflight still pay the fee. Wallets mining in parallel add collisions, not load. So the harness re-reads `last_hash` before every claim, sets load in claims per minute, and keeps a pool only because of the per-wallet rate limit. It reads that limit from chain and sizes the pool for the fastest phase: 24 wallets for 20 claims/min at 60s. Since the harness never collides with itself, a stale-nonce failure means a tester's claim landed first, so the stale rate measures real contention.

The wallet pool persists to `scripts/.devnet-load-wallets.json` so restarts reuse wallets that already hold a bond, ATA and `user_state` instead of paying that rent again.

The harness refuses to run against mainnet-beta (genesis-hash check), the same guard `mainnet-launch.sh` and the relayer endpoints use.

For §6's 30 days it runs unattended on a 31-day schedule: see [Running it for 30 days](#running-it-for-30-days).

### B. External testers — the real signal

5–15 people. Their value is **not** hashrate; it is everything the harness cannot produce:

- wallet variety — Phantom, Solflare, Backpack, Ledger
- browser and OS spread
- the bond deposit, which the site bundles into a wallet's first claim, both self-funded and relayer-paid
- the TERM sweep to a self-custody address
- staking, unstaking and claiming yield
- copy that reads as confusing or alarming to someone who has never mined

What they are sent is [`beta-testing.md`](beta-testing.md): how to start, what to try, and a list of behavior that looks like a bug and is not. Reports come in through the GitHub issue form (`.github/ISSUE_TEMPLATE/bug_report.yml`), whose severity question follows the rubric below. Recruitment drafts are in [`beta-recruitment-post.md`](beta-recruitment-post.md).

**Testers cannot withdraw a bond, or use the TERM bond.** The site has no control for `withdraw_bond`, `deposit_bond_term` or `withdraw_bond_term`; the exit flow was descoped (`MAINNET_CHECKLIST.md` §7). So §6 asks testers for the deposit only, and withdrawal of both kinds is exercised by script (decided 2026-11-17): see [Bond withdrawal check](#bond-withdrawal-check).

**The default path leaves a tester with no SOL, which blocks two things.** A burner that mines through the relayer never holds SOL. Withdrawing TERM needs a little in the wallet, and the site says so. A wallet's first stake does too, because `stake` creates the stake account with `payer = authority`: 0.0015 SOL of rent, plus the minimum the wallet has to keep, 0.0024 SOL in all. Until 2026-11-22 the site did not say so and the stake failed at the relayer's simulation. Now the `STAKE` tab checks before sending, says how much is needed, and offers a burner its top-up.

### C. Evidence collection

Every §6 criterion maps to an event the program already emits, so the checkboxes are mechanically provable rather than a judgment call:

| §6 criterion | Evidence |
|---|---|
| 30 days of operation with multiple miners | `scripts/devnet_status.ts`: distinct miners in the last day, week and month, and claims per day. `ClaimMined` records each claim's miner |
| Difficulty adjustment under varying load | `DifficultyAdjusted` — `old`/`new`/`claims_in_window`/`window_seconds` across the ramp |
| Bond flows exercised: deposit by external testers, withdrawal of both kinds by script | `BondDeposited` from distinct pubkeys outside the team. `BondWithdrawn` of each kind from `scripts/devnet_bond_check.ts`, which checks the event and the balances and prints both signatures |
| No critical bugs reported | Issue tracker plus a written triage rubric (below) |

`devnet_load.ts` writes JSONL (`claim_ok`; `claim_fail` with the program error code and a kind of `stale`, `ratelimit`, `error` or `terminal`; `difficulty`; `phase_start/end` with the target and achieved rate) so a run replays into the table above without a separate indexer. A terminal error (program paused, or supply cap reached) stops the run.

`scripts/devnet_status.ts` reads the chain directly, so it counts testers as well as the harness: whether mining is running, distinct miners in the last day, week and month, claims per day, bonds by kind and by who paid their rent, the deployed build, and the relayer's balance. Distinct miners come from each wallet's `user_state`, which records the time of its last claim, so the counts are exact without reading any transaction. It needs no key and runs anywhere, a cloud session included:

```bash
npx ts-node -P tsconfig.json scripts/devnet_status.ts [--days N] [--json]
```

The harness's wallets are counted apart from everyone else's on any machine: their public keys are listed in `scripts/devnet_load_pubkeys.txt`, and a pool file on the same machine adds its own. A team wallet missing from that list counts as a tester, so add new pools to it. It exits 2 when no claim has landed for `STALE_AFTER_HOURS` (default 3), so a scheduled check can alert on it.

## The load profile

The default phase schedule in `devnet_load.ts`; override with `--phases <file>`. The target is 10 claims/min (100 per 600s window), so each rate is a multiple of it.

| Phase | Claims/min | vs target | Duration | Expected |
|---|---|---|---|---|
| baseline | 10 | 1× | 60m | roughly steady |
| ramp-up | 20 | 2× | 60m | doubles every ~5 min |
| drop | 2 | 0.2× | 60m | halves every 10 min |
| recover | 15 | 1.5× | 60m | ×1.5 every ~7 min |

The 2× clamp applies per adjustment, and an adjustment runs when the window reaches 100 claims or 600 seconds, whichever comes first. At 20 claims/min the window fills in about 5 minutes, so difficulty can double every ~5 minutes: floor to 4,096 is eight doublings, about 40 minutes. A ramp much shorter than that shows only a few adjustments.

The harness mines on one CPU core (about 125k hashes/s on the machine it was tested on), and a claim takes `difficulty` hashes on average. That caps what each rate can sustain: at 20 claims/min there are 3 seconds per claim, so on devnet the climb flattens somewhere around 200k, where the achieved rate falls below target. Starting from the floor, the default ramp tops out near 65k, under that cap. `phase_end` records the achieved rate beside the target. The ceiling belongs to the load generator, not the protocol. A second copy on another core adds hashrate, but give it its own `WALLET_FILE`, `STATE_FILE` and `LOG_FILE` (two copies on one pool file would claim with the same wallets), and expect stale failures between them: the copies still race each other for `last_hash`.

Run the ramp at least twice on different days. One run is an anecdote; two that agree are evidence.

## Running it for 30 days

§6's first criterion needs devnet mining every day for 30 days. Until 2026-11-22 the harness had only been run in sessions: in the 40 days before then devnet saw claims on 7 days, the longest stretch about six hours. `scripts/devnet_load_soak.json` is a 31-day schedule for it:

| When | Load | Why |
|---|---|---|
| Days 1, 8 and 22 | the default ramp above, 4 hours each | difficulty adjustment under varying load: two runs on different days, and a third in case devnet is down during one |
| The rest | 3 claims/min | mining every day, across the whole pool of 24 wallets. Difficulty sits at the floor of 16 between ramps |

It sends about 140,000 claims, about 0.7 SOL in fees.

```bash
RPC_URL=https://api.devnet.solana.com \
DEPLOYER=~/.config/solana/devnet-load-funder.json \
  npx ts-node -P tsconfig.json scripts/devnet_load.ts --phases scripts/devnet_load_soak.json
```

What makes it safe to leave alone:

- **It resumes.** The schedule runs on the clock from its start, which `scripts/.devnet-load-state.json` records. Started again before the 31 days are up, the harness carries on in whichever phase the clock is in; `--restart-schedule` starts it over.
- **It tops up its wallets, within limits.** A pool wallet below 0.002 SOL is topped back up to 0.01 SOL. All funding, a new wallet's first SOL included, counts against `FUNDING_BUDGET_SOL` (default 1.5) for the schedule, and the funding wallet is never taken below `FUNDING_FLOOR_SOL` (default 0.5). When either limit is reached the harness stops and says which.
- **It rides out outages.** After 8 failures in a row that are not the program's, it logs `outage_start`, waits up to 2 minutes between attempts, and logs `outage_end` once a claim gets an answer again.
- **Nothing it waits on can hang.** Each RPC request gives up after 30 seconds (Node's own limit is 5 minutes, which a request on a dead connection waits out in full) and each send after 2 minutes. If the run still goes `WATCHDOG_MINUTES` (default 15) without progress, the watchdog logs `watchdog` and exits 2.
- **It records its own downtime.** When the process didn't run for over a minute, because the host slept or the process was stopped, it logs `clock_gap` with the length. The evidence then tells our downtime apart from devnet's outages.
- **Its exit code tells a deliberate stop from a crash.** It exits 0 when the schedule is over, on Ctrl-C or SIGTERM, when a funding limit is reached and when mining is paused, 1 when it crashes and 2 when the watchdog stops it. So restart it on failure only.

Give it a funding wallet of its own, `~/.config/solana/devnet-load-funder.json` in the commands here. `DEPLOYER` only funds the pool and needs no authority over the program, so a fresh devnet keypair with 2 SOL (the default budget plus the floor) does the job, and the devnet upgrade authority stays off the machine that runs it:

```bash
solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/devnet-load-funder.json
solana airdrop 2 --url devnet --keypair ~/.config/solana/devnet-load-funder.json
```

The public faucet rate-limits airdrops; if it refuses, try again later or use <https://faucet.solana.com>.

Run it on something that stays awake for a month, ideally an always-on Linux machine or a small VPS. A laptop stops the run whenever it sleeps, which for most laptops includes closing the lid. That is what happened to the first long run: started on a laptop on 2026-11-07, it ran four minutes before the lid closed. The laptop's journal shows it asleep from then until 11-15, from 11-15 to 11-16 and from 11-16 to 11-22, which is where the gaps in devnet's record over those weeks come from.

- **Linux with systemd:** a user service, `~/.config/systemd/user/devnet-load.service`. `ExecStart` needs the full path to `npx` (`command -v npx`).
  ```ini
  [Unit]
  Description=Terminus Coin devnet load harness

  [Service]
  WorkingDirectory=/path/to/Terminus-Coin
  Environment=RPC_URL=https://api.devnet.solana.com
  Environment=DEPLOYER=/path/to/devnet-load-funder.json
  ExecStart=/path/to/npx ts-node -P tsconfig.json scripts/devnet_load.ts --phases scripts/devnet_load_soak.json
  Restart=on-failure
  RestartSec=60

  [Install]
  WantedBy=default.target
  ```
  Then `systemctl --user enable --now devnet-load`, and `loginctl enable-linger` so it keeps running after you log out. `journalctl --user -u devnet-load -f` follows it.
- **A Linux laptop:** put `systemd-inhibit --what=sleep:handle-lid-switch` in front of the command, which keeps the machine awake, lid shut or not, for as long as the harness runs. In the user service above:
  ```ini
  ExecStart=/usr/bin/systemd-inhibit --what=sleep:handle-lid-switch --why=devnet-load /path/to/npx ts-node -P tsconfig.json scripts/devnet_load.ts --phases scripts/devnet_load_soak.json
  ```
  Polkit granted the inhibit both from a terminal and from a user service while logged in (checked 2026-11-22 on Ubuntu 24.04). It may refuse a service started before anyone logs in; `systemd-inhibit` then exits with an error, so the service fails rather than running without it.
- **Anywhere else:** inside `tmux` or `screen`, so that it outlives the terminal, with a loop that restarts it after a crash or a watchdog exit. On a Mac, `caffeinate -is` keeps the machine awake while it is plugged in; on a Linux laptop use `systemd-inhibit --what=sleep:handle-lid-switch` in its place.
  ```bash
  caffeinate -is bash -c 'until RPC_URL=https://api.devnet.solana.com \
    DEPLOYER=~/.config/solana/devnet-load-funder.json \
    npx ts-node -P tsconfig.json scripts/devnet_load.ts --phases scripts/devnet_load_soak.json
  do sleep 60; done'
  ```

Check on it from anywhere with `scripts/devnet_status.ts` (Track C), which reads the chain and needs no key.

### The current run

Started **2026-11-23 03:02:53 UTC** on `scripts/devnet_load_soak.json`. The 30 days are done at 2026-12-23 03:02 UTC, and the schedule ends 2026-12-24 03:02 UTC. Its ramps fall on 2026-11-23, 11-30 and 12-14, each 03:02–07:02 UTC.

- **Host:** a DigitalOcean droplet running Ubuntu 24.04, with 1 vCPU and 1 GB, at about $6 a month. It runs the user service above as an unprivileged user, on Node 24, behind a firewall that lets in SSH only. The operator has its address and SSH access; neither is in this repo. Destroy the droplet once the schedule ends: a powered-off droplet still bills.
- **Funding wallet:** `D2LrFMKMn2pHJyXuQV6nbUdvKqg9NojyLUrWZPFUSq72`. It was created on the droplet and never copied off it, and holds 2 devnet SOL from the deployer. Setup moved 0.288 SOL of its 1.5 SOL budget to the pool.
- **Pool:** 24 wallets. They are listed in `scripts/devnet_load_pubkeys.txt` alongside the first pool's, so `devnet_status.ts` counts both as the harness on any machine.
- **The first pool is retired.** It ran from the operator's laptop. Don't run the harness there while this run is on: the two copies would race each other for `last_hash`.
- **Start-up:** the droplet sets wallets up faster than the laptop did, and the burst tripped the public RPC's per-IP limits (`429 … Connection rate limits exceeded`). Setup crashed three times. Each restart resumed the schedule without funding a wallet twice, and mining began at 03:08 UTC. There were no rate-limit errors in its first ten minutes of mining.
- **On the droplet:** `journalctl --user -u devnet-load -f` follows the run, and `devnet-load.jsonl` in the checkout is its event log.

## Bond withdrawal check

`scripts/devnet_bond_check.ts` supplies the withdrawal half of §6's bond criterion, for both kinds of bond, because testers cannot (Track B).

A bond can be withdrawn once `BOND_WITHDRAW_COOLDOWN` (3,600s) has passed since the wallet's last claim. The integration suite cannot show that. Its local validator cannot wait an hour, so it withdraws only bonds that never claimed, whose `last_claim_time` of 0 passes the time check trivially, and shows the refusal while a cooldown is active. The script runs the case a real miner hits: claim, wait the hour, withdraw.

What it does:

1. Creates two throwaway wallets and funds them from the deployer.
2. The first deposits a SOL bond, paying its own rent as a self-funded miner does, and mines until it holds 20 TERM.
3. The second is sent those 20 TERM and deposits them as a TERM bond, with the deployer paying the account rent as the relayer does for a gasless wallet. It then claims once.
4. Confirms by simulation that a withdrawal is refused with `BondLocked` right after each wallet's last claim, and again shortly before the hour is up.
5. Once the chain's clock says the hour has passed, withdraws both bonds and checks each transaction: the rent went back to whoever paid it, the 20 TERM went back to the miner, `BondWithdrawn` was emitted, the bond account is gone, and a second withdrawal is refused.

A check that fails stops the run with a message that starts `FINDING`. By the rubric below, a bond that can be withdrawn early, or cannot be withdrawn after the hour, is a High.

```bash
RPC_URL=https://api.devnet.solana.com \
DEPLOYER=~/.config/solana/devnet-wallet.json \
  npx ts-node -P tsconfig.json scripts/devnet_bond_check.ts
```

It takes a little over an hour, nearly all of it waiting, and about 0.007 SOL. Progress is saved after every step to `scripts/.devnet-bond-check.json`, which is gitignored because it holds the two wallets' secret keys, so a run that is interrupted carries on when started again. It can run while the load harness does: a claim that loses a race to the harness is mined again.

The evidence has to be for the build that ships, which devnet has carried since 2026-11-17. The script prints the slot the program was last deployed in and, when `target/deploy/terminuscoin.so` is present, whether the deployed program is identical to it. At the end it prints one line to record under §6: the date, the two withdrawal signatures and the deploy slot.

## Operating rules

**Treat `programs/terminuscoin/src/lib.rs` and `Cargo.lock` as frozen at `audit-scope-v2`.** The audit is deferred to the liquidity gate, but it will cover the tagged commit — so deploy that build, and keep what is live and what gets audited the same thing. A program bug found in the beta should be fixed before deploy; when one is, re-cut the scope tag (`audit-scope-v3`) so the eventual audit targets the deployed code. The lockfile is frozen with it because a dependency bump changes the binary too: that is what separated v1 from `main` and forced the re-cut. Frontend and relayer fixes are out of audit scope and can ship any time. Devnet has carried the tag's build since 2026-11-17 03:39 UTC. Before that it ran commit `3b10270`, which behaved the same but was not the tag's bytes.

**Fund synthetic wallets from the deployer, not `/api/topup`.** The relayer defaults to `MAX_TOPUPS_PER_IP_PER_HR=5`; a harness starting 20 wallets from one IP throttles itself and consumes quota real testers need.

**Record devnet's own outages.** Solana devnet is periodically reset or congested. A 30-day run will hit downtime that is not our bug, and the evidence log needs to distinguish the two — otherwise a gap looks like an outage we caused. The harness logs `outage_start` and `outage_end` around a stretch of failures that are not the program's.

## Triage rubric — what counts as "critical"

§6 says "no critical bugs reported," which needs a definition agreed *before* findings arrive.

- **Critical** — loss or lock-up of funds; mint beyond the supply cap; a claim that pays the wrong party; authority or freeze state reachable by a non-authority; the program unable to make progress. Blocks mainnet.
- **High** — a documented invariant violated without direct loss; difficulty or emission materially off-schedule; bond recoverable early or not at all. Blocks mainnet unless explicitly accepted in writing.
- **Medium / low** — UX, copy, relayer operations, recoverable client-side errors. Do not block §6.

A critical or high finding in the program resets the "no critical bugs" clock; one in the frontend or relayer does not.

## Dependencies

**§6 needs part of §8.** Testers have to be recruited and their reports collected somewhere. The GitHub issue form now exists; Discord and X are still unchecked. Minimum viable: a Discord server, so that testers have somewhere to ask questions.

**There is no allocation bucket to pay testers from.** Tokenomics is 900M mining + 100M team = 100% of supply; there is no community or airdrop reserve. Promising mainnet TERM for testing would mean taking it from the team tranches or changing the cap — immediately before an audit priced against the current numbers. Offer recognition instead: credit in the launch post, an early-contributor role.

## Timeline

Thirty days from the beta's start is the earliest the deploy gate can close. The audit is no longer on that path — it gates liquidity, not deployment (`MAINNET_CHECKLIST.md` §5).

**The beta is now the critical path to deploy.** Every day it isn't running pushes the earliest mainnet date back by a day.
