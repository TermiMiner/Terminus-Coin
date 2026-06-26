import { useState } from "react";
import type { BrowserKeypairWallet } from "./burnerWallet";

// Plain-language FAQ for novices. Q&A is static; the wording mirrors the in-app
// controls (ROUTE / RELAYERS / CLAIM TIP / bond / lucky-block tiers).
const FAQ: { q: string; a: string }[] = [
  {
    q: "What is Terminus Coin mining?",
    a: "You solve a tiny proof-of-work puzzle in your browser and claim TERM tokens on Solana. No install, no GPU — it runs right here in the page.",
  },
  {
    q: "How do I start? (the fast way)",
    a: "Press START MINING. If you don't have a wallet, it creates a temporary “burner” wallet for you and mines on AUTO — zero setup.",
  },
  {
    q: "What is a burner wallet?",
    a: "A throwaway keypair stored in THIS browser (localStorage). It lets you start instantly and mine gas-free through a relayer. Because the key lives in your browser, treat it as testing-only — see the WALLET section below to move it into a real wallet like Phantom.",
  },
  {
    q: "Burner vs. Phantom — which should I use, and which wallets work?",
    a: "Use a burner to MINE and a real wallet to HOLD. The burner signs instantly in your browser, so it mines non-stop with no pop-ups. Phantom and hardware wallets (Ledger via Phantom/Solflare) are built for custody, not mining — they make you approve and simulate every claim and will often block it with a “failed to simulate” warning, so they're painful to mine with. Think of the burner as a cash drawer: mine into it, then move TERM you actually care about into a wallet you control, regularly — don't let a lot pile up in the browser. TERM is a standard Solana SPL token, so any Solana wallet holds it (Phantom, Solflare, Backpack, Trust Wallet, Coinbase Wallet, Exodus, OKX Wallet, Glow, Ledger). See WALLET below to move a burner across.",
  },
  {
    q: "Can I mine with Phantom or a hardware wallet (Ledger)?",
    a: "Not smoothly. They simulate every transaction before signing and will often block a mining claim with “failed to simulate the results of this request” — a quirk of proof-of-work claims (whose validity changes every few seconds) meeting wallet simulation. To mine a wallet you keep in Phantom, export its private key from Phantom and use IMPORT BURNER at the top of the page — it then mines autonomously like any burner, and Phantom stays perfect for holding and sending the TERM afterward.",
  },
  {
    q: "What do the ROUTE modes mean (AUTO / SELF-FUND / SHARED / LOCAL)?",
    a: "AUTO is the smart default: self-fund if your wallet has SOL, otherwise route through a relayer. SELF-FUND = you pay your own tiny SOL fee per claim. SHARED = a relayer broadcasts and pays the SOL fee for you (gasless); you tip it a little TERM. LOCAL = route through your own in-browser relayer keypair.",
  },
  {
    q: "What is the RELAYERS panel, and what is “pinning”?",
    a: "Relayers broadcast your claim and cover the SOL fee in exchange for a small TERM tip. AUTO routes through the cheapest working one; you can PIN a specific relayer or ADD one by https URL. Status markers: ● ready, ○ down, ⚠ floor too high, ⚠ no quota.",
  },
  {
    q: "What is the CLAIM TIP?",
    a: "When you route through a relayer, you tip it some TERM out of each claim — that's how it covers its SOL costs. The relayer advertises a minimum, and the tip presets are derived from it (and capped at what a claim can actually pay).",
  },
  {
    q: "What is the bond?",
    a: "A one-time anti-Sybil deposit — about 0.001 SOL of account rent — locked the first time a wallet mines. It deters spam and is recoverable later. In gasless mode, the relayer even pays it for you.",
  },
  {
    q: "Why do some claims flash big? What are 🎰 ⭐ ✨?",
    a: "Lucky blocks! Each claim pays base × 2^bonus. Most are base, but you'll occasionally hit ✨ lucky, ⭐ big hit, or 🎰 jackpot (up to 256× the base). The full-screen reveal celebrates it — it's pure chance from the winning hash, same effort either way.",
  },
  {
    q: "What is staking?",
    a: "In the STAKE tab you can stake TERM to earn a share of the treasury — 3% of every claim's reward (plus a small fixed fee per claim) is set aside for stakers and split across everyone staking. Your stake stays yours; unstake anytime.",
  },
  {
    q: "Is my TERM safe?",
    a: "Claimed TERM is minted straight to your wallet's token account on-chain. A relayer can only ever take the tip you set — never your reward or your bond. The one key-safety caveat is the burner: it lives in your browser, so move it to Phantom for anything valuable.",
  },
];

export default function HelpTab({
  burner,
  isBurner,
  walletConnected,
}: {
  burner: BrowserKeypairWallet;
  isBurner: boolean;
  walletConnected: boolean;
}) {
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const key = showKey ? burner.exportAsBase58() : null;

  const copy = () => {
    if (!key) return;
    navigator.clipboard?.writeText(key).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => {},
    );
  };

  return (
    <div className="help">
      <div className="help-h">FAQ</div>
      {FAQ.map(({ q, a }, i) => (
        <div className="faq-item" key={i}>
          <div className="faq-q">{q}</div>
          <div className="faq-a">{a}</div>
        </div>
      ))}

      <div className="help-h">WALLET — move your burner into Phantom</div>
      <div className="faq-a">
        A burner wallet's key lives in this browser only — only as safe as this device.
        Treat it like a <b>cash drawer</b>: move TERM you care about into a wallet you
        control (Phantom, Solflare, Ledger, …) <b>regularly</b>, rather than letting it
        pile up here. To move the whole wallet across, import its key:
      </div>
      <ol className="help-steps">
        <li>Reveal and copy your burner's private key below.</li>
        <li>In Phantom: open the menu → <b>Add / Connect Wallet</b> → <b>Import Private Key</b>.</li>
        <li>Paste the key, name the wallet, and confirm. Your wallet — and any TERM in it — now lives in Phantom.</li>
      </ol>

      {isBurner ? (
        <div className="key-reveal">
          <div className="faq-a" style={{ color: "#ff5555" }}>
            ⚠ Your private key controls the wallet and everything in it. Never share it,
            and never paste it into a site you don't fully trust. Revealing it shows it
            on screen — make sure nobody is watching.
          </div>
          {!showKey ? (
            <button className="btn" onClick={() => setShowKey(true)}>[ REVEAL PRIVATE KEY ]</button>
          ) : (
            <>
              <div className="key-box">{key ?? "(no burner key found)"}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button className="btn" onClick={copy}>[ {copied ? "✓ COPIED" : "COPY"} ]</button>
                <button className="btn" onClick={() => setShowKey(false)}>[ HIDE ]</button>
              </div>
              <div className="faq-a" style={{ marginTop: 6 }}>
                This is <b>base58</b> — the format Phantom's “Import Private Key” expects.
              </div>
            </>
          )}
        </div>
      ) : walletConnected ? (
        <div className="faq-a">
          You're connected with an external wallet (e.g. Phantom) — its keys live in that
          wallet, so there's nothing to export here.
        </div>
      ) : (
        <div className="faq-a">
          No burner wallet yet. Press <b>START MINING</b> (or <b>GENERATE BURNER</b>) to
          create one, then come back here to move it into Phantom.
        </div>
      )}

      <div className="help-h">DISCLAIMER</div>
      <div className="faq-a">
        TERM is an <b>experimental utility token</b> on the Solana network with <b>no
        intrinsic or implied monetary value</b>. It is not an investment, a security, or a
        financial instrument, and it grants no ownership, equity, dividend, yield, or claim
        on any person or entity. Nothing in this application is financial, investment,
        legal, or tax advice.
      </div>
      <div className="faq-a">
        Do not mine, acquire, hold, or transact TERM with any expectation of profit or
        future value — any value it may ever have is determined solely by open markets, if
        any exist, and may be zero. This software is provided <b>“as is,” without
        warranties of any kind</b>; mining, claiming, and transacting carry technical and
        financial risk, up to and including total loss. You alone are responsible for your
        wallet keys, your transactions, and your compliance with the laws of your
        jurisdiction — do not use TERM where it is prohibited. The developers and
        contributors accept no liability for any loss arising from use of this application
        or the TERM token. By using it, you acknowledge and accept these terms and all
        associated risk.
      </div>
    </div>
  );
}
