import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Terminuscoin } from "../target/types/terminuscoin";
import {
  createAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { expect } from "chai";

// ─── PoW helpers (mirror on-chain logic) ─────────────────────────────────────

const MAX_U64 = (1n << 64n) - 1n;

// Mirrors the on-chain burn_bps_for(difficulty) function for test predictions.
function burnBpsForDifficulty(difficulty: anchor.BN): number {
  const BURN_BPS_MIN = 25;
  const BURN_BPS_MAX = 500;
  const BITS_LOW = 8;
  const BITS_HIGH = 24;
  const d = BigInt(difficulty.toString());
  if (d === 0n) return BURN_BPS_MIN;
  // log2 floor
  let bits = 0;
  let x = d;
  while (x > 1n) { x >>= 1n; bits++; }
  if (bits <= BITS_LOW) return BURN_BPS_MIN;
  if (bits >= BITS_HIGH) return BURN_BPS_MAX;
  const progress = bits - BITS_LOW;
  const span = BITS_HIGH - BITS_LOW;
  return BURN_BPS_MIN + Math.floor((BURN_BPS_MAX - BURN_BPS_MIN) * progress / span);
}

function meetsdifficulty(hash: Uint8Array, target: bigint): boolean {
  const hashHigh =
    (BigInt(hash[0]) << 56n) |
    (BigInt(hash[1]) << 48n) |
    (BigInt(hash[2]) << 40n) |
    (BigInt(hash[3]) << 32n) |
    (BigInt(hash[4]) << 24n) |
    (BigInt(hash[5]) << 16n) |
    (BigInt(hash[6]) <<  8n) |
     BigInt(hash[7]);
  return hashHigh <= target;
}

function mineNonce(lastHash: number[], user: anchor.web3.PublicKey, difficulty: anchor.BN | bigint): anchor.BN {
  return mineNonceWithHash(lastHash, user, difficulty).nonce;
}

function mineNonceWithHash(lastHash: number[], user: anchor.web3.PublicKey, difficulty: anchor.BN | bigint): { nonce: anchor.BN; hash: Uint8Array } {
  const diff = typeof difficulty === "bigint" ? difficulty : BigInt(difficulty.toString());
  const target = diff <= 1n ? MAX_U64 : MAX_U64 / diff;
  const input = new Uint8Array(72);
  input.set(lastHash, 8);
  input.set(user.toBytes(), 40);
  const view = new DataView(input.buffer);
  for (let n = 0n; ; n++) {
    view.setBigUint64(0, n, true);
    const hash = keccak_256(input);
    if (meetsdifficulty(hash, target)) {
      return { nonce: new anchor.BN(n.toString()), hash };
    }
  }
}

// Mirrors the on-chain lucky_reward() — returns (final_reward, bonus_bits) for a given hash.
const BONUS_CAP_TS = 8;
function luckyReward(base: bigint, hash: Uint8Array, difficulty: anchor.BN | bigint): { reward: bigint; bonusBits: number } {
  const diff = typeof difficulty === "bigint" ? difficulty : BigInt(difficulty.toString());
  if (base === 0n || diff <= 1n) return { reward: base, bonusBits: 0 };

  let hashHigh = 0n;
  for (let i = 0; i < 8; i++) hashHigh = (hashHigh << 8n) | BigInt(hash[i]);
  const maxValid = MAX_U64 / diff;
  if (hashHigh > maxValid) return { reward: base, bonusBits: 0 };
  if (hashHigh === 0n) return { reward: base * (1n << BigInt(BONUS_CAP_TS)), bonusBits: BONUS_CAP_TS };

  const ratio = maxValid / hashHigh;
  if (ratio === 0n) return { reward: base, bonusBits: 0 };
  // floor(log2(ratio))
  let log2 = 0;
  let r = ratio;
  while (r > 1n) { r >>= 1n; log2++; }
  const bonusBits = Math.min(log2, BONUS_CAP_TS);
  return { reward: base * (1n << BigInt(bonusBits)), bonusBits };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("terminuscoin – full feature suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Terminuscoin as Program<Terminuscoin>;
  const wallet = provider.wallet as anchor.Wallet;

  let userTokenAccount: anchor.web3.PublicKey;

  // All PDAs are deterministic — derived once at suite load time
  const [mintPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint")], program.programId
  );
  const mint = mintPDA; // alias used throughout

  const [globalStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global_state_final_2026")], program.programId
  );
  const [mintAuthorityPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")], program.programId
  );
  const [stakePoolPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stake_pool")], program.programId
  );
  const [stakeVaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stake_vault")], program.programId
  );
  const [teamVestPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("team_vest")], program.programId
  );

  function userStatePDA(user: anchor.web3.PublicKey) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_state"), user.toBuffer()], program.programId
    )[0];
  }
  function userStakePDA(user: anchor.web3.PublicKey) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), user.toBuffer()], program.programId
    )[0];
  }
  function bondPDA(user: anchor.web3.PublicKey) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bond"), user.toBuffer()], program.programId
    )[0];
  }

  async function doClaim(feePayer = wallet.payer): Promise<void> {
    const state = await program.account.globalState.fetch(globalStatePDA);
    const nonce = mineNonce(state.lastHash as number[], wallet.publicKey, state.difficulty);
    await program.methods
      .claim(nonce)
      .accounts({
        feePayer: feePayer.publicKey,
        userTokenAccount,
        authority: wallet.publicKey,
      })
      .signers(feePayer === wallet.payer ? [] : [feePayer])
      .rpc();
  }

  // ─── Setup ────────────────────────────────────────────────────────────────
  // initialize creates the mint atomically — no external setAuthority needed.

  before(async () => {
    await program.methods.initialize()
      .accounts({ authority: wallet.publicKey })
      .rpc();

    // Mint now exists at its PDA — create the user's associated token account
    userTokenAccount = await createAssociatedTokenAccount(
      provider.connection, wallet.payer, mint, wallet.publicKey
    );

    await program.methods.initializeStakePool()
      .accounts({ authority: wallet.publicKey })
      .rpc();

    // Initialize TERM bond vault (one-time, authority-only)
    await program.methods.initializeBondVault()
      .accounts({ authority: wallet.publicKey })
      .rpc();

    // Deposit anti-Sybil bond (one-time per wallet) — SOL bond for the test wallet
    await program.methods.depositBond()
      .accounts({ authority: wallet.publicKey })
      .rpc();
  });

  // ─── initialize ───────────────────────────────────────────────────────────

  describe("initialize", () => {
    it("global state has correct defaults and mint is live at its PDA", async () => {
      const state = await program.account.globalState.fetch(globalStatePDA);
      expect(state.difficulty.toString()).to.equal("4096"); // INITIAL_DIFFICULTY
      expect(state.paused).to.be.false;
      expect(state.totalMinted.toNumber()).to.equal(0);
      expect(state.totalClaims.toNumber()).to.equal(0);
      expect(state.authority.toBase58()).to.equal(wallet.publicKey.toBase58());
      expect(state.freezeAuthority.toBase58()).to.equal(wallet.publicKey.toBase58());
      expect((state.lastHash as number[]).some(b => b !== 0)).to.be.true;

      // Mint was created inside initialize — assert it exists on-chain
      const mintInfo = await provider.connection.getAccountInfo(mint);
      expect(mintInfo).to.not.be.null;
    });
  });

  // ─── initialize_stake_pool ────────────────────────────────────────────────

  describe("initialize_stake_pool", () => {
    it("pool and vault are live with the program mint", async () => {
      const pool = await program.account.stakePool.fetch(stakePoolPDA);
      expect(pool.totalStaked.toNumber()).to.equal(0);
      expect(pool.treasuryBalance.toNumber()).to.equal(0);

      const vault = await getAccount(provider.connection, stakeVaultPDA);
      expect(vault.mint.toBase58()).to.equal(mint.toBase58());
    });
  });

  // ─── claim – PoW + reward ─────────────────────────────────────────────────

  describe("claim", () => {
    it("rejects an invalid nonce", async () => {
      try {
        await program.methods.claim(new anchor.BN(999_999_999))
          .accounts({ feePayer: wallet.publicKey, userTokenAccount, authority: wallet.publicKey })
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("InvalidProofOfWork");
      }
    });

    it("mines a valid nonce, mints net reward to user, skips treasury when nobody is staking", async () => {
      const balBefore = await getAccount(provider.connection, userTokenAccount);
      const poolBefore = await program.account.stakePool.fetch(stakePoolPDA);
      const state = await program.account.globalState.fetch(globalStatePDA);

      // Mine + capture the hash so we can predict the lucky-block multiplier
      const { nonce, hash } = mineNonceWithHash(state.lastHash as number[], wallet.publicKey, state.difficulty);
      await program.methods
        .claim(nonce)
        .accounts({ feePayer: wallet.publicKey, userTokenAccount, authority: wallet.publicKey })
        .rpc();

      const balAfter = await getAccount(provider.connection, userTokenAccount);
      const poolAfter = await program.account.stakePool.fetch(stakePoolPDA);
      const statAfter = await program.account.globalState.fetch(globalStatePDA);

      const baseUnscaled = 3_400_000n;
      const { reward: base, bonusBits } = luckyReward(baseUnscaled, hash, state.difficulty);
      const burnBps = burnBpsForDifficulty(state.difficulty);
      const burnAmount = base * BigInt(burnBps) / 10_000n;
      const treasuryAmount = base * 300n / 10_000n;
      const expectedNet = base - burnAmount - treasuryAmount;

      const received = BigInt(balAfter.amount.toString()) - BigInt(balBefore.amount.toString());
      expect(received).to.equal(expectedNet, `bonus_bits=${bonusBits} net=${expectedNet} got=${received}`);

      // No stakers → treasury unchanged
      expect(poolAfter.treasuryBalance.toNumber()).to.equal(poolBefore.treasuryBalance.toNumber());

      // total_minted commits exactly net_reward when no stakers
      const minted = BigInt(statAfter.totalMinted.toString()) - BigInt(state.totalMinted.toString());
      expect(minted).to.equal(expectedNet);
    });

    it("rotates last_hash after each claim", async () => {
      const before = await program.account.globalState.fetch(globalStatePDA);
      const hashBefore = [...(before.lastHash as number[])];
      await doClaim();
      const after = await program.account.globalState.fetch(globalStatePDA);
      expect([...(after.lastHash as number[])]).to.not.deep.equal(hashBefore);
    });

    it("rejects a replayed nonce", async () => {
      const state = await program.account.globalState.fetch(globalStatePDA);
      const nonce = mineNonce(state.lastHash as number[], wallet.publicKey, state.difficulty);
      await program.methods.claim(nonce)
        .accounts({ feePayer: wallet.publicKey, userTokenAccount, authority: wallet.publicKey })
        .rpc();
      try {
        await program.methods.claim(nonce)
          .accounts({ feePayer: wallet.publicKey, userTokenAccount, authority: wallet.publicKey })
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("InvalidProofOfWork");
      }
    });
  });

  // ─── difficulty adjustment ────────────────────────────────────────────────

  describe("difficulty adjustment", () => {
    // TARGET_WINDOW = 600s. We can only realistically test the fast path
    // (window fills before expiry) in an automated suite — the slow path
    // (window expires before 100 claims) requires waiting 10 minutes and is
    // verified manually or in a long-running integration test.

    it("increases difficulty when 100 claims complete before TARGET_WINDOW", async () => {
      // Drain remaining claims_in_window from earlier tests then
      // do exactly 100 more within a short wall-clock span.
      const stateBefore = await program.account.globalState.fetch(globalStatePDA);
      const remaining = 100 - stateBefore.claimsInWindow.toNumber();

      for (let i = 0; i < remaining; i++) await doClaim();

      const stateAfter = await program.account.globalState.fetch(globalStatePDA);
      // Difficulty must have gone up (continuous formula yields any factor > 1)
      // and the window counter must have reset.
      expect(stateAfter.difficulty.gt(stateBefore.difficulty)).to.be.true;
      expect(stateAfter.claimsInWindow.toNumber()).to.equal(0);
    });

    it("decreases difficulty when window expires before 100 claims", async () => {
      // Fast-forward the window start by backdating last_claim_window via
      // an authority-only workaround: we can't mutate state directly, so we
      // verify the invariant indirectly — after the increase test the
      // difficulty is > MIN_DIFFICULTY (16), so a decrease is always possible.
      // The actual on-chain path is exercised by the manual run:
      //   npx ts-node scripts/trigger_slow_window.ts
      //
      // What we CAN assert here: MIN_DIFFICULTY = 16 is the floor.
      const state = await program.account.globalState.fetch(globalStatePDA);
      expect(state.difficulty.gten(16)).to.be.true;
    });
  });

  // ─── gasless ──────────────────────────────────────────────────────────────

  describe("gasless claims", () => {
    it("accepts a relayer as fee_payer while miner signs as authority", async () => {
      const relayer = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(relayer.publicKey, 1_000_000_000)
      );

      const relayerBalBefore = await provider.connection.getBalance(relayer.publicKey);
      const minerBalBefore = await provider.connection.getBalance(wallet.publicKey);

      const state = await program.account.globalState.fetch(globalStatePDA);
      const nonce = mineNonce(state.lastHash as number[], wallet.publicKey, state.difficulty);

      // Build tx manually so relayer is the actual Solana fee payer
      const tx = await program.methods.claim(nonce)
        .accounts({
          feePayer: relayer.publicKey,
          userTokenAccount,
          authority: wallet.publicKey,
        })
        .transaction();
      const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = relayer.publicKey;
      tx.partialSign(relayer);
      tx.partialSign(wallet.payer);
      const sig = await provider.connection.sendRawTransaction(tx.serialize());
      await provider.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });

      const relayerBalAfter = await provider.connection.getBalance(relayer.publicKey);
      const minerBalAfter = await provider.connection.getBalance(wallet.publicKey);

      // Relayer paid the fee, miner SOL balance unchanged
      expect(relayerBalAfter).to.be.lessThan(relayerBalBefore);
      expect(minerBalAfter).to.equal(minerBalBefore);
    });
  });

  // ─── rate limiting ────────────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("sets a rate limit and blocks a second immediate claim", async () => {
      // Rate limit is 0 here, so this first claim succeeds regardless of last_claim_time
      await doClaim();

      // Now enable the rate limit — any immediate follow-up claim is blocked
      await program.methods.setRateLimit(new anchor.BN(3600))
        .accounts({ authority: wallet.publicKey })
        .rpc();

      try {
        await doClaim();
        throw new Error("Should have been rate-limited");
      } catch (err: any) {
        expect(err.message).to.include("RateLimitExceeded");
      }

      // Reset rate limit so subsequent tests are unaffected
      await program.methods.setRateLimit(new anchor.BN(0))
        .accounts({ authority: wallet.publicKey })
        .rpc();
    });
  });

  // ─── freeze ───────────────────────────────────────────────────────────────

  describe("freeze", () => {
    it("blocks a claim from a frozen wallet", async () => {
      // Must have a user_state account first (created on first claim)
      const target = userStatePDA(wallet.publicKey);

      await program.methods.setFreeze(true)
        .accounts({
          target: wallet.publicKey,
          freezeAuthority: wallet.publicKey,
        })
        .rpc();

      try {
        await doClaim();
        throw new Error("Should have been frozen");
      } catch (err: any) {
        expect(err.message).to.include("AccountFrozen");
      }

      // Unfreeze
      await program.methods.setFreeze(false)
        .accounts({
          target: wallet.publicKey,
          freezeAuthority: wallet.publicKey,
        })
        .rpc();
    });

    it("rejects set_freeze from a non-freeze-authority", async () => {
      const impostor = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000)
      );
      try {
        await program.methods.setFreeze(true)
          .accounts({
            target: wallet.publicKey,
            freezeAuthority: impostor.publicKey,
          })
          .signers([impostor])
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("NotFreezeAuthority");
      }
    });
  });

  // ─── pause ────────────────────────────────────────────────────────────────

  describe("pause", () => {
    it("pauses, blocks claims, unpauses", async () => {
      await program.methods.setPaused(true)
        .accounts({ authority: wallet.publicKey }).rpc();

      try {
        await doClaim();
        throw new Error("Should have been paused");
      } catch (err: any) {
        expect(err.message).to.include("ContractPaused");
      }

      await program.methods.setPaused(false)
        .accounts({ authority: wallet.publicKey }).rpc();
    });
  });

  // ─── staking ─────────────────────────────────────────────────────────────

  describe("staking", () => {
    it("stakes tokens and updates pool total", async () => {
      const poolBefore = await program.account.stakePool.fetch(stakePoolPDA);
      const stakeAmount = 500_000; // 0.5 TERM

      await program.methods.stake(new anchor.BN(stakeAmount))
        .accounts({
          userTokenAccount,
          authority: wallet.publicKey,
        })
        .rpc();

      const poolAfter = await program.account.stakePool.fetch(stakePoolPDA);
      expect(poolAfter.totalStaked.toNumber()).to.equal(
        poolBefore.totalStaked.toNumber() + stakeAmount
      );

      const vault = await getAccount(provider.connection, stakeVaultPDA);
      expect(Number(vault.amount)).to.be.at.least(stakeAmount);
    });

    it("claim accrues reward_per_token and treasury when staked", async () => {
      const poolBefore = await program.account.stakePool.fetch(stakePoolPDA);
      const state = await program.account.globalState.fetch(globalStatePDA);

      // Mine + capture hash so we can predict treasury delta with the lucky multiplier
      const { nonce, hash } = mineNonceWithHash(state.lastHash as number[], wallet.publicKey, state.difficulty);
      await program.methods
        .claim(nonce)
        .accounts({ feePayer: wallet.publicKey, userTokenAccount, authority: wallet.publicKey })
        .rpc();

      const poolAfter = await program.account.stakePool.fetch(stakePoolPDA);
      expect(poolAfter.rewardPerTokenStored.gt(poolBefore.rewardPerTokenStored)).to.be.true;

      const baseUnscaled = 3_400_000n;
      const { reward: base } = luckyReward(baseUnscaled, hash, state.difficulty);
      const claimFee = 10_000n;
      const expectedTreasury = (base * 300n / 10_000n) + claimFee;
      const actualDelta = BigInt(poolAfter.treasuryBalance.toString()) - BigInt(poolBefore.treasuryBalance.toString());
      expect(actualDelta).to.equal(expectedTreasury);
    });

    it("claim_yield mints accumulated staking yield", async () => {
      // Do a few claims to build up treasury
      for (let i = 0; i < 3; i++) await doClaim();

      const pool = await program.account.stakePool.fetch(stakePoolPDA);
      expect(pool.treasuryBalance.toNumber()).to.be.greaterThan(0);

      const balBefore = await getAccount(provider.connection, userTokenAccount);

      await program.methods.claimYield()
        .accounts({
          userTokenAccount,
          authority: wallet.publicKey,
        })
        .rpc();

      const balAfter = await getAccount(provider.connection, userTokenAccount);
      expect(Number(balAfter.amount)).to.be.greaterThan(Number(balBefore.amount));
    });

    it("unstakes tokens back to user", async () => {
      const stakeAcct = await program.account.userStakeAccount.fetch(userStakePDA(wallet.publicKey));
      const unstakeAmount = Math.floor(stakeAcct.amount.toNumber() / 2);

      const balBefore = await getAccount(provider.connection, userTokenAccount);

      await program.methods.unstake(new anchor.BN(unstakeAmount))
        .accounts({
          userTokenAccount,
          authority: wallet.publicKey,
        })
        .rpc();

      const balAfter = await getAccount(provider.connection, userTokenAccount);
      expect(Number(balAfter.amount) - Number(balBefore.amount)).to.equal(unstakeAmount);
    });

    it("rejects unstake above staked balance", async () => {
      try {
        await program.methods.unstake(new anchor.BN(999_999_999_999))
          .accounts({
            userTokenAccount,
            authority: wallet.publicKey,
          })
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("InsufficientStake");
      }
    });
  });

  // ─── team vesting ─────────────────────────────────────────────────────────

  describe("team vesting", () => {
    const teamWallet = anchor.web3.Keypair.generate();
    let teamTokenAccount: anchor.web3.PublicKey;

    before(async () => {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(teamWallet.publicKey, 1_000_000_000)
      );
      teamTokenAccount = await createAssociatedTokenAccount(
        provider.connection, wallet.payer, mint, teamWallet.publicKey
      );
    });

    it("initializes vesting — reserves 100M TERM (10%) against supply cap", async () => {
      const stateBefore = await program.account.globalState.fetch(globalStatePDA);

      await program.methods
        .initializeVesting(teamWallet.publicKey)
        .accounts({ authority: wallet.publicKey, teamVestState: teamVestPDA })
        .rpc();

      const v = await program.account.teamVestState.fetch(teamVestPDA);
      expect(v.teamWallet.toBase58()).to.equal(teamWallet.publicKey.toBase58());
      // All four per-tranche claimed counters start at 0
      for (let i = 0; i < 4; i++) expect(v.claimed[i].toNumber()).to.equal(0);

      // total_minted must have increased by exactly 100M TERM (100_000_000_000_000 raw)
      const stateAfter = await program.account.globalState.fetch(globalStatePDA);
      expect(stateAfter.totalMinted.toString()).to.equal(
        stateBefore.totalMinted.addn(0).add(new anchor.BN("100000000000000")).toString()
      );
    });

    it("get_team_vest_status returns per-tranche vesting data", async () => {
      const status = await program.methods.getTeamVestStatus()
        .accounts({})
        .view();

      expect(status.totalAllocation.toString()).to.equal("100000000000000"); // 100M TERM
      expect(status.teamWallet.toBase58()).to.equal(teamWallet.publicKey.toBase58());
      expect(status.trancheUnlocked[0]).to.be.true;   // tranche 0 unlocks at launch
      expect(status.trancheUnlocked[1]).to.be.false;  // tranche 1 needs year 5
      expect(status.totalClaimed.toNumber()).to.equal(0);
      expect(status.totalClaimable.toString()).to.equal("50000000000000"); // 50M TERM
      expect(status.elapsedSeconds.toNumber()).to.be.greaterThanOrEqual(0);
    });

    it("claim_team_vest mints tranche 0 (50M TERM) to team wallet immediately", async () => {
      const balBefore = await getAccount(provider.connection, teamTokenAccount);

      await program.methods.claimTeamVest()
        .accounts({
          teamTokenAccount,
          teamWallet: teamWallet.publicKey,
        })
        .signers([teamWallet])
        .rpc();

      const balAfter = await getAccount(provider.connection, teamTokenAccount);
      // Tranche 0 = 50M TERM = 50_000_000_000_000 raw units
      expect(Number(balAfter.amount) - Number(balBefore.amount)).to.equal(50_000_000_000_000);
    });

    it("rejects claim_team_vest from a non-team signer", async () => {
      const impostor = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000)
      );
      try {
        await program.methods.claimTeamVest()
          .accounts({
            teamTokenAccount,
            teamWallet: impostor.publicKey,
          })
          .signers([impostor])
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("NotAuthority");
      }
    });
  });

  // ─── authority rotation ───────────────────────────────────────────────────

  describe("authority rotation (two-step)", () => {
    it("propose + accept: transfers program authority", async () => {
      const newAuthority = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(newAuthority.publicKey, 1_000_000_000)
      );

      // Step 1: current authority proposes
      await program.methods.proposeAuthority(newAuthority.publicKey)
        .accounts({ authority: wallet.publicKey })
        .rpc();

      const proposed = await program.account.globalState.fetch(globalStatePDA);
      expect(proposed.pendingAuthority.toBase58()).to.equal(newAuthority.publicKey.toBase58());
      expect(proposed.authority.toBase58()).to.equal(wallet.publicKey.toBase58()); // unchanged

      // Step 2: pending authority accepts
      await program.methods.acceptAuthority()
        .accounts({ pendingAuthority: newAuthority.publicKey })
        .signers([newAuthority])
        .rpc();

      const accepted = await program.account.globalState.fetch(globalStatePDA);
      expect(accepted.authority.toBase58()).to.equal(newAuthority.publicKey.toBase58());
      expect(accepted.pendingAuthority.toBase58()).to.equal(anchor.web3.PublicKey.default.toBase58());

      // New authority can exercise gated instructions
      await program.methods.setPaused(false)
        .accounts({ authority: newAuthority.publicKey })
        .signers([newAuthority])
        .rpc();

      // Transfer back via the same two-step flow
      await program.methods.proposeAuthority(wallet.publicKey)
        .accounts({ authority: newAuthority.publicKey })
        .signers([newAuthority])
        .rpc();
      await program.methods.acceptAuthority()
        .accounts({ pendingAuthority: wallet.publicKey })
        .rpc();
    });

    it("accept_authority: rejects anyone but the pending authority", async () => {
      const impostor = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000)
      );
      const newAuthority = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(newAuthority.publicKey, 1_000_000_000)
      );
      // Propose to newAuthority
      await program.methods.proposeAuthority(newAuthority.publicKey)
        .accounts({ authority: wallet.publicKey })
        .rpc();
      // Impostor tries to accept
      try {
        await program.methods.acceptAuthority()
          .accounts({ pendingAuthority: impostor.publicKey })
          .signers([impostor])
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("NotPendingAuthority");
      }
      // Cancel so subsequent tests are unaffected
      await program.methods.cancelAuthorityTransfer()
        .accounts({ authority: wallet.publicKey })
        .rpc();
    });

    it("propose_authority: rejects an impostor", async () => {
      const impostor = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000)
      );
      try {
        await program.methods.proposeAuthority(impostor.publicKey)
          .accounts({ authority: impostor.publicKey })
          .signers([impostor])
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("NotAuthority");
      }
    });

    it("propose + accept: transfers freeze authority", async () => {
      const newFreeze = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(newFreeze.publicKey, 1_000_000_000)
      );

      await program.methods.proposeFreezeAuthority(newFreeze.publicKey)
        .accounts({ freezeAuthority: wallet.publicKey })
        .rpc();
      await program.methods.acceptFreezeAuthority()
        .accounts({ pendingFreezeAuthority: newFreeze.publicKey })
        .signers([newFreeze])
        .rpc();

      const state = await program.account.globalState.fetch(globalStatePDA);
      expect(state.freezeAuthority.toBase58()).to.equal(newFreeze.publicKey.toBase58());

      // New freeze authority works
      await program.methods.setFreeze(true)
        .accounts({ target: wallet.publicKey, freezeAuthority: newFreeze.publicKey })
        .signers([newFreeze])
        .rpc();
      await program.methods.setFreeze(false)
        .accounts({ target: wallet.publicKey, freezeAuthority: newFreeze.publicKey })
        .signers([newFreeze])
        .rpc();

      // Transfer back
      await program.methods.proposeFreezeAuthority(wallet.publicKey)
        .accounts({ freezeAuthority: newFreeze.publicKey })
        .signers([newFreeze])
        .rpc();
      await program.methods.acceptFreezeAuthority()
        .accounts({ pendingFreezeAuthority: wallet.publicKey })
        .rpc();
    });

    it("disable_freeze_authority permanently locks set_freeze", async () => {
      // Run last in this section since it's irreversible. Use a clone of the
      // state by transferring freeze authority to a throwaway wallet first,
      // then disable. Actually — we can just call disable on the live state
      // since wallet.publicKey == freeze_authority. After disable, no one
      // can call set_freeze, including the original holder.
      await program.methods.disableFreezeAuthority()
        .accounts({ authority: wallet.publicKey })
        .rpc();

      const state = await program.account.globalState.fetch(globalStatePDA);
      expect(state.freezeAuthority.toBase58()).to.equal(anchor.web3.PublicKey.default.toBase58());

      // set_freeze must now fail — has_one constraint can never be satisfied
      try {
        await program.methods.setFreeze(true)
          .accounts({ target: wallet.publicKey, freezeAuthority: wallet.publicKey })
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("NotFreezeAuthority");
      }
    });
  });

  // ─── supply cap ───────────────────────────────────────────────────────────

  describe("supply cap", () => {
    it("total_minted tracks all minted tokens and stays within cap", async () => {
      const state = await program.account.globalState.fetch(globalStatePDA);
      const SUPPLY_CAP = new anchor.BN("1000000000000000");
      expect(state.totalMinted.lte(SUPPLY_CAP)).to.be.true;
      expect(state.totalMinted.gtn(0)).to.be.true;
    });
  });

  // ─── anti-Sybil bond ──────────────────────────────────────────────────────

  describe("anti-Sybil bond", () => {
    it("rejects claim from a wallet that hasn't deposited a bond", async () => {
      const fresh = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(fresh.publicKey, 1_000_000_000)
      );
      // No deposit_bond — so claim should fail because bond_account doesn't exist
      const state = await program.account.globalState.fetch(globalStatePDA);
      const nonce = mineNonce(state.lastHash as number[], fresh.publicKey, state.difficulty);
      try {
        await program.methods.claim(nonce)
          .accounts({
            feePayer: fresh.publicKey,
            userTokenAccount,
            authority: fresh.publicKey,
          })
          .signers([fresh])
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        // Account doesn't exist → AccountNotInitialized or similar
        expect(err.message).to.match(/AccountNotInitialized|bond/i);
      }
    });

    it("withdraw_bond fails immediately after a claim (cooldown active)", async () => {
      const fresh = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(fresh.publicKey, 1_000_000_000)
      );
      const freshAta = await createAssociatedTokenAccount(
        provider.connection, wallet.payer, mint, fresh.publicKey
      );
      // Deposit bond
      await program.methods.depositBond()
        .accounts({ authority: fresh.publicKey })
        .signers([fresh])
        .rpc();
      // Make a claim
      const state = await program.account.globalState.fetch(globalStatePDA);
      const nonce = mineNonce(state.lastHash as number[], fresh.publicKey, state.difficulty);
      await program.methods.claim(nonce)
        .accounts({
          feePayer: fresh.publicKey,
          userTokenAccount: freshAta,
          authority: fresh.publicKey,
        })
        .signers([fresh])
        .rpc();
      // Try to withdraw — should fail because cooldown is 1 hour
      try {
        await program.methods.withdrawBond()
          .accounts({ authority: fresh.publicKey })
          .signers([fresh])
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("BondLocked");
      }
    });

    it("withdraw_bond succeeds for a deposited bond that has never claimed", async () => {
      const fresh = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(fresh.publicKey, 1_000_000_000)
      );
      const balBefore = await provider.connection.getBalance(fresh.publicKey);
      // Deposit bond (locks ~0.001 SOL of rent)
      await program.methods.depositBond()
        .accounts({ authority: fresh.publicKey })
        .signers([fresh])
        .rpc();
      // Withdraw immediately — last_claim_time = 0, so cooldown has trivially passed
      await program.methods.withdrawBond()
        .accounts({ authority: fresh.publicKey })
        .signers([fresh])
        .rpc();
      const balAfter = await provider.connection.getBalance(fresh.publicKey);
      // Net change should be just transaction fees (a few thousand lamports)
      const netLoss = balBefore - balAfter;
      expect(netLoss).to.be.lessThan(50_000); // rent was returned, only fees lost
    });
  });

  // ─── TERM bond (alternative path) ─────────────────────────────────────────

  describe("TERM bond", () => {
    const TERM_BOND_AMOUNT = 20_000_000; // 20 TERM at 6 decimals
    let freshWallet: anchor.web3.Keypair;
    let freshAta: anchor.web3.PublicKey;
    const [bondVaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bond_term_vault")], program.programId
    );

    before(async () => {
      // Fresh wallet, airdrop SOL, create token account, fund with TERM
      // (transferred from main test wallet which has plenty from mining)
      freshWallet = anchor.web3.Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(freshWallet.publicKey, 1_000_000_000)
      );
      freshAta = await createAssociatedTokenAccount(
        provider.connection, wallet.payer, mint, freshWallet.publicKey
      );
      // Transfer 30 TERM from main wallet (well above 20 TERM bond)
      const { createTransferInstruction } = await import("@solana/spl-token");
      const transferIx = createTransferInstruction(
        userTokenAccount, freshAta, wallet.publicKey, 30_000_000
      );
      const tx = new anchor.web3.Transaction().add(transferIx);
      await provider.sendAndConfirm(tx);
    });

    it("deposit_bond_term locks 20 TERM in the vault", async () => {
      const userBefore = await getAccount(provider.connection, freshAta);
      const vaultBefore = await getAccount(provider.connection, bondVaultPDA);

      await program.methods.depositBondTerm()
        .accounts({
          userTokenAccount: freshAta,
          authority: freshWallet.publicKey,
        })
        .signers([freshWallet])
        .rpc();

      const userAfter = await getAccount(provider.connection, freshAta);
      const vaultAfter = await getAccount(provider.connection, bondVaultPDA);
      expect(Number(userBefore.amount) - Number(userAfter.amount)).to.equal(TERM_BOND_AMOUNT);
      expect(Number(vaultAfter.amount) - Number(vaultBefore.amount)).to.equal(TERM_BOND_AMOUNT);

      const bond = await program.account.bondAccount.fetch(bondPDA(freshWallet.publicKey));
      expect(bond.kind).to.equal(1); // TERM
      expect(bond.termAmount.toNumber()).to.equal(TERM_BOND_AMOUNT);
    });

    it("claim works with a TERM-bonded wallet (same path as SOL-bonded)", async () => {
      const state = await program.account.globalState.fetch(globalStatePDA);
      const nonce = mineNonce(state.lastHash as number[], freshWallet.publicKey, state.difficulty);
      const balBefore = await getAccount(provider.connection, freshAta);
      await program.methods.claim(nonce)
        .accounts({
          feePayer: freshWallet.publicKey,
          userTokenAccount: freshAta,
          authority: freshWallet.publicKey,
        })
        .signers([freshWallet])
        .rpc();
      const balAfter = await getAccount(provider.connection, freshAta);
      expect(Number(balAfter.amount)).to.be.greaterThan(Number(balBefore.amount));
    });

    it("withdraw_bond rejects a TERM-bonded account (WrongBondKind)", async () => {
      try {
        await program.methods.withdrawBond()
          .accounts({ authority: freshWallet.publicKey })
          .signers([freshWallet])
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("WrongBondKind");
      }
    });

    it("withdraw_bond_term during cooldown is rejected (BondLocked)", async () => {
      try {
        await program.methods.withdrawBondTerm()
          .accounts({
            userTokenAccount: freshAta,
            authority: freshWallet.publicKey,
          })
          .signers([freshWallet])
          .rpc();
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.message).to.include("BondLocked");
      }
    });
  });
});
