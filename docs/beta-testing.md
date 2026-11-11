# Devnet beta: tester guide

Terminus Coin (TERM) is a token you mine in a web page. Your browser solves a small proof-of-work puzzle, and a program on Solana pays TERM for each solution. Before it goes to mainnet we want people who did not build it to use it and tell us what breaks, and what confuses them.

- **Site:** <https://terminus-coin.vercel.app>
- **Report a problem:** [beta bug report form](https://github.com/TermiMiner/Terminus-Coin/issues/new?template=bug_report.yml)
- **Time needed:** 20 to 30 minutes covers the basics. Longer runs are welcome.

**What this is.** A test on devnet, Solana's test network. Devnet SOL and devnet TERM are play money. They have no value, and nothing you mine here carries over to mainnet.

**What this is not.** It is not paid, in tokens or anything else, and it is not an airdrop. All of TERM's supply is already spoken for (90% for mining, 10% for the team), so there is no pool to pay testers from, and we would rather say so than hint at one. If a report of yours leads to a change and you want the credit, say so in the report and we will name you, or your handle, in the launch post.

**Unaudited.** The program has not had an external security audit yet. That is one reason this beta exists.

## Before you start

1. **Use a wallet with nothing real in it.** The simplest is the "burner" wallet the site makes for you. If you connect Phantom, Solflare or Backpack instead, use a new, empty account.
2. **Do not paste in a private key that controls real funds.** A Solana key is the same key on devnet and mainnet. `[ IMPORT BURNER ]` keeps the key you paste in this browser's storage, where a browser extension, or anyone else using the computer, could read it. The in-app help explains how to import a Phantom key so that it can mine. For this beta, do that only with a throwaway account.
3. **The site never asks for a seed phrase.** If something does, close the tab and tell us.
4. **Check the bottom line of the page.** It should say `Cluster: devnet`. It can say `unknown` for a moment while the page loads. If it says `mainnet`, stop and report it.

## Start mining

1. Open the site. A desktop browser is the easiest place to start.
2. Press **`[ START MINING ]`**. With no wallet connected, the site makes a burner wallet and starts by itself. You need no SOL: a relayer pays the network fees, and can take a small TERM tip out of each claim in return. The `CLAIM TIP` line under `ROUTING` shows how much.
3. Watch the log on the MINE tab. One round looks like this:

   ```
   Starting round — difficulty=…
   Found nonce … in … attempts
   Submitting claim…
   First mine — also depositing 0.001 SOL bond.        (first claim only)
   Claimed! tx=… — Bonus +0 bits → ~3.40 TERM gross
   ```

4. Your SOL and TERM balances are at the top of the page, after `BALANCE:`.
5. Press **`[ STOP ]`** when you are done. The burner stays in this browser, so the same wallet is there when you come back.

## What to try

Pick whatever interests you. Nobody needs to do all of it. The question is always the same: did it do what the page led you to expect?

**Mining**

- Start from nothing, as above. Then do it again in another browser, or on a phone.
- Let it run for 15 minutes or more. Does it keep landing claims, or does it stall?
- Interrupt it: switch tabs, lock the phone, close the laptop lid, turn Wi-Fi off and on. Does it pick up again without help?
- Reload the page, and open the site in a second tab. Is the same wallet there? What happens when two tabs mine at once?

**Wallets.** This is where we most need other people's hardware.

- Connect Phantom, Solflare or Backpack with the `Select Wallet` button, with a Ledger behind it if you have one. Set the wallet's network to devnet first. In Phantom that is Settings → Developer Settings → Testnet Mode.
- With SOL in it, an outside wallet pays its own fees. With none, `AUTO` sends its claims through the relayer. Try both if you can: devnet SOL is free at <https://faucet.solana.com>.
- Mine a few claims. Tell us which wallet and version you used, what each approval prompt said, and how many claims landed.

**Routing and relayers.** Open the `ROUTING` section near the top.

- `[ SELF-FUND ]` with a burner: the `MODE` line offers `[ TOP UP BURNER ]`, which sends the burner a little SOL so that it can pay its own fees. Each wallet gets one top-up.
- `[ SHARED ]`: always go through the relayer. Try the `CLAIM TIP` presets. A higher tip should leave you less TERM from each claim.
- `RELAYERS`: `[ PIN ]` the relayer, then un-pin it with `[ AUTO ]`. Add a made-up `https://` address with `[ + ADD ]`. It should show `○ down`, and `[ × ]` should remove it.

**Withdraw TERM.** Open `WITHDRAW TERM` on the MINE tab.

- Send some TERM to another wallet you control. Did it arrive? Was the confirmation clear about what would be sent, and where?
- Try things that should be refused: this wallet's own address, the address of a token account, an amount above your balance.

**Staking.** The STAKE tab.

- Stake some TERM, leave mining running, and watch `Pending yield` grow as claims land. Then try `[ CLAIM YIELD ]` and `[ UNSTAKE ]`. A burner needs a little SOL for its first stake; see [below](#expected-behavior-not-a-bug).
- Do the figures under `POSITION` add up before and after each step?

**Keys**

- Press `[ EXPORT KEY ]` and copy the key somewhere. `[ CLEAR ]` the burner, then press `[ IMPORT BURNER ]` and paste the key back. The same address and balances should return.
- On the HELP tab, press `[ REVEAL PRIVATE KEY ]` and import that key into Phantom as the help text describes. Does Phantom show the wallet and its TERM once it is set to devnet?

**The words**

- Read the HELP tab and the labels as someone who has never mined. What was unclear? What sounded alarming? What turned out to be wrong? This is as useful to us as a crash.

## Expected behavior, not a bug

Reading this list first will save you a report.

**While mining**

- **One claim a minute per wallet.** The program limits each wallet on devnet, so the miner solves the puzzle and then waits: `Cooldown — holding 42s before claiming (nonce ready)…`.
- **`Stale nonce` and `Chain advanced … re-mining`.** Every claim that lands, from anyone, changes the puzzle for everyone. If another miner gets in first, your solution is void and the miner starts again. You will see this often while we run load tests. It is a problem only if none of your claims land for a long stretch.
- **Rewards differ from claim to claim.** The base reward is 3.4 TERM, and luck multiplies each claim by 1, 2, 4 and so on up to 256. Half of all claims get the base amount. About one in 256 gets the full 256×.
- **You receive a little less than the "gross" figure in the log.** 3% of every reward is set aside for stakers, and between 0.25% and 5% is burned (0.25% while difficulty is low). When a relayer pays your fees, its tip comes out too.
- **`First mine — also depositing 0.001 SOL bond.`** Every wallet locks a small one-time bond, about 0.0013 SOL, with its first claim. When you mine without SOL, the relayer pays it.
- **`TAB PAUSED`.** Browsers slow down or stop pages that are in the background, and phones stop them when the screen locks. Mining picks up when you return to the tab.
- **Difficulty moves.** The `Difficulty` figure under `STATS` rises when claims across the whole network arrive faster than one every six seconds, and falls when they arrive slower. During load tests it climbs, and each round takes your browser longer.

**With Phantom, Solflare, Backpack or a Ledger**

- **A prompt for every claim.** These wallets ask you to approve each transaction. The burner does not, which is why the site recommends it for mining.
- **Warnings such as "failed to simulate the results of this request".** The wallet tests each transaction before it signs, and a mining claim stops being valid a few seconds after it is made. Claims also go stale while a prompt waits for you.
- **`WALLET NEEDS SOL`.** You chose `[ SELF-FUND ]` for a wallet that holds too little SOL. Its first claim needs about 0.005 SOL.

We still want the detail. A wallet that cannot connect at all, a prompt that shows the wrong network or the wrong amounts, and a claim the page says landed when it did not are all worth a report.

**Things that need SOL in the wallet itself**

A burner that mines through the relayer holds no SOL. Mining works without it, but two things do not:

- **Withdrawing TERM.** The page tells you how much SOL is needed, for example `Need ~0.0029 SOL …`.
- **Your first stake.** It opens a small account that your own wallet pays for, about 0.0015 SOL. Without that, the stake fails with a `Failed: …` message.

To give a burner SOL, choose `[ SELF-FUND ]` under `ROUTING` and press `[ TOP UP BURNER ]`, or send it devnet SOL from <https://faucet.solana.com>. Once a burner holds enough SOL, `AUTO` pays fees from it and stops using the relayer.

**Relayer limits**

The relayer spends its own devnet SOL on your behalf, so it rations it: one top-up per wallet, an hourly limit per network address, and a daily budget. Messages such as `IP rate limit`, `wallet quota reached` and `relayer daily budget exhausted`, or `⚠ no quota` in the `RELAYERS` row, mean a limit was reached. Wait, or switch to `[ SELF-FUND ]` with SOL from the faucet. People on one network (an office, a campus, a VPN) share the hourly limit.

**Everything else**

- **`[ LOCAL ]` is grayed out.** It is for people who run their own relayer in the browser, and it is unavailable while the site's relayer is in use.
- **`Est. APY` on the STAKE tab can be absurdly large.** The estimate assumes the network is mining at full speed and that the staking pool stays the size it is now. With almost nothing staked on devnet, the figure runs to thousands or millions of percent.
- **`Old-format bond detected…`.** Wallets that mined on devnet before the program upgrade of 26 May 2026 cannot mine with the current program. Use a new wallet.
- **`PROGRAM PAUSED`.** The program has an emergency stop, and we may test it during the beta. Mining stops for everyone and resumes by itself. Staking and withdrawals keep working.
- **Devnet goes down.** Solana's devnet is slow at times and is occasionally reset, which wipes every balance. If `Status` under `STATS` shows `RPC UNREACHABLE`, or nothing confirms for anyone, try again later and tell us when it happened.

## Not on the site

- **Getting the bond back.** The program lets a wallet withdraw its bond an hour after its last claim, but the site has no button for it. The help text calls the bond "recoverable later", and that is true of the program, not yet of the site.
- **The TERM bond.** The program also accepts a bond of 20 TERM in place of SOL. The site always uses the SOL bond.
- **Full transaction signatures.** The log shows only the first 16 characters. To get the whole signature, search your wallet address at <https://explorer.solana.com/?cluster=devnet> and copy it from the transaction history.

## Report what you find

Use the [beta bug report form](https://github.com/TermiMiner/Terminus-Coin/issues/new?template=bug_report.yml), one problem per report. The most useful reports have:

- what you did, what you expected, and what happened
- your wallet's public address, which lets us look up what happened on-chain
- the log lines from around the time it went wrong
- the transaction signature, if a transaction was involved
- your browser, device and wallet

The form asks how serious the problem looks. Pick the closest. We set the final level.

| Level | What it means |
|---|---|
| **Critical** | TERM or SOL was lost, stuck, or sent to the wrong wallet. More TERM was created than the rules allow. Someone did something only the project's admin key should be able to do. Mining stopped for everyone and did not come back. |
| **High** | A rule the project states was broken, but nothing was lost: a reward or difficulty change that does not match the [README](../README.md), or a cooldown or limit that did not hold. |
| **Medium** | Something failed or misbehaved, and nothing was lost: an error you could get past by retrying or reloading, or a relayer problem. |
| **Low** | Wording, layout, or anything confusing. |

**Reports are public.** Never put a private key or a seed phrase in one, in the text or in a screenshot.

**If you find a way to take or lock someone else's funds, create TERM out of nothing, or act as the project's admin,** leave the details out of the report. Write one line saying you have a security finding, add a private way to reach you, and we will contact you.

Questions that are not bugs: ask wherever you were invited, or open a blank issue.
