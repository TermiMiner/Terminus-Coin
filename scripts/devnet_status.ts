// devnet_status.ts — is the devnet beta running, and what evidence has it built?
//
// Reads, from the chain itself, what MAINNET_CHECKLIST §6 asks for:
//   • whether mining is running, and when the last claim landed
//   • distinct miners in the last day, week and month
//   • claims per day
//   • bonds, by kind and by who paid their rent: the wallet, the relayer, or
//     someone else
//   • which build is deployed, and whether it is the one
//     scripts/mainnet-launch.sh ships
//   • the relayer's balance
//
// It signs nothing and needs no key, so it can run anywhere, a cloud session
// included (docs/REMOTE.md). Distinct miners come from each wallet's
// user_state, whose last_claim_time the program updates on every claim, so
// "miners in the last 7 days" is exact without reading any transaction.
//
// The load harness's wallets are counted apart from everyone else's. They are
// the public keys in scripts/devnet_load_pubkeys.txt, which the repo carries
// so this works on any machine, plus the wallets in a pool file if there is
// one here (scripts/.devnet-load-wallets.json, or WALLET_FILE). Only public
// keys are taken from the pool file. The team's other devnet wallets, such as
// the bond withdrawal check's, are counted apart too: those in
// scripts/devnet_team_pubkeys.txt, plus the wallets in a bond-check state file
// here (scripts/.devnet-bond-check.json, or BOND_CHECK_STATE).
//
// Usage:
//   npx ts-node -P tsconfig.json scripts/devnet_status.ts [--days N] [--json]
//
//   --days N   claims per day for the last N days (default 7, up to 90)
//   --json     machine-readable output
//
// Optional env:
//   RPC_URL            default https://api.devnet.solana.com
//   RELAYER_URL        relayer to ask for its balance; on devnet the default is
//                      https://terminus-coin.vercel.app
//   WALLET_FILE        a load harness wallet pool on this machine (default scripts/.devnet-load-wallets.json)
//   BOND_CHECK_STATE   a bond-check state file on this machine (default scripts/.devnet-bond-check.json)
//   STALE_AFTER_HOURS  mining counts as stopped after this long without a claim (default 3)
//
// Exit code: 0 while mining runs, 2 once it has stopped, 1 on an error.

import { BorshAccountsCoder, utils, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Runtime IDL, as in devnet_load.ts: no Rust/Anchor toolchain needed.
const idl = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../miner-ui/idl/terminuscoin.json"), "utf8"),
) as Idl;
const PROGRAM_ID = new PublicKey(idl.address);
const coder = new BorshAccountsCoder(idl);
const LAUNCH_SCRIPT = path.join(__dirname, "mainnet-launch.sh");
const LOCAL_BUILD = path.join(__dirname, "../target/deploy/terminuscoin.so");
const HARNESS_KEYS = path.join(__dirname, "devnet_load_pubkeys.txt");
const TEAM_KEYS = path.join(__dirname, "devnet_team_pubkeys.txt");

const CLUSTERS: Record<string, string> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet-beta",
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG": "devnet",
};
const DEVNET_RELAYER = "https://terminus-coin.vercel.app";
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PROGRAMDATA_HEADER = 45; // bytes before the program's ELF in its programdata account
const BOND_SIZE = 8 + 49;      // the current BondAccount; older 25-byte bonds predate rent_payer
// What a gasless first claim costs the relayer: rent on the new wallet's token
// account (165 bytes), bond (57) and user_state (24), and the fee. The rent is
// read from the cluster, because Solana is cutting it in steps (SIMD-0437).
const FIRST_CLAIM_ACCOUNT_SIZES = [165, 57, 24];
const FIRST_CLAIM_FEE_LAMPORTS = 5_000;
const DAY = 86_400;
const WINDOWS = [["24h", DAY], ["7d", 7 * DAY], ["30d", 30 * DAY]] as const;

type Counts = { "24h": number; "7d": number; "30d": number; ever: number };
type Payer = "wallet" | "relayer" | "other";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const num = (n: number) => n.toLocaleString("en-US");
const sol = (lamports: number) => (lamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });
const utc = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const dayOf = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

function expand(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** A table: the title row unindented, the other rows indented, numbers right-aligned. */
function table(title: string[], rows: (string | number)[][], first = 22, width = 7): string[] {
  const cells = (r: (string | number)[]) =>
    r.slice(1).map((c) => (typeof c === "number" ? num(c) : c).padStart(width)).join("");
  return [title[0].padEnd(first) + cells(title), ...rows.map((r) => `  ${r[0]}`.padEnd(first) + cells(r))];
}

function ago(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / DAY), h = Math.floor((s % DAY) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
}

const pda = (...seeds: (string | PublicKey)[]) => PublicKey.findProgramAddressSync(
  seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())), PROGRAM_ID)[0];

const discriminator = (account: string) => {
  const a = (idl.accounts ?? []).find((x) => x.name === account);
  if (!a) throw new Error(`IDL has no ${account} account — is miner-ui/idl/terminuscoin.json current?`);
  return utils.bytes.bs58.encode(Buffer.from(a.discriminator));
};

/** Retries a read the public RPC refused for rate limiting. */
async function withRetry<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await f();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (attempt >= 6 || !/429|too many requests|rate.?limit/i.test(msg)) throw err;
      await sleep(1_000 * 2 ** (attempt - 1));
    }
  }
}

/** A program's ELF without the zero padding after it, sized from its own header. */
function trimElf(data: Buffer): Buffer {
  const isElf64 = data.length > 64 && data.readUInt32BE(0) === 0x7f454c46 && data[4] === 2;
  if (isElf64) {
    const end = Number(data.readBigUInt64LE(0x28)) + data.readUInt16LE(0x3a) * data.readUInt16LE(0x3c);
    if (end > 0 && end <= data.length) return data.subarray(0, end);
  }
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  return data.subarray(0, end);
}

/** The scope tag and the build hash scripts/mainnet-launch.sh refuses to deploy anything but. */
function scopeBuild(): { tag: string; sha256: string } | null {
  if (!fs.existsSync(LAUNCH_SCRIPT)) return null;
  const text = fs.readFileSync(LAUNCH_SCRIPT, "utf8");
  const tag = /^SCOPE_TAG="([^"]+)"/m.exec(text)?.[1];
  const sha256 = /^SCOPE_BINARY_SHA256="([0-9a-f]{64})"/m.exec(text)?.[1];
  return tag && sha256 ? { tag, sha256 } : null;
}

/** Public keys of the load harness's pool: the last 32 bytes of each 64-byte secret key. */
function harnessWallets(file: string): PublicKey[] | null {
  if (!fs.existsSync(file)) return null;
  const secrets = JSON.parse(fs.readFileSync(file, "utf8")) as number[][];
  return secrets.filter((s) => s.length === 64).map((s) => new PublicKey(Uint8Array.from(s.slice(32))));
}

/** Public keys of the bond check's two wallets, from its state file (scripts/devnet_bond_check.ts). */
function bondCheckWallets(file: string): PublicKey[] | null {
  if (!fs.existsSync(file)) return null;
  const st = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { secret?: number[] } | undefined>;
  return [st.sol?.secret, st.term?.secret]
    .filter((s): s is number[] => Array.isArray(s) && s.length === 64)
    .map((s) => new PublicKey(Uint8Array.from(s.slice(32))));
}

/** Public keys listed one per line, as in scripts/devnet_load_pubkeys.txt; "#" starts a comment. */
function listedWallets(file: string): PublicKey[] | null {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((key) => {
      try { return new PublicKey(key); } catch { throw new Error(`${file}: "${key}" is not a public key.`); }
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const daysAt = args.indexOf("--days");
  const days = daysAt === -1 ? 7 : Number(args[daysAt + 1]);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--days takes a whole number from 1 to 90.");
  const staleAfterHours = Number((process.env.STALE_AFTER_HOURS ?? "").trim() || 3);
  if (!(staleAfterHours > 0)) throw new Error("STALE_AFTER_HOURS must be a positive number of hours.");

  const rpc = (process.env.RPC_URL ?? "").trim() || "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const genesis = await withRetry(() => conn.getGenesisHash());
  const cluster = CLUSTERS[genesis] ?? `other (genesis ${genesis})`;
  const clock = await withRetry(() => conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY));
  if (!clock) throw new Error("The Clock sysvar is missing.");
  const now = Number(clock.data.readBigInt64LE(32)); // the chain's clock, which the program uses

  // ── Program: when it was deployed, and which build ──────────────────────────
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER);
  const pd = await withRetry(() => conn.getAccountInfo(programData));
  if (!pd || pd.data.length <= PROGRAMDATA_HEADER) throw new Error(`The program is not deployed on ${cluster}.`);
  const deployedSlot = Number(pd.data.readBigUInt64LE(4));
  const elf = trimElf(pd.data.subarray(PROGRAMDATA_HEADER));
  const sha256 = crypto.createHash("sha256").update(elf).digest("hex");
  const scope = scopeBuild();
  const localSha = fs.existsSync(LOCAL_BUILD)
    ? crypto.createHash("sha256").update(fs.readFileSync(LOCAL_BUILD)).digest("hex") : null;
  const program = {
    id: PROGRAM_ID.toBase58(),
    deployedSlot,
    deployedAt: await conn.getBlockTime(deployedSlot).catch(() => null),
    upgradeAuthority: pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null,
    bytes: elf.length,
    sha256,
    scopeTag: scope?.tag ?? null,
    isScopeBuild: scope ? scope.sha256 === sha256 : null,
    matchesLocalBuild: localSha ? localSha === sha256 : null,
  };

  // ── Global state ────────────────────────────────────────────────────────────
  const globalStatePDA = pda("global_state_final_2026");
  const gsInfo = await withRetry(() => conn.getAccountInfo(globalStatePDA));
  if (!gsInfo) throw new Error(`The program has no global state on ${cluster}: it has not been initialized there.`);
  const gs = coder.decode("GlobalState", gsInfo.data);
  const state = {
    difficulty: gs.difficulty.toString(),
    totalClaims: Number(gs.total_claims),
    rateLimitSeconds: Number(gs.rate_limit_seconds),
    paused: !!gs.paused,
  };

  // ── Relayer (asked first: bonds it paid for are told apart by its key) ─────
  const relayerUrl = ((process.env.RELAYER_URL ?? "").trim() || (cluster === "devnet" ? DEVNET_RELAYER : ""))
    .replace(/\/+$/, "");
  let relayer: Record<string, unknown> | null = null;
  let relayerKey: PublicKey | null = null;
  if (relayerUrl) {
    try {
      const firstClaimLamports = FIRST_CLAIM_FEE_LAMPORTS + (await Promise.all(FIRST_CLAIM_ACCOUNT_SIZES.map(
        (size) => withRetry(() => conn.getMinimumBalanceForRentExemption(size))))).reduce((a, b) => a + b, 0);
      const res = await fetch(`${relayerUrl}/api/relayer-info`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info = await res.json() as {
        pubkey: string; balance: number; dailyCap: number; dailySpent: number; bootstrapMode: boolean;
      };
      relayerKey = new PublicKey(info.pubkey);
      relayer = {
        url: relayerUrl, pubkey: info.pubkey, balanceLamports: info.balance,
        gaslessFirstClaims: Math.floor(info.balance / firstClaimLamports),
        dailyCapLamports: info.dailyCap, dailySpentLamports: info.dailySpent, bootstrapMode: info.bootstrapMode,
      };
    } catch (err) {
      relayer = { url: relayerUrl, error: String((err as Error)?.message ?? err).split("\n")[0] };
    }
  }

  // ── The harness's wallets: the ones the repo lists, and a pool file here ────
  const walletFile = expand(process.env.WALLET_FILE ?? path.join(__dirname, ".devnet-load-wallets.json"));
  const listed = listedWallets(HARNESS_KEYS);
  const local = harnessWallets(walletFile);
  const listedKeys = new Set(listed?.map((pk) => pk.toBase58()));
  // Pool wallets the list lacks: other machines count them as testers.
  const unlisted = (local ?? []).filter((pk) => !listedKeys.has(pk.toBase58()));
  const pool = listed || local ? [...(listed ?? []), ...unlisted] : null;
  const poolUserStates = new Set(pool?.map((pk) => pda("user_state", pk).toBase58()));
  const poolBonds = new Set(pool?.map((pk) => pda("bond", pk).toBase58()));

  // ── The team's other wallets: the repo's list, and a bond-check state file here ──
  const bondCheckFile = expand(process.env.BOND_CHECK_STATE ?? path.join(__dirname, ".devnet-bond-check.json"));
  const teamListed = listedWallets(TEAM_KEYS);
  const teamLocal = bondCheckWallets(bondCheckFile);
  const teamListedKeys = new Set(teamListed?.map((pk) => pk.toBase58()));
  const teamUnlisted = (teamLocal ?? []).filter((pk) => !teamListedKeys.has(pk.toBase58()));
  const team = teamListed || teamLocal ? [...(teamListed ?? []), ...teamUnlisted] : null;
  const teamUserStates = new Set(team?.map((pk) => pda("user_state", pk).toBase58()));
  const teamBonds = new Set(team?.map((pk) => pda("bond", pk).toBase58()));

  // ── Miners: every wallet's user_state holds the time of its last claim ─────
  const userStates = await withRetry(() => conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: discriminator("UserState") } }],
  }));
  const lastClaims = userStates.map(({ pubkey, account }) => ({
    harness: poolUserStates.has(pubkey.toBase58()),
    team: teamUserStates.has(pubkey.toBase58()),
    last: Number(coder.decode("UserState", account.data).last_claim_time),
  }));
  const tally = (rows: typeof lastClaims): Counts => {
    const c: Counts = { "24h": 0, "7d": 0, "30d": 0, ever: rows.length };
    for (const r of rows) for (const [label, secs] of WINDOWS) if (r.last > 0 && now - r.last < secs) c[label]++;
    return c;
  };
  const miners = {
    all: tally(lastClaims),
    harness: pool ? tally(lastClaims.filter((r) => r.harness)) : null,
    team: team ? tally(lastClaims.filter((r) => r.team && !r.harness)) : null,
    others: pool || team ? tally(lastClaims.filter((r) => !r.harness && !r.team)) : null,
  };
  const lastClaim = lastClaims.reduce((m, r) => Math.max(m, r.last), 0) || null;
  const stopped = lastClaim === null || now - lastClaim > staleAfterHours * 3600;

  // ── Claims per day, from the global state's transaction history ────────────
  // Every claim writes the global state; so do the rare authority changes.
  const firstDay = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const perDay = new Map<string, { landed: number; failed: number }>();
  for (let d = 0; d < days; d++) perDay.set(dayOf(firstDay + d * DAY), { landed: 0, failed: 0 });
  let before: string | undefined;
  for (;;) {
    const sigs = await withRetry(() => conn.getSignaturesForAddress(globalStatePDA, { limit: 1000, before }));
    for (const s of sigs) {
      const day = s.blockTime != null && s.blockTime >= firstDay ? perDay.get(dayOf(s.blockTime)) : undefined;
      if (day) s.err ? day.failed++ : day.landed++;
    }
    if (sigs.length < 1000 || (sigs[sigs.length - 1].blockTime ?? 0) < firstDay) break;
    before = sigs[sigs.length - 1].signature;
    await sleep(150);
  }

  // ── Bonds ───────────────────────────────────────────────────────────────────
  const bondAccounts = await withRetry(() => conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: discriminator("BondAccount") } }],
  }));
  const blank = () => ({ wallet: 0, relayer: 0, other: 0 });
  const bonds = {
    sol: blank(), term: blank(), oldFormat: 0, neverClaimed: 0,
    harness: pool ? 0 : null as number | null,
    team: team ? 0 : null as number | null,
    termInVault: 0,
  };
  for (const { pubkey, account } of bondAccounts) {
    if (account.data.length !== BOND_SIZE) { bonds.oldFormat++; continue; }
    const b = coder.decode("BondAccount", account.data);
    const payer = b.rent_payer as PublicKey;
    // A wallet that paid its own rent is the bond's authority, whose bond PDA is this account.
    const who: Payer = relayerKey && payer.equals(relayerKey) ? "relayer"
      : pda("bond", payer).equals(pubkey) ? "wallet" : "other";
    (Number(b.kind) === 1 ? bonds.term : bonds.sol)[who]++;
    if (Number(b.last_claim_time) === 0) bonds.neverClaimed++;
    if (bonds.harness !== null && poolBonds.has(pubkey.toBase58())) bonds.harness++;
    else if (bonds.team !== null && teamBonds.has(pubkey.toBase58())) bonds.team++;
  }
  const vault = await withRetry(() => conn.getAccountInfo(pda("bond_term_vault")));
  bonds.termInVault = vault ? Number(vault.data.readBigUInt64LE(64)) / 1e6 : 0;

  const report = {
    cluster, rpc, chainTime: now,
    mining: { stopped, staleAfterHours, lastClaim, secondsSinceLastClaim: lastClaim ? now - lastClaim : null },
    program, state, miners,
    claimsPerDay: [...perDay].map(([day, c]) => ({ day, ...c })),
    bonds, relayer,
    harnessPool: pool ? {
      wallets: pool.length, listed: listed?.length ?? 0, localFile: local ? walletFile : null,
      unlisted: unlisted.map((pk) => pk.toBase58()),
    } : null,
    teamWallets: team ? {
      wallets: team.length, listed: teamListed?.length ?? 0, localFile: teamLocal ? bondCheckFile : null,
      unlisted: teamUnlisted.map((pk) => pk.toBase58()),
    } : null,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return stopped ? 2 : 0;
  }

  // ── Text report ─────────────────────────────────────────────────────────────
  const out: string[] = [];
  out.push(`Terminus Coin on ${cluster} · ${utc(now)} by the chain's clock`, "");
  out.push(lastClaim === null ? "Mining    STOPPED: no claim has ever landed"
    : stopped ? `Mining    STOPPED: no claim for ${ago(now - lastClaim)} (last ${utc(lastClaim)})`
    : `Mining    running: last claim ${ago(now - lastClaim)} ago`);
  const build = program.isScopeBuild ? `the ${program.scopeTag} build`
    : program.isScopeBuild === false ? `NOT the ${program.scopeTag} build`
    : program.matchesLocalBuild ? "the same as target/deploy/terminuscoin.so" : "";
  out.push(`Program   deployed ${program.deployedAt ? utc(program.deployedAt) : "(time unknown)"} in slot ${num(deployedSlot)}; ` +
    `sha256 ${sha256.slice(0, 8)}…${sha256.slice(-4)}${build ? `: ${build}` : ""}`);
  out.push(`State     difficulty ${num(Number(state.difficulty))} · ${num(state.totalClaims)} claims · ` +
    `${state.rateLimitSeconds}s rate limit · ${state.paused ? "PAUSED" : "not paused"}`, "");

  const counts = (label: string, c: Counts) => [label, c["24h"], c["7d"], c["30d"], c.ever];
  out.push(...table(["Miners, by last claim", "24h", "7d", "30d", "ever"], [
    counts("all", miners.all),
    ...(miners.harness ? [counts("load harness", miners.harness)] : []),
    ...(miners.team ? [counts("other team wallets", miners.team)] : []),
    ...(miners.others ? [counts("everyone else", miners.others)] : []),
  ]));
  const notListed = (keys: PublicKey[], file: string, list: string) =>
    `  ${keys.length} wallet${keys.length === 1 ? "" : "s"} in ${file} ${keys.length === 1 ? "is" : "are"} ` +
    `not in scripts/${list}, so other machines count ${keys.length === 1 ? "it" : "them"} as everyone else. Add ${keys.length === 1 ? "it" : "them"}.`;
  if (!pool) {
    out.push(`  The harness's wallets are not counted apart: neither ${HARNESS_KEYS} nor a pool file (${walletFile}) is here.`);
  } else if (unlisted.length) {
    out.push(notListed(unlisted, walletFile, "devnet_load_pubkeys.txt"));
  }
  if (teamUnlisted.length) out.push(notListed(teamUnlisted, bondCheckFile, "devnet_team_pubkeys.txt"));
  out.push("", ...table(["Claims per day (UTC)", "landed", "failed"],
    report.claimsPerDay.map(({ day, landed, failed }) => [day, landed, failed])));

  const kinds = (k: { wallet: number; relayer: number; other: number }) => k.wallet + k.relayer + k.other;
  out.push("", `Bonds     ${num(kinds(bonds.sol))} SOL, ${num(kinds(bonds.term))} TERM` +
    (bonds.oldFormat ? ` · ${bonds.oldFormat} in the old format from before 26 May, which can no longer claim` : ""));
  out.push(...table(["  rent paid by", "SOL", "TERM"],
    ([["the wallet", "wallet"], ["the relayer", "relayer"], ["someone else", "other"]] as const)
      .map(([label, who]) => [label, bonds.sol[who], bonds.term[who]])));
  out.push(`  ${num(bonds.neverClaimed)} never used to claim · ${num(bonds.termInVault)} TERM in the TERM bond vault` +
    (bonds.harness !== null ? ` · ${num(bonds.harness)} belong to the load harness` : "") +
    (bonds.team ? ` · ${num(bonds.team)} to other team wallets` : ""));
  if (!relayerKey) out.push("  (without the relayer's key, bonds it paid for are counted under \"someone else\")");

  out.push("");
  if (!relayer) {
    out.push("Relayer   not checked (set RELAYER_URL)");
  } else if ("error" in relayer) {
    out.push(`Relayer   ${relayer.url} did not answer: ${relayer.error}`);
  } else {
    out.push(`Relayer   ${relayer.pubkey} holds ${sol(relayer.balanceLamports as number)} SOL, ` +
      `about ${num(relayer.gaslessFirstClaims as number)} gasless first claims · ` +
      `daily cap ${sol(relayer.dailyCapLamports as number)} SOL, ${sol(relayer.dailySpentLamports as number)} spent today · ` +
      `bootstrap mode ${relayer.bootstrapMode ? "on" : "off"}`);
  }
  console.log(out.join("\n"));
  return stopped ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("Error:", String(err?.message ?? err).split("\n")[0]);
    process.exit(1);
  },
);
