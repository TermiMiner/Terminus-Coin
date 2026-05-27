# Draft announcement for devnet testers

Post this in the testers channel (Discord / X / wherever) — covers the
2026-05-26 program upgrade that changed the BondAccount layout.

A second, shorter version follows for short-form platforms.

---

## Long version

**Devnet program upgrade — May 26**

The devnet TERM program was redeployed yesterday (May 26) with the new
TERM-fee relayer market + `rent_payer` field on `BondAccount`. The new
binary expects a 57-byte bond account; pre-upgrade bonds were 25 bytes,
so the old format is no longer deserializable.

**Who's affected:** any devnet wallet that deposited a bond before
May 26. Your bond PDA still exists on chain, but the new program can't
read it. The 0.001 SOL of rent locked in that bond is stranded
permanently for that wallet.

**To keep mining on devnet:** use a **fresh wallet**. The bond PDA is
derived from your wallet's pubkey, so a new keypair = a new PDA = a
fresh, working bond.

**The UI will detect this** and surface the message *"Old-format bond
detected at this address. The program was upgraded; the old bond's
0.001 SOL is stranded. Please use a fresh wallet to mine."* once you
connect an affected wallet.

**Mainnet is unaffected** — this is a devnet-only artifact of the
upgrade. Mainnet launches fresh with the new layout from day 0.

Apologies for the disruption. The trade-off (versus shipping a one-time
migration instruction) was made deliberately to keep the program's
audit surface minimal and avoid permanent legacy code paths.

---

## Short version (Twitter/X length)

Devnet program redeployed yesterday — old BondAccount layout incompatible
with the new TERM-fee relayer code. Anyone with a pre-May-26 devnet bond:
your 0.001 SOL is stranded, use a fresh wallet to keep mining. UI surfaces
a clear error. Mainnet starts fresh; not an issue there.
