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
