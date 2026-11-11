# Devnet beta: recruitment posts (drafts)

Drafts for finding 5 to 15 outside testers for the devnet beta. The plan is in [`devnet-beta.md`](devnet-beta.md) and what testers are sent is [`beta-testing.md`](beta-testing.md). There are three versions: a long one for Discord or a forum, one for Reddit, and a short one for X.

**Before posting**

- Open the site in a private browser window and confirm that it loads without asking for a Vercel login.
- Start the synthetic load (`scripts/devnet_load.ts`), so that the network a tester arrives at is moving.
- Fill in the two placeholders, `<DISCORD_INVITE>` and `<END_DATE>`.
- The posts say "we". Change it to "I" wherever that is the truth.

**What the posts promise.** Credit in the launch post, and an early-contributor role in the Discord. They promise no tokens, no payment and no airdrop, and they do not suggest that devnet activity will count for anything later. There is no allocation to pay testers from (see the plan), and a hint would be a promise we cannot keep.

**Where to post.** Our own Discord and X first. On Reddit and in other people's communities, read the self-promotion rules before posting and say plainly that you are the developer. A community of developers suits a devnet test request better than a community of traders.

---

## Long version (Discord, forums)

**Terminus Coin devnet beta: testers wanted**

Terminus Coin (TERM) is a proof-of-work token on Solana that you mine in a browser tab. No install and no GPU: the page solves a small puzzle, and a Solana program pays out TERM for each solution. We are getting ready for mainnet, and before that we want people who did not build it to try to break it.

**The ask:** 20 to 30 minutes on devnet. Open the site, press START MINING, then try whatever interests you: your own wallet (Phantom, Solflare, Backpack, a Ledger), staking, withdrawing, a phone. Then tell us what broke and what confused you.

**What we need most:** wallets and devices we do not own, and the eyes of someone who has never seen the page.

**What you get:** credit by name or handle in the launch post if one of your reports leads to a change, and an early-contributor role here. That is all of it. Devnet TERM has no value and does not carry over to mainnet. We are not paying testers in tokens or anything else, and this is not an airdrop.

**Know before you start:**
- It runs on devnet, so everything on it is play money.
- The program has not been audited yet.
- Use the wallet the site creates for you, or a new and empty one. Never a wallet that holds real funds.

Site: https://terminus-coin.vercel.app
Tester guide: https://github.com/TermiMiner/Terminus-Coin/blob/main/docs/beta-testing.md
Report a problem: https://github.com/TermiMiner/Terminus-Coin/issues/new?template=bug_report.yml
Questions: <DISCORD_INVITE>

The beta runs until <END_DATE>.

---

## Reddit version

**Title:** I built a proof-of-work token you mine in a browser tab on Solana. Looking for 10 people to try to break it on devnet (no tokens, no airdrop)

**Body:**

I am the developer, so this is self-promotion. I am asking for testers, not selling anything.

Terminus Coin (TERM) is a proof-of-work SPL token. The mining client is a web page: it solves a keccak puzzle in a worker and submits the solution to an Anchor program, which checks it and mints the reward. Difficulty adjusts on-chain, a relayer covers fees for wallets with no SOL, and there is staking on top. The code is public and the program is not audited yet.

It is on devnet now, and I want people who did not write it to use it before it goes anywhere near mainnet. Twenty to thirty minutes is enough: open the site, press START MINING, then try your own wallet, staking, withdrawing, or a phone. I would most like to hear from people with wallets and devices I do not have (Solflare, Backpack, a Ledger, iOS, Android), and from anyone who can tell me which parts of the page made no sense.

What you get: credit in the launch post if one of your reports leads to a change. Nothing else. Devnet TERM is worthless and does not carry over, there is no airdrop, and I am not paying testers in tokens.

Please use the wallet the site generates, or a new and empty one. Never a wallet that holds real funds.

- Site: https://terminus-coin.vercel.app
- Tester guide, including what is expected behavior and not a bug: https://github.com/TermiMiner/Terminus-Coin/blob/main/docs/beta-testing.md
- Bug report form: https://github.com/TermiMiner/Terminus-Coin/issues/new?template=bug_report.yml
- Source: https://github.com/TermiMiner/Terminus-Coin

Criticism of the design is welcome too.

---

## Short version (X)

Post:

> Testers wanted. Terminus Coin is a proof-of-work token on Solana that you mine in a browser tab, now in devnet beta. Give it 20 minutes, try to break it, tell us what confused you. No tokens and no airdrop, just credit in the launch post. Unaudited. https://terminus-coin.vercel.app

Reply to it:

> Tester guide, including what is expected and what is a bug: https://github.com/TermiMiner/Terminus-Coin/blob/main/docs/beta-testing.md
>
> Report a problem: https://github.com/TermiMiner/Terminus-Coin/issues/new?template=bug_report.yml
