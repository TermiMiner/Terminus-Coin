// devnet_bond_check.ts — withdraws a bond of each kind on devnet, an hour
// after a real claim, and checks where the money went.
//
// WHY THIS EXISTS
//
// A bond is refundable once BOND_WITHDRAW_COOLDOWN (3,600s) has passed since
// the wallet's last claim. Nothing else exercises that end to end:
//
//   • the site has no control for withdrawing a bond, and none for the TERM
//     bond (MAINNET_CHECKLIST §7 descoped the exit flow), so beta testers can
//     only deposit;
//   • the integration suite runs on a local validator that cannot wait an
//     hour. It withdraws only bonds that never claimed, whose last_claim_time
//     of 0 passes the time check trivially, and shows the refusal while a
//     cooldown is active.
//
// The case every real miner hits is claim, wait the hour, withdraw. This
// script runs it for both bond kinds against the deployed program. Its output
// is the evidence for the withdrawal half of MAINNET_CHECKLIST §6's bond
// criterion.
//
// WHAT IT DOES
//
//   1. Creates two throwaway wallets and funds them from DEPLOYER.
//   2. SOL bond: the first wallet deposits a SOL bond, paying its own rent as
//      a self-funded miner does, then mines until it holds 20 TERM.
//   3. TERM bond: the second wallet is sent those 20 TERM and deposits them,
//      with DEPLOYER paying the account rent as a relayer does for a gasless
//      miner. It then claims once.
//   4. Confirms a withdrawal is refused (BondLocked) right after the claim and
//      again shortly before the hour is up. Both are simulated, not sent.
//   5. Once the chain's clock says the hour has passed, withdraws both bonds
//      and checks each transaction: the rent went back to whoever paid it,
//      the 20 TERM went back to the miner, BondWithdrawn was emitted, the
//      bond account is gone, and a second withdrawal is refused.
//   6. Sends the leftover SOL back to DEPLOYER and prints the signatures to
//      record in the checklist.
//
// It takes a little over an hour, nearly all of it waiting, and costs about
// 0.007 SOL, nearly all of it rent on accounts the two wallets leave behind.
// Progress is saved after every step: if the run is interrupted, start it
// again and it carries on.
//
// SAFETY: refuses to run against mainnet-beta (genesis-hash check). It signs
// with DEPLOYER only to fund the two wallets and to pay one bond's rent.
//
// Usage:
//   RPC_URL=https://api.devnet.solana.com \
//   DEPLOYER=~/.config/solana/devnet-wallet.json \
//     npx ts-node -P tsconfig.json scripts/devnet_bond_check.ts
//
// Optional env:
//   STATE_FILE   run state, including the two wallets' secret keys
//                (default scripts/.devnet-bond-check.json)

import {
  AnchorProvider, BN, EventParser, LangErrorCode, Program, Wallet, utils, type Idl,
} from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SendTransactionError, SystemProgram,
  SYSVAR_CLOCK_PUBKEY, Transaction, type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Runtime IDL, as in devnet_load.ts: no Rust/Anchor toolchain needed to run.
const idl = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../miner-ui/idl/terminuscoin.json"), "utf8"),
) as Idl;
const LOCAL_BUILD = path.join(__dirname, "../target/deploy/terminuscoin.so");

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PROGRAMDATA_HEADER = 45; // bytes before the program's ELF in its programdata account
const MAX_U64 = (1n << 64n) - 1n;

// Mirrors of two constants in programs/terminuscoin/src/lib.rs. They decide
// only what this script sends and when it tries. Whether a withdrawal is
// allowed is the program's answer, not theirs.
const TERM_BOND_AMOUNT = 20_000_000n; // TERM_BOND_AMOUNT: 20 TERM at 6 decimals
const COOLDOWN_SECS = 3_600;          // BOND_WITHDRAW_COOLDOWN

// SOL given to each throwaway wallet. The SOL-bond wallet pays rent on its
// token account (2,039,280 lamports), its bond (1,287,600), its user_state
// (1,057,920) and the other wallet's token account (2,039,280). The TERM-bond
// wallet pays rent only on its user_state. The rest is for fees, including
// claims that lose a race and fail on-chain. What is left goes back at the end.
const SOL_WALLET_LAMPORTS = 8_000_000;
const TERM_WALLET_LAMPORTS = 4_000_000;
const DEPLOYER_MIN_LAMPORTS = 20_000_000; // the two transfers, one bond's rent, fees, and room to spare
const FEE_LAMPORTS = 5_000;               // one signature

const RATE_LIMIT_MARGIN_SECS = 5;  // on-chain unix_timestamp can lag the local clock
const UNLOCK_MARGIN_SECS = 5;      // and one RPC node can lag another
const LATE_CHECK_FROM_SECS = 150;  // second refusal check: once the cooldown has this little left…
const LATE_CHECK_UNTIL_SECS = 20;  // …but not this little, where the answer could go either way
const MAX_CLAIM_ATTEMPTS = 60;     // per claim: stale nonces under contention, rate limit, RPC trouble
const MAX_CLAIMS_FOR_BOND = 40;    // claims the SOL-bond wallet may make to reach 20 TERM
const MINE_YIELD_EVERY = 20_000;   // hand the event loop back during a long nonce search

// Program error codes, from the IDL rather than hard-coded.
const errorNames = new Map((idl.errors ?? []).map((e) => [e.code, e.name]));
function errorCode(name: string): number {
  const e = (idl.errors ?? []).find((x) => x.name === name);
  if (!e) throw new Error(`IDL has no ${name} error — is miner-ui/idl/terminuscoin.json current?`);
  return e.code;
}
const INVALID_POW = errorCode("InvalidProofOfWork"); // stale: last_hash or difficulty moved first
const RATE_LIMITED = errorCode("RateLimitExceeded");
const BOND_LOCKED = errorCode("BondLocked");
const PAUSED = errorCode("ContractPaused");
const SUPPLY_CAP = errorCode("SupplyCapReached");

type StepKey =
  | "sol.fund" | "sol.deposit" | "sol.claim" | "transfer"
  | "term.fund" | "term.deposit" | "term.claim"
  | "sol.withdraw" | "term.withdraw" | "sol.sweep" | "term.sweep";

/** A withdrawal the program refused, and how long after the wallet's last claim. */
type Refusal = { secondsAfterClaim: number; error: string };

/** What a landed withdrawal did, read back from the transaction itself. */
type Withdrawal = {
  blockTime: number;
  secondsAfterClaim: number;
  rentLamports: number;
  rentTo: string;
  termReturned: string; // base units, "0" for the SOL bond
};

type LegState = {
  secret: number[];
  lastClaimTime?: number; // bond_account.last_claim_time, the chain's clock at the last claim
  refusedEarly?: Refusal | "not run";
  refusedLate?: Refusal | "not run";
  withdrawal?: Withdrawal;
  replay?: string; // the error a second withdrawal is refused with
};

type Build = { deployedSlot: number | null; localSha256: string | null; matchesLocal: boolean | null };

type State = {
  genesis: string;
  program: string;
  startedAt: string;
  finishedAt?: string;
  build?: Build;
  deployedSlotAtEnd?: number | null;
  sol: LegState;
  term: LegState;
  /** Signature of each finished step. sol.claim is the wallet's latest claim. */
  sigs: Partial<Record<StepKey, string>>;
  /** Signed and possibly sent, outcome not yet known. Settled on the next run. */
  inFlight: Partial<Record<StepKey, { sig: string; lastValidBlockHeight: number }>>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const iso = (unixSecs: number) => new Date(unixSecs * 1000).toISOString().replace(".000Z", "Z");
const num = (n: number) => n.toLocaleString("en-US");
/** Base units as TERM (6 decimals). */
const fmtTerm = (base: bigint | string) =>
  (Number(BigInt(base)) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });
const fmtLeft = (secs: number) => `${Math.floor(Math.max(0, secs) / 60)}m${String(Math.max(0, secs) % 60).padStart(2, "0")}s`;

/**
 * An error that trying again will not fix: the program did something it
 * should not have, or the run cannot go on. Everything else thrown during the
 * wait is treated as trouble with the RPC node.
 */
class Stop extends Error {}

function expand(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(expand(file), "utf8"))),
  );
}

/** Something loggable for anything thrown, including values that aren't Errors. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  let json: string | undefined;
  try { json = JSON.stringify(err); } catch { /* circular */ }
  return `${(err as any)?.constructor?.name ?? typeof err} ${json ?? String(err)}`;
}
const firstLine = (err: unknown) => describeError(err).split("\n")[0].slice(0, 160);

/**
 * The program error code in a failed send, whichever way it failed:
 *   rejected by preflight → "... custom program error: 0x1771 ..."
 *   failed on-chain       → "... {"InstructionError":[0,{"Custom":6001}]} ..."
 */
function programErrorCode(err: unknown): number | undefined {
  const msg = describeError(err);
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(msg);
  if (hex) return parseInt(hex[1], 16);
  const dec = /"Custom":(\d+)/.exec(msg);
  return dec ? Number(dec[1]) : undefined;
}

/** A name for an error code: the program's own, or the one Anchor error this script expects. */
function errorName(code: number | undefined, fallback: unknown): string {
  if (code === undefined) return JSON.stringify(fallback);
  if (code === LangErrorCode.AccountNotInitialized) return "AccountNotInitialized";
  return errorNames.get(code) ?? `error ${code}`;
}

function meetsDifficulty(hash: Uint8Array, target: bigint): boolean {
  let high = 0n;
  for (let i = 0; i < 8; i++) high = (high << 8n) | BigInt(hash[i]);
  return high <= target;
}

/**
 * Mine a nonce for `user` against `lastHash`, as devnet_load.ts does. Mirrors
 * the on-chain preimage: 72 bytes = nonce (u64 LE) || last_hash (32) || miner
 * pubkey (32).
 */
async function mineNonce(lastHash: number[], user: PublicKey, difficulty: bigint): Promise<BN> {
  const target = difficulty <= 1n ? MAX_U64 : MAX_U64 / difficulty;
  const input = new Uint8Array(72);
  input.set(lastHash, 8);
  input.set(user.toBytes(), 40);
  const view = new DataView(input.buffer);
  let attempts = 0;
  for (let n = 0n; ; n++) {
    view.setBigUint64(0, n, true);
    if (meetsDifficulty(keccak_256(input), target)) return new BN(n.toString());
    if (++attempts % MINE_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rpc = (process.env.RPC_URL ?? "").trim();
  const deployerFile = (process.env.DEPLOYER ?? "").trim();
  if (!rpc) throw new Error("RPC_URL is not set.");
  if (!deployerFile) throw new Error("DEPLOYER (path to funding keypair) is not set.");

  const conn = new Connection(rpc, "confirmed");

  // Refuse mainnet. This script mints and spends, and is evidence for devnet.
  const genesis = await conn.getGenesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new Error("Refusing to run: RPC_URL points at mainnet-beta. This check is for devnet.");
  }
  const onDevnet = genesis === DEVNET_GENESIS;

  const deployer = loadKeypair(deployerFile);
  const provider = new AnchorProvider(conn, new Wallet(deployer), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  // The IDL is loaded at runtime, so there are no generated account types.
  const accounts = program.account as any;

  const pda = (...seeds: (string | PublicKey)[]) => PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())), program.programId)[0];
  const globalStatePDA = pda("global_state_final_2026");
  const mintPDA = pda("mint");
  const bondVaultPDA = pda("bond_term_vault");

  // ── Run state (persisted) ───────────────────────────────────────────────────
  // Holds the two wallets' secret keys, so a run that stops can be picked up
  // and nothing is stranded in a wallet nobody has the key to.
  const stateFile = expand(process.env.STATE_FILE ?? path.join(__dirname, ".devnet-bond-check.json"));
  let st: State;
  if (fs.existsSync(stateFile)) {
    st = JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
    if (st.genesis !== genesis || st.program !== program.programId.toBase58()) {
      throw new Error(`${stateFile} is from a run on another cluster or program. Move it aside to start a new run.`);
    }
  } else {
    st = {
      genesis, program: program.programId.toBase58(), startedAt: new Date().toISOString(),
      sol: { secret: Array.from(Keypair.generate().secretKey) },
      term: { secret: Array.from(Keypair.generate().secretKey) },
      sigs: {}, inFlight: {},
    };
  }
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
  save();

  type Leg = {
    key: "sol" | "term";
    label: string;
    kp: Keypair;
    ata: PublicKey;
    bond: PublicKey;
    rentPayer: PublicKey;
    state: LegState;
    withdrawIx: () => Promise<TransactionInstruction>;
  };
  const solKp = Keypair.fromSecretKey(Uint8Array.from(st.sol.secret));
  const termKp = Keypair.fromSecretKey(Uint8Array.from(st.term.secret));
  const termAta = getAssociatedTokenAddressSync(mintPDA, termKp.publicKey);
  const sol: Leg = {
    key: "sol", label: "SOL bond", kp: solKp, state: st.sol,
    ata: getAssociatedTokenAddressSync(mintPDA, solKp.publicKey),
    bond: pda("bond", solKp.publicKey),
    rentPayer: solKp.publicKey,
    // rent_payer is passed explicitly. Left out, Anchor reads it from the bond
    // account, which no longer exists when the second withdrawal is simulated.
    withdrawIx: () => program.methods.withdrawBond()
      .accounts({ authority: solKp.publicKey, rentPayer: solKp.publicKey }).instruction(),
  };
  const termLeg: Leg = {
    key: "term", label: "TERM bond", kp: termKp, state: st.term,
    ata: termAta,
    bond: pda("bond", termKp.publicKey),
    rentPayer: deployer.publicKey,
    withdrawIx: () => program.methods.withdrawBondTerm()
      .accounts({ userTokenAccount: termAta, authority: termKp.publicKey, rentPayer: deployer.publicKey })
      .instruction(),
  };
  const legs = [sol, termLeg];

  if (st.finishedAt) {
    printSummary();
    console.log(`\nThis run finished on ${st.finishedAt}. Move ${stateFile} aside to run the check again.`);
    return;
  }

  process.on("SIGINT", () => {
    console.log("\nInterrupted. Nothing is lost: run it again and it carries on from here.");
    process.exit(130);
  });

  // ── Chain reads ─────────────────────────────────────────────────────────────

  /** The chain's own clock: the unix_timestamp the program sees. */
  async function chainTime(): Promise<number> {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    if (!info) throw new Error("Clock sysvar not found.");
    return Number(info.data.readBigInt64LE(32));
  }

  /** TERM in a token account, 0 if it does not exist. The amount is the u64 at offset 64. */
  async function tokenBalance(ata: PublicKey): Promise<bigint> {
    const info = await conn.getAccountInfo(ata);
    return info ? info.data.readBigUInt64LE(64) : 0n;
  }

  const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], UPGRADEABLE_LOADER);

  /** The slot the program was last deployed in, from its programdata header. Null if there is none. */
  async function deployedSlot(): Promise<number | null> {
    const info = await conn.getAccountInfo(programData, { dataSlice: { offset: 0, length: PROGRAMDATA_HEADER } });
    return info && info.data.length >= 12 ? Number(info.data.readBigUInt64LE(4)) : null;
  }

  /** That slot, and whether the deployed program is byte for byte the local build, if there is one. */
  async function describeBuild(): Promise<Build> {
    const slot = await deployedSlot();
    if (slot === null || !fs.existsSync(LOCAL_BUILD)) return { deployedSlot: slot, localSha256: null, matchesLocal: null };
    const local = fs.readFileSync(LOCAL_BUILD);
    const elf = (await conn.getAccountInfo(programData))!.data.subarray(PROGRAMDATA_HEADER);
    // The account is allocated at least as long as the binary; anything past it is zero padding.
    const matchesLocal = elf.length >= local.length
      && elf.subarray(0, local.length).equals(local)
      && elf.subarray(local.length).every((b) => b === 0);
    return { deployedSlot: slot, localSha256: crypto.createHash("sha256").update(local).digest("hex"), matchesLocal };
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  /** Whether a signed transaction landed, failed on-chain, or can no longer land. Polls; no websocket. */
  async function settle(sig: string, lastValidBlockHeight: number):
    Promise<{ outcome: "landed" | "expired" } | { outcome: "failed"; err: unknown }> {
    const status = async () =>
      (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    for (;;) {
      let s = await status();
      if (!s && (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
        s = await status(); // it may have landed in the last block it was valid for
        if (!s) return { outcome: "expired" };
      }
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
        return s.err ? { outcome: "failed", err: s.err } : { outcome: "landed" };
      }
      await sleep(1_000);
    }
  }

  /**
   * If an earlier attempt at this step was signed and its outcome never
   * recorded, find out what became of it. A transaction that landed is the
   * step, and must not be sent a second time.
   */
  async function adoptInFlight(key: StepKey): Promise<string | undefined> {
    const prior = st.inFlight[key];
    if (!prior) return undefined;
    const res = await settle(prior.sig, prior.lastValidBlockHeight);
    delete st.inFlight[key];
    if (res.outcome === "landed") st.sigs[key] = prior.sig;
    save();
    return res.outcome === "landed" ? prior.sig : undefined;
  }

  /** Sign, record, send and confirm one transaction. Throws unless it landed without error. */
  async function send(
    key: StepKey, feePayer: Keypair, ixs: TransactionInstruction[], cosigners: Keypair[] = [],
  ): Promise<string> {
    const adopted = await adoptInFlight(key);
    if (adopted) return adopted;

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(feePayer, ...cosigners);
    const sig = utils.bytes.bs58.encode(tx.signature!);
    // Recorded before it is sent: if the process dies now, the next run can
    // still tell whether this transaction landed.
    st.inFlight[key] = { sig, lastValidBlockHeight };
    save();
    try {
      await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    } catch (err) {
      // The node answered with an error (a failed preflight included), so it
      // did not broadcast. Anything else leaves the outcome unknown.
      if (err instanceof SendTransactionError) { delete st.inFlight[key]; save(); }
      throw err;
    }
    const res = await settle(sig, lastValidBlockHeight);
    delete st.inFlight[key];
    if (res.outcome === "landed") st.sigs[key] = sig;
    save();
    if (res.outcome === "landed") return sig;
    if (res.outcome === "failed") throw new Error(`${key} failed on-chain: ${JSON.stringify(res.err)} (${sig})`);
    throw new Error(`${key} was not confirmed before its blockhash expired (${sig})`);
  }

  /** A one-off step: skipped if already done, retried on RPC trouble, never on a program error. */
  async function step(
    key: StepKey, label: string, feePayer: Keypair,
    build: () => Promise<TransactionInstruction[]>, cosigners: Keypair[] = [],
  ): Promise<string> {
    const done = st.sigs[key];
    if (done) { console.log(`  ${label}: ${done} (earlier run)`); return done; }
    for (let attempt = 1; ; attempt++) {
      try {
        const sig = await send(key, feePayer, await build(), cosigners);
        console.log(`  ${label}: ${sig}`);
        return sig;
      } catch (err) {
        if (programErrorCode(err) !== undefined || attempt >= 5) throw err;
        console.log(`  ${label}: ${firstLine(err)} — trying again`);
        await sleep(3_000 * attempt);
      }
    }
  }

  /**
   * One claim for a leg's wallet. Every landed claim rotates last_hash, so a
   * claim loses to any other that lands first (the load harness, a tester):
   * mine again on the new hash until one of ours lands.
   */
  async function claim(leg: Leg, rateLimitSecs: number): Promise<string> {
    const key: StepKey = `${leg.key}.claim`;
    let lost = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        const state = await accounts.globalState.fetch(globalStatePDA);
        const nonce = await mineNonce(state.lastHash as number[], leg.kp.publicKey, BigInt(state.difficulty.toString()));
        const ix = await program.methods.claim(nonce, new BN(0))
          .accounts({
            feePayer: leg.kp.publicKey,
            userTokenAccount: leg.ata,
            feePayerTokenAccount: leg.ata,
            authority: leg.kp.publicKey,
          }).instruction();
        const sig = await send(key, leg.kp, [ix]);
        console.log(`  claim: ${sig}${lost ? ` (after ${lost} lost to other claims)` : ""}`.padEnd(100));
        return sig;
      } catch (err) {
        const code = programErrorCode(err);
        if (code === PAUSED) throw new Error("Mining is paused on this cluster (set_paused). Unpause it and run again.");
        if (code === SUPPLY_CAP) throw new Error("The supply cap is reached: mining is over on this cluster.");
        if (attempt >= MAX_CLAIM_ATTEMPTS) {
          throw new Error(`No claim landed for the ${leg.label} wallet in ${attempt} attempts. Last error: ${firstLine(err)}`);
        }
        if (code === INVALID_POW) { lost++; continue; } // someone else's claim landed first
        if (code === RATE_LIMITED) { await sleep((rateLimitSecs > 0 ? RATE_LIMIT_MARGIN_SECS : 1) * 1000); continue; }
        if (code !== undefined) throw err; // any other program error is not something a retry fixes
        console.log(`  claim: ${firstLine(err)} — trying again`);
        await sleep(3_000);
      }
    }
  }

  // ── Checks ──────────────────────────────────────────────────────────────────

  /** Simulate a leg's withdrawal. Returns the error it is refused with, or undefined if it would succeed. */
  async function simulateWithdrawal(leg: Leg): Promise<{ code: number | undefined; err: unknown } | undefined> {
    const tx = new Transaction().add(await leg.withdrawIx());
    tx.feePayer = leg.kp.publicKey;
    const sim = await conn.simulateTransaction(tx, [leg.kp]);
    if (sim.value.err === null) return undefined;
    return { code: programErrorCode(sim.value.err), err: sim.value.err };
  }

  /** While the cooldown runs, a withdrawal must be refused with BondLocked. */
  async function expectLocked(leg: Leg): Promise<Refusal> {
    const after = (await chainTime()) - leg.state.lastClaimTime!;
    const refused = await simulateWithdrawal(leg);
    if (!refused) {
      throw new Stop(
        `FINDING: the ${leg.label} withdrawal would have succeeded ${num(after)}s after the wallet's last claim. ` +
        `The ${num(COOLDOWN_SECS)}s cooldown is not being enforced (docs/devnet-beta.md rates this High). Nothing was withdrawn.`);
    }
    if (refused.code !== BOND_LOCKED) {
      throw new Stop(`Expected the ${leg.label} withdrawal to be refused with BondLocked ${num(after)}s after the claim; got ${errorName(refused.code, refused.err)}.`);
    }
    console.log(`  ${leg.label}: withdrawal refused ${num(after)}s after the claim (BondLocked)`);
    return { secondsAfterClaim: after, error: "BondLocked" };
  }

  /** Withdraw a leg's bond, then check from the transaction what it did. */
  async function withdraw(leg: Leg): Promise<void> {
    const key: StepKey = `${leg.key}.withdraw`;
    if (leg.state.refusedLate === undefined) leg.state.refusedLate = "not run";
    if (!st.sigs[key]) {
      if (!(await conn.getAccountInfo(leg.bond))) {
        throw new Stop(`The ${leg.label} account is no longer on this cluster, and this run did not withdraw it. ` +
          `If the cluster was reset, move ${stateFile} aside and start again.`);
      }
      for (let attempt = 1; ; attempt++) {
        try {
          await step(key, `${leg.label} withdrawn`, leg.kp, async () => [await leg.withdrawIx()]);
          break;
        } catch (err) {
          if (programErrorCode(err) !== BOND_LOCKED) throw err;
          const after = (await chainTime()) - leg.state.lastClaimTime!;
          // A node a few seconds behind can still see the cooldown as active.
          if (attempt < 6 && after < COOLDOWN_SECS + 60) { await sleep(5_000); continue; }
          throw new Stop(
            `FINDING: the ${leg.label} withdrawal is still refused (BondLocked) ${num(after)}s after the wallet's last claim, ` +
            `past the ${num(COOLDOWN_SECS)}s cooldown. The bond is not recoverable when it should be (docs/devnet-beta.md rates this High).`);
        }
      }
    }
    const sig = st.sigs[key]!;

    let tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    for (let i = 0; (!tx || !tx.meta) && i < 20; i++) {
      await sleep(1_500);
      tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    }
    if (!tx || !tx.meta) throw new Error(`The ${leg.label} withdrawal landed (${sig}) but the RPC node does not return it. Run again to check it.`);
    const meta = tx.meta;
    const keys = tx.transaction.message.staticAccountKeys;
    const at = (k: PublicKey) => {
      const i = keys.findIndex((x) => x.equals(k));
      if (i < 0) throw new Error(`${k.toBase58()} is not in transaction ${sig}`);
      return i;
    };
    const lamports = (k: PublicKey) => ({ pre: meta.preBalances[at(k)], post: meta.postBalances[at(k)] });
    const tokens = (list: typeof meta.preTokenBalances, k: PublicKey) =>
      BigInt(list?.find((b) => b.accountIndex === at(k))?.uiTokenAmount.amount ?? "0");

    const problems: string[] = [];
    if (meta.err) problems.push(`the transaction failed: ${JSON.stringify(meta.err)}`);

    // The bond account is emptied, and its rent goes to whoever paid it. When
    // that is also the fee payer, the fee comes out of the same balance.
    const bond = lamports(leg.bond);
    const payer = lamports(leg.rentPayer);
    const feePaid = leg.rentPayer.equals(leg.kp.publicKey) ? meta.fee : 0;
    if (bond.pre <= 0 || bond.post !== 0) problems.push(`bond account went from ${bond.pre} to ${bond.post} lamports, expected all of it to leave`);
    if (payer.post - payer.pre + feePaid !== bond.pre) {
      problems.push(`rent payer received ${payer.post - payer.pre + feePaid} lamports, expected the bond account's ${bond.pre}`);
    }
    if (await conn.getAccountInfo(leg.bond)) problems.push("the bond account still exists");

    // The TERM bond comes back out of the vault to the miner's token account.
    const expectTerm = leg.key === "term" ? TERM_BOND_AMOUNT : 0n;
    if (leg.key === "term") {
      const toMiner = tokens(meta.postTokenBalances, leg.ata) - tokens(meta.preTokenBalances, leg.ata);
      const fromVault = tokens(meta.preTokenBalances, bondVaultPDA) - tokens(meta.postTokenBalances, bondVaultPDA);
      if (toMiner !== expectTerm) problems.push(`miner received ${fmtTerm(toMiner)} TERM, expected ${fmtTerm(expectTerm)}`);
      if (fromVault !== expectTerm) problems.push(`vault paid out ${fmtTerm(fromVault)} TERM, expected ${fmtTerm(expectTerm)}`);
    }

    // BondWithdrawn names the miner, the kind and the amount.
    const events = [...new EventParser(program.programId, program.coder).parseLogs(meta.logMessages ?? [])];
    const ev = events.find((e) => e.name.toLowerCase() === "bondwithdrawn")?.data as any;
    if (!ev) problems.push("no BondWithdrawn event in the logs");
    else if (ev.miner.toBase58() !== leg.kp.publicKey.toBase58()
      || Number(ev.kind) !== (leg.key === "term" ? 1 : 0)
      || BigInt((ev.termAmount ?? ev.term_amount).toString()) !== expectTerm) {
      problems.push(`BondWithdrawn does not match: ${JSON.stringify(ev)}`);
    }

    // The block's time is the clock the program compared against.
    const blockTime = tx.blockTime ?? (await chainTime());
    const after = blockTime - leg.state.lastClaimTime!;
    if (after < COOLDOWN_SECS) problems.push(`it landed ${num(after)}s after the last claim, inside the ${num(COOLDOWN_SECS)}s cooldown`);

    if (problems.length) {
      throw new Stop(`FINDING: the ${leg.label} withdrawal ${sig} did not do what it should:\n  - ${problems.join("\n  - ")}`);
    }

    // The account is closed, so the same withdrawal must not work twice.
    const replay = await simulateWithdrawal(leg);
    if (!replay) throw new Stop(`FINDING: a second ${leg.label} withdrawal would succeed after ${sig}.`);
    if (replay.code !== LangErrorCode.AccountNotInitialized) {
      throw new Stop(`Expected a second ${leg.label} withdrawal to be refused with AccountNotInitialized; got ${errorName(replay.code, replay.err)}.`);
    }

    leg.state.withdrawal = {
      blockTime, secondsAfterClaim: after, rentLamports: bond.pre,
      rentTo: leg.rentPayer.toBase58(), termReturned: expectTerm.toString(),
    };
    leg.state.replay = errorName(replay.code, replay.err);
    save();
    console.log(`  ${leg.label}: checked. ${num(after)}s after the claim, ${num(bond.pre)} lamports of rent back to its payer` +
      (leg.key === "term" ? `, ${fmtTerm(expectTerm)} TERM back to the miner` : "") + "; a second withdrawal is refused.");
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  function printSummary(): void {
    const who = (pk: string) =>
      pk === deployer.publicKey.toBase58() ? `the funding wallet (${pk})` : pk === solKp.publicKey.toBase58() ? "the wallet itself" : pk;
    const refusals = (s: LegState) => {
      const at = [s.refusedEarly, s.refusedLate].map((r) => (r && r !== "not run" ? `${num(r.secondsAfterClaim)}s` : null));
      if (at[0] && at[1]) return `${at[0]} and ${at[1]} after the claim (BondLocked)`;
      if (at[0]) return `${at[0]} after the claim (BondLocked). The check near the end of the hour did not run.`;
      if (at[1]) return `${at[1]} after the claim (BondLocked). The check right after the claim did not run.`;
      return "not checked: the cooldown was already over when the script got to it";
    };
    const b = st.build;
    const line = "═".repeat(72);
    console.log(`\n${line}\n Bond withdrawal check: PASSED\n${line}`);
    console.log(` Cluster   : ${onDevnet ? "devnet" : `not devnet (genesis ${st.genesis})`}`);
    console.log(` Program   : ${st.program}` + (b?.deployedSlot != null ? `, last deployed in slot ${b.deployedSlot}` : ""));
    if (b?.matchesLocal != null) {
      console.log(` Build     : ${b.matchesLocal ? "identical to" : "NOT the same as"} target/deploy/terminuscoin.so (sha256 ${b.localSha256})`);
    } else {
      console.log(" Build     : not compared (no target/deploy/terminuscoin.so here)");
    }
    if (st.deployedSlotAtEnd !== undefined && st.deployedSlotAtEnd !== b?.deployedSlot) {
      console.log(` WARNING   : the program was redeployed during the run (slot ${b?.deployedSlot} → ${st.deployedSlotAtEnd}).`);
    }
    console.log(` Run       : ${st.startedAt.slice(0, 19)}Z → ${(st.finishedAt ?? "").slice(0, 19)}Z`);
    for (const leg of legs) {
      const w = leg.state.withdrawal!;
      console.log(`\n ${leg.label} — wallet ${leg.kp.publicKey.toBase58()}`);
      console.log(`   deposit     ${st.sigs[`${leg.key}.deposit` as StepKey]}`);
      console.log(`   last claim  ${st.sigs[`${leg.key}.claim` as StepKey]}  (${iso(leg.state.lastClaimTime!)})`);
      console.log(`   refused     ${refusals(leg.state)}`);
      console.log(`   withdrawn   ${st.sigs[`${leg.key}.withdraw` as StepKey]}  (${iso(w.blockTime)})`);
      console.log(`               ${num(w.secondsAfterClaim)}s after the claim; ${num(w.rentLamports)} lamports of rent back to ${who(w.rentTo)}` +
        (w.termReturned !== "0" ? `; ${fmtTerm(w.termReturned)} TERM back to the wallet` : ""));
      console.log(`   again       refused (${leg.state.replay})`);
    }
    const day = (st.finishedAt ?? "").slice(0, 10);
    console.log(`\n For MAINNET_CHECKLIST §6:`);
    console.log(`   ${day}: SOL \`${st.sigs["sol.withdraw"]}\`, TERM \`${st.sigs["term.withdraw"]}\`` +
      (b?.deployedSlot != null ? `, program last deployed in slot ${b.deployedSlot}` : "") +
      (b?.matchesLocal ? ` (sha256 \`${b.localSha256}\`)` : ""));
    if (onDevnet) {
      for (const k of ["sol.withdraw", "term.withdraw"] as StepKey[]) {
        console.log(`   https://explorer.solana.com/tx/${st.sigs[k]}?cluster=devnet`);
      }
      console.log(`\n Add both wallets to scripts/devnet_team_pubkeys.txt, or devnet_status.ts counts them as testers:`);
      for (const leg of legs) console.log(`   ${leg.kp.publicKey.toBase58()}`);
    }
    console.log(line);
  }

  // ── Run ─────────────────────────────────────────────────────────────────────

  console.log(`Cluster         : ${onDevnet ? "devnet" : `genesis ${genesis} (not devnet, not mainnet)`}`);
  console.log(`Program         : ${program.programId.toBase58()}`);
  console.log(`Funding wallet  : ${deployer.publicKey.toBase58()}`);
  console.log(`SOL bond wallet : ${solKp.publicKey.toBase58()}`);
  console.log(`TERM bond wallet: ${termKp.publicKey.toBase58()}`);
  console.log(`Run state       : ${stateFile} (holds both wallets' secret keys)`);

  if (!st.build) { st.build = await describeBuild(); save(); }
  if (st.build.deployedSlot != null) console.log(`Deployed        : slot ${st.build.deployedSlot}`);
  if (st.build.matchesLocal === true) {
    console.log(`Build           : identical to target/deploy/terminuscoin.so (sha256 ${st.build.localSha256})`);
  } else if (st.build.matchesLocal === false) {
    console.log(`Build           : NOT the same as target/deploy/terminuscoin.so (sha256 ${st.build.localSha256}).`);
    console.log("                  The check runs against what is deployed. If it is meant as evidence for");
    console.log("                  the build that ships, upgrade the cluster first (MAINNET_CHECKLIST §6).");
  }

  for (const key of Object.keys(st.inFlight) as StepKey[]) await adoptInFlight(key);

  const global = await accounts.globalState.fetch(globalStatePDA);
  const rateLimitSecs = Number(global.rateLimitSeconds);
  if (global.paused) throw new Error("Mining is paused on this cluster (set_paused). Unpause it and run again.");
  if (!(await conn.getAccountInfo(bondVaultPDA))) {
    throw new Error("The TERM bond vault does not exist on this cluster (initialize_bond_vault has not run).");
  }
  if (!st.sigs["sol.fund"] && (await conn.getBalance(deployer.publicKey)) < DEPLOYER_MIN_LAMPORTS) {
    throw new Error(`The funding wallet needs at least ${DEPLOYER_MIN_LAMPORTS / 1e9} SOL.`);
  }

  const fund = (to: PublicKey, lamports: number) => async () =>
    [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: to, lamports })];

  console.log("\n── 1. SOL bond: deposit, then mine the 20 TERM the other bond needs ──");
  await step("sol.fund", "funded", deployer, fund(solKp.publicKey, SOL_WALLET_LAMPORTS));
  await step("sol.deposit", "SOL bond deposited", solKp, async () => [
    createAssociatedTokenAccountIdempotentInstruction(solKp.publicKey, sol.ata, solKp.publicKey, mintPDA),
    await program.methods.depositBond()
      .accounts({ authority: solKp.publicKey, rentPayer: solKp.publicKey }).instruction(),
  ]);
  if (!st.sigs["transfer"]) {
    for (let n = 1; ; n++) {
      const have = await tokenBalance(sol.ata);
      if (have >= TERM_BOND_AMOUNT) break;
      if (n > MAX_CLAIMS_FOR_BOND) {
        throw new Error(`${MAX_CLAIMS_FOR_BOND} claims left the wallet at ${fmtTerm(have)} TERM, short of the ${fmtTerm(TERM_BOND_AMOUNT)} the TERM bond needs.`);
      }
      // The per-wallet rate limit, counted on the chain's clock from this wallet's last claim.
      const last = Number((await accounts.bondAccount.fetch(sol.bond)).lastClaimTime);
      const wait = last > 0 && rateLimitSecs > 0 ? last + rateLimitSecs + RATE_LIMIT_MARGIN_SECS - (await chainTime()) : 0;
      if (wait > 0) {
        process.stdout.write(`  ${fmtTerm(have)} of ${fmtTerm(TERM_BOND_AMOUNT)} TERM; next claim in ${wait}s (rate limit ${rateLimitSecs}s)…\r`);
        await sleep(wait * 1000);
      }
      await claim(sol, rateLimitSecs);
    }
  }
  await step("transfer", "20 TERM sent to the TERM bond wallet", solKp, async () => [
    createAssociatedTokenAccountIdempotentInstruction(solKp.publicKey, termLeg.ata, termKp.publicKey, mintPDA),
    createTransferInstruction(sol.ata, termLeg.ata, solKp.publicKey, TERM_BOND_AMOUNT),
  ]);

  console.log("\n── 2. TERM bond: deposit the 20 TERM, then claim once ──");
  await step("term.fund", "funded", deployer, fund(termKp.publicKey, TERM_WALLET_LAMPORTS));
  await step("term.deposit", "TERM bond deposited", termKp, async () => [
    await program.methods.depositBondTerm()
      .accounts({ userTokenAccount: termLeg.ata, authority: termKp.publicKey, rentPayer: deployer.publicKey })
      .instruction(),
  ], [deployer]);
  if (!st.sigs["term.claim"]) await claim(termLeg, rateLimitSecs);
  else console.log(`  claim: ${st.sigs["term.claim"]} (earlier run)`);

  console.log("\n── 3. Cooldown: a withdrawal must be refused until an hour after the last claim ──");
  for (const leg of legs) {
    // The cooldown runs from the bond's own last_claim_time. Once the bond is
    // withdrawn the account is gone, and the value saved earlier stands.
    const bond = await accounts.bondAccount.fetchNullable(leg.bond);
    if (bond) leg.state.lastClaimTime = Number(bond.lastClaimTime);
    if (!leg.state.lastClaimTime) throw new Error(`The ${leg.label} has no claim recorded on-chain.`);
    save();
    if (leg.state.refusedEarly === undefined) {
      const left = leg.state.lastClaimTime + COOLDOWN_SECS - (await chainTime());
      leg.state.refusedEarly = left > LATE_CHECK_UNTIL_SECS ? await expectLocked(leg) : "not run";
      save();
    }
  }

  console.log("");
  while (legs.some((leg) => !leg.state.withdrawal)) {
    let nextIn = 60;
    const waiting: string[] = [];
    try {
      const now = await chainTime();
      for (const leg of legs) {
        if (leg.state.withdrawal) continue;
        const sent = st.sigs[`${leg.key}.withdraw` as StepKey];
        const left = leg.state.lastClaimTime! + COOLDOWN_SECS - now;
        if (sent || left + UNLOCK_MARGIN_SECS <= 0) {
          process.stdout.write("".padEnd(100) + "\r");
          if (!sent) console.log(`── 4. ${leg.label}: the hour has passed, withdrawing ──`);
          await withdraw(leg);
          nextIn = 0;
          continue;
        }
        if (leg.state.refusedLate === undefined && left <= LATE_CHECK_FROM_SECS && left > LATE_CHECK_UNTIL_SECS) {
          process.stdout.write("".padEnd(100) + "\r");
          leg.state.refusedLate = await expectLocked(leg);
          save();
        }
        waiting.push(`${leg.label} ${fmtLeft(left)}`);
        nextIn = Math.min(nextIn, left > LATE_CHECK_FROM_SECS ? left - LATE_CHECK_FROM_SECS + 1 : left + UNLOCK_MARGIN_SECS);
      }
    } catch (err) {
      // An hour is long enough for an RPC node to have a bad minute, and none
      // of this is lost by asking again. A program error or a Stop is final.
      if (err instanceof Stop || programErrorCode(err) !== undefined) throw err;
      process.stdout.write(`  ${firstLine(err)} — still trying`.padEnd(100) + "\r");
      await sleep(10_000);
      continue;
    }
    if (waiting.length) {
      process.stdout.write(`  cooldown left: ${waiting.join(" · ")}`.padEnd(100) + "\r");
      await sleep(Math.max(2, Math.min(60, nextIn)) * 1000);
    }
  }

  console.log("\n── 5. Return the leftover SOL ──");
  for (const leg of legs) {
    const key = `${leg.key}.sweep` as StepKey;
    try {
      const balance = await conn.getBalance(leg.kp.publicKey);
      if (!st.sigs[key] && balance <= FEE_LAMPORTS) continue;
      await step(key, `${leg.label} wallet emptied`, leg.kp, async () => [SystemProgram.transfer({
        fromPubkey: leg.kp.publicKey, toPubkey: deployer.publicKey,
        lamports: (await conn.getBalance(leg.kp.publicKey)) - FEE_LAMPORTS,
      })]);
    } catch (err) {
      // The check itself is done; leftover dust is not worth failing the run over.
      console.log(`  ${leg.label} wallet: leftover SOL not returned (${firstLine(err)})`);
    }
  }

  st.deployedSlotAtEnd = await deployedSlot();
  st.finishedAt = new Date().toISOString();
  save();
  printSummary();
}

main().catch((err) => {
  console.error("\nError:", err?.message ?? err);
  if (err?.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
