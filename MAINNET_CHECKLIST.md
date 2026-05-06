# Mainnet launch checklist

Operational items that must be completed before mainnet deploy. Listed in execution order, with the most consequential and irreversible items first. **Do not skip these on launch day.**

---

## 1. Upgrade-authority sunset (non-reversible)

**Devnet posture:** upgrade authority is *retained* by the deployer wallet (`BmorV43rrjPVfm5pJRvs6d9ytqsx2cxTn656n1J2aNDs`). This is intentional — we need to iterate on the program.

**Mainnet commitment:** before announcing the mainnet deploy publicly, the upgrade authority **must** be either:

- (a) **Transferred to a multisig** (Squads recommended) where at least 2-of-3 or 3-of-5 signers are required to ship an upgrade. This preserves the ability to ship security fixes while preventing any single key from rugging the program.
  ```
  solana program set-upgrade-authority <PROGRAM_ID> \
    --new-upgrade-authority <SQUADS_VAULT_PUBKEY> \
    --upgrade-authority <CURRENT_DEPLOYER_KEY> \
    --url mainnet-beta
  ```

- (b) **Locked permanently** with `--final` (no future upgrades possible — even by the original deployer). Maximally trustless but you lose the ability to ship any fix or improvement, ever.
  ```
  solana program set-upgrade-authority <PROGRAM_ID> \
    --upgrade-authority <CURRENT_DEPLOYER_KEY> \
    --final \
    --url mainnet-beta
  ```

**Decision required pre-mainnet:** which path? Default is (a) with a Squads multisig. Document the chosen multisig members and threshold here once decided.

> **Verify after the change:**
> ```
> solana program show <PROGRAM_ID> --url mainnet-beta
> ```
> The `Upgrade Authority` field should show the multisig address (option a) or `none` (option b).

---

## 2. Program authority + freeze authority

The program-level `authority` (separate from the Solana upgrade authority) controls `set_paused`, `set_rate_limit`, `disable_freeze_authority`, `propose_authority`, etc.

**Pre-launch:**
- [ ] Use `propose_authority(SQUADS_VAULT)` + `accept_authority()` to move program authority to the multisig
- [ ] Consider calling `disable_freeze_authority()` to permanently remove the freeze capability — this is one-way and reduces censorship surface area to zero. Recommended once the bond + PoW Sybil resistance has been observed in the wild for ≥30 days

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
