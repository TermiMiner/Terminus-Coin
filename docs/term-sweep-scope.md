# TERM Sweep — build scope (mainnet custody bridge)

Status: **Phase 1 SHIPPED** — commit `a501066`, live + on-chain-tested 2026-06-26.
**Phase 2 is descoped — Phase 1 is the intended stopping point.** The manual sweep
is the whole custody bridge; the extras below aren't worth the added surface area
(deliberate scope discipline). The Phase 2 design is retained only so a future
decision, if one ever arises, starts from a plan rather than a blank page.
Tracked in `MAINNET_CHECKLIST.md` §7 ("Mining wallet & custody").

## Why

Mining runs on an in-browser **burner** (hot wallet, key in `localStorage`). The
only exit today is **[ EXPORT KEY ]** — a power-user fallback where a leaked key
drains the wallet forever. The sweep is the safe default: send mined TERM to a
real wallet you control **without exposing the key**. Treat the burner as a cash
drawer; the sweep empties it.

## Token facts (verified on-chain)

- TERM is a **classic SPL Token** (`Tokenkeg…`, owner of `MINT_PDA`; 82-byte base
  mint, **no token-2022 extensions**), **6 decimals**. (`anchor-spl`'s
  `spl-token-2022` cargo feature is enabled-but-unused — ignore it; this is a
  classic-token transfer.)
- `MINT_PDA` = PDA(`["mint"]`, program). Already exported from `useChainState`.

## Phase 1 — manual "Withdraw TERM → \<address\>"

### Mechanism (classic SPL, hardcode `TOKEN_PROGRAM_ID`)
1. **Source ATA** = `getAssociatedTokenAddressSync(MINT_PDA, owner)` (default =
   classic Token program — the same derivation the miner already uses, proven).
2. **Destination ATA** = `getAssociatedTokenAddressSync(MINT_PDA, destWallet)`.
   If it doesn't exist, prepend `createAssociatedTokenAccountIdempotentInstruction`
   (payer = source wallet).
3. **Transfer** = `createTransferCheckedInstruction(srcAta, MINT_PDA, destAta,
   owner, amountRaw, 6)` — `transferChecked` validates mint + decimals (safer than
   plain `transfer`). **NOTE: this is a NEW import** from `@solana/spl-token`
   (v0.4.13, already a dep) — not currently imported anywhere.
4. **Sign + send** via the active wallet's `signTransaction`, then confirm.
   Burners sign locally and instantly (no Phantom simulation involved — a plain
   transfer is deterministic, unlike a PoW claim, so even a Phantom-connected
   wallet simulates it fine).

### UX (new "WITHDRAW TERM" block, Mine tab)
- Shows the wallet's **liquid** TERM balance (reuse `staking.walletBalance`).
- **Destination** address input · **amount** input + **MAX** button.
- **Success** → tx signature + explorer link.

### Guards (these are the loss-prevention surface — do not skip)
1. **MAX = liquid only.** `staking.walletBalance` is *TERM in the ATA*, **not**
   staked TERM (staked lives in the stake account). Label the control **"MAX
   (liquid balance)"** so a user doesn't think MAX emptied everything — staked +
   bond are excluded (reclaiming them is descoped — see the Phase 2 note).
2. **Destination must be a wallet, not a token account.** If a user pastes an
   **ATA** by mistake, deriving "ATA-of-an-ATA" sends TERM into the void
   (irreversible). Before enabling Send, validate the destination is
   **system-program-owned** (a normal wallet) — reject/warn if it's a token
   account. Put this in the confirm-dialog checks.
3. **Self-destination disabled.** Disable Send when `dest === activeWallet`
   (wasted fee, no-op) — in the UI, not just tests.
4. **Irreversible-action confirm dialog:** amount + **full** destination address +
   "this cannot be undone, double-check the address."
5. **SOL sufficiency:** source pays ~5k lamports fee + ~0.002 SOL dest-ATA rent
   (only when creating). A *gasless-mined* burner may sit near 0 SOL → detect and
   prompt a top-up (reuse the relayer topup) or block with a clear message. A
   self-funded burner already has SOL.
6. **Amount precision:** 6 decimals, BigInt only — reuse the staking input's
   `BigInt(Math.round(n * 1_000_000))` pattern. Never float. Validate `≤` liquid
   balance.

### Implementation surface (small–medium, one branch)
- **New:** `miner-ui/src/sweepTerm.ts` — `buildSweepTx(...)` + send/confirm.
- **Reuse (verified present):** `getAssociatedTokenAddressSync`,
  `createAssociatedTokenAccountIdempotentInstruction` (both already used in
  `useMiner`), `staking.walletBalance`, the staking amount-parse pattern.
- **`confirmOrCheckLanded` is already copy-pasted in 3 files** (`burnerWallet`,
  `useMiner`, `stakingActions`) — **reuse one; do not add a 4th copy.** Ideally
  extract it to a shared util as part of this branch.
- **New import:** `createTransferCheckedInstruction`.
- New UI block in `App.tsx` (Mine tab).

### Testing (devnet)
Sweep burner → second wallet: balance moves, dest ATA auto-created, sig lands.
Cases: insufficient-SOL path; MAX + partial amounts; **destination = an ATA
(must be blocked)**; destination = self (must be disabled); amount > balance.

## Phase 2 — NOT planned (descoped 2026-06-30)

**Deliberately not building these.** Phase 1 covers the custody need; the extra
surface (an on-chain unstake + `withdraw_bond` bundle, and a background auto-sweep
loop) isn't justified — stopping here avoids feature creep. Recorded only as a
starting design if a concrete need ever revives it:

- **"Full exit" one-click:** sweep liquid TERM **+** `withdraw_bond` (reclaim the
  SOL bond) **+** transfer residual SOL to the destination. (Staked TERM must be
  `unstake`d first — surface that.) Bundles the pieces Phase 1 intentionally
  leaves out.
- **Auto-sweep:** "send to a saved address every N claims / on a threshold," so
  the hot wallet stays near-empty during long mining runs. Needs a saved-
  destination setting + a hook in the mining loop.

## Out of scope / notes
- **token-2022:** N/A — TERM is classic SPL. Hardcoding `TOKEN_PROGRAM_ID` for
  Phase 1 is correct and simplest (the program is byte-frozen at
  `audit-scope-v1`). Deriving the token program from the mint owner at runtime is
  nice future-proofing but unnecessary while the mint program can't change.
- **CEX destinations:** TERM is **unlisted** — an exchange can't accept deposits
  until it lists the token. Realistic destinations are self-custody wallets
  (Phantom / Solflare / Ledger). Don't imply CEX deposit works.
