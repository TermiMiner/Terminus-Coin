import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useChainState, SUPPLY_CAP } from "./useChainState";
import { useMiner } from "./useMiner";
import ClaimReveal from "./ClaimReveal";
import HelpTab from "./HelpTab";
import { minNetReward, deriveTipChoices, tipCeiling, MAX_TIP_TERM } from "./tipMath";
import { loadRelayers, probeAll, selectCheapest, addCustomRelayer, removeCustomRelayer, type RelayerStatus } from "./relayers";
import {
  BrowserKeypairWallet,
  BURNER_STORAGE_KEY,
  RELAYER_STORAGE_KEY,
  type MinerWallet,
} from "./burnerWallet";
import {
  type BroadcastAdapter,
  localRelayerAdapter,
  sharedRelayerAdapter,
  sharedTopUp,
  type SharedRelayerInfo,
} from "./relayerAdapter";
import { useStaking } from "./useStaking";
import { executeStakingAction } from "./stakingActions";
import logoUrl from "./assets/logo.jpg";

// First-claim setup costs: ATA rent (~0.00204 SOL) + bond_account rent (~0.00107 SOL)
// + user_state rent (~0.00100 SOL) = ~0.00411 SOL one-time. After setup, each
// self-fund claim costs ~5K lamports of tx fee — so 0.0075 SOL of topup
// covers setup + ~12 hours of 24/7 mining at the 60s cooldown.
// Threshold sits BELOW the topup amount so a freshly-topped burner doesn't
// immediately re-trigger the auto-topup path (which would fail per-wallet quota).
const BURNER_TOPUP_LAMPORTS  = 7_500_000;   // 0.0075 SOL per top-up
const BURNER_TOPUP_THRESHOLD = 4_000_000;   // re-topup attempt at burner < 0.004 SOL

const TERM_VERSION = "0.1.0";

function fmt6(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = raw % 1_000_000n;
  return `${whole.toLocaleString()}.${frac.toString().padStart(6, "0")}`;
}

function capPct(minted: bigint): string {
  return ((Number(minted) / Number(SUPPLY_CAP)) * 100).toFixed(6);
}

export default function App() {
  const { connection } = useConnection();
  const phantom = useWallet();
  const { state: chain, loading, initialized } = useChainState(connection);

  // Burner + (optional) local relayer wallets. Local relayer is for users
  // running `npm run dev` against their own keypair. The deployed site uses
  // a server-side shared relayer (see fetchSharedRelayerInfo).
  const [tab, setTab] = useState<"mine" | "stake" | "help">("mine");

  // Collapsible stats sections — default collapsed on mobile, persisted across reloads.
  // Initial value is read from localStorage, falling back to viewport width.
  const [statsCollapsed, setStatsCollapsed] = useState<boolean>(() => {
    const stored = localStorage.getItem("terminus.stats_collapsed");
    if (stored !== null) return stored === "1";
    return typeof window !== "undefined" && window.innerWidth <= 600;
  });
  useEffect(() => {
    localStorage.setItem("terminus.stats_collapsed", statsCollapsed ? "1" : "0");
  }, [statsCollapsed]);
  // Routing config (ROUTE / RELAYERS / MODE / tip) collapse — same pattern, own
  // key so it minimizes independently. Default collapsed on mobile so the relayer
  // + tip controls don't dominate small screens.
  const [configCollapsed, setConfigCollapsed] = useState<boolean>(() => {
    const stored = localStorage.getItem("terminus.config_collapsed");
    if (stored !== null) return stored === "1";
    return typeof window !== "undefined" && window.innerWidth <= 600;
  });
  useEffect(() => {
    localStorage.setItem("terminus.config_collapsed", configCollapsed ? "1" : "0");
  }, [configCollapsed]);

  // Relayer tip (raw TERM units, 6 decimals). 0 = no tip. Capped by
  // on-chain MAX_TIP_TERM = 5_000_000 (5 TERM). Default 0 preserves the
  // current SOL-relayer / self-fund behavior; positive values opt in to
  // the TERM-fee relayer market.
  const [claimTip, setClaimTip] = useState<number>(() => {
    const stored = localStorage.getItem("terminus.claim_tip");
    return stored !== null ? Number(stored) : 0;
  });
  useEffect(() => {
    localStorage.setItem("terminus.claim_tip", String(claimTip));
  }, [claimTip]);

  // Mining-mode override: lets the user pin routing manually instead of
  // the auto decision tree. "auto" preserves the existing self-fund-preferred
  // behavior. Explicit modes that aren't actually available (e.g. "shared"
  // when no shared relayer is configured) silently fall back to auto.
  type ModePreference = "auto" | "self-fund" | "shared" | "local";
  const [modePreference, setModePreference] = useState<ModePreference>(() => {
    const stored = localStorage.getItem("terminus.mode_preference");
    if (stored === "self-fund" || stored === "shared" || stored === "local") return stored;
    return "auto";
  });
  useEffect(() => {
    localStorage.setItem("terminus.mode_preference", modePreference);
  }, [modePreference]);

  // Background tab detection — mobile browsers throttle JS in hidden tabs.
  // When tab is hidden the status pill shows "TAB PAUSED" so users understand
  // why mining stalled when they return.
  const [tabHidden, setTabHidden] = useState(false);
  useEffect(() => {
    function onVis() { setTabHidden(document.hidden); }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const burner = useMemo(() => new BrowserKeypairWallet(BURNER_STORAGE_KEY), []);
  const relayer = useMemo(() => new BrowserKeypairWallet(RELAYER_STORAGE_KEY), []);
  const [walletVersion, setWalletVersion] = useState(0);
  const refreshWallets = () => setWalletVersion((v) => v + 1);
  void walletVersion;

  // Pick which wallet drives mining: prefer Phantom if connected, else burner.
  const activeWallet: MinerWallet = phantom.publicKey
    ? { publicKey: phantom.publicKey, signTransaction: phantom.signTransaction }
    : burner;

  // Probe ALL known relayers (bundled + runtime list + customs) and AUTO-select
  // the cheapest feasible one below. Re-probes on wallet change (per-wallet
  // quota) and every 30s. See relayers.ts.
  const [relayerStatuses, setRelayerStatuses] = useState<RelayerStatus[]>([]);
  // True once a full probe cycle has SUCCEEDED (relayer landscape is known).
  // Stays false while probing fails, so a SOL-less burner waits in `loading`
  // rather than being pushed to a topup it can't perform.
  const [sharedProbed, setSharedProbed] = useState(false);
  // Manual relayer pin (baseUrl) overriding AUTO selection; null = AUTO (cheapest).
  const [pinnedRelayer, setPinnedRelayer] = useState<string | null>(
    () => localStorage.getItem("terminus.pinned_relayer"),
  );
  useEffect(() => {
    if (pinnedRelayer === null) localStorage.removeItem("terminus.pinned_relayer");
    else localStorage.setItem("terminus.pinned_relayer", pinnedRelayer);
  }, [pinnedRelayer]);
  // Bump to force an immediate re-probe (after adding/removing a custom relayer).
  const [relayerListVersion, setRelayerListVersion] = useState(0);
  const [addRelayerInput, setAddRelayerInput] = useState("");
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const descs = await loadRelayers();
        const statuses = await probeAll(descs, activeWallet.publicKey ?? undefined);
        if (!cancelled) { setRelayerStatuses(statuses); setSharedProbed(true); }
      } catch { /* keep last statuses; the 30s interval retries */ }
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeWallet.publicKey?.toBase58(), relayerListVersion]);

  const isBurner = !phantom.publicKey && !!burner.publicKey;

  // Live SOL balances for active wallet, burner, local relayer (polled every 5s)
  const [activeSolBalance, setActiveSolBalance] = useState<number | null>(null);
  const [burnerBalance, setBurnerBalance] = useState<number | null>(null);
  const [relayerBalance, setRelayerBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    async function poll() {
      if (!connection || cancelled) return;
      const a = activeWallet.publicKey ? await connection.getBalance(activeWallet.publicKey).catch(() => null) : null;
      const b = burner.publicKey ? await connection.getBalance(burner.publicKey).catch(() => null) : null;
      const r = relayer.publicKey ? await connection.getBalance(relayer.publicKey).catch(() => null) : null;
      if (!cancelled) { setActiveSolBalance(a); setBurnerBalance(b); setRelayerBalance(r); }
    }
    poll();
    const id = setInterval(poll, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [connection, burner, relayer, walletVersion, activeWallet.publicKey?.toBase58()]);

  // Net-reward ceiling for tips (min(MAX_TIP_TERM, base-block net); see tipMath)
  // and the AUTO-selected relayer — cheapest FEASIBLE among all probed relayers.
  // `shared` is just the selected relayer's info, so the mode machinery below is
  // unchanged: with one relayer (the bundled same-origin one) this is byte-
  // identical to the previous single-relayer behavior. Selection is deterministic
  // "prefer-home" — cheapest feasible, near-ties broken toward the bundled relayer
  // (see selectCheapest). NOT randomized: distributing load across ≥2 production
  // relayers is a deferred, ranking-based design (MAINNET_CHECKLIST §7), never a
  // render-time random.
  const tipCeil = chain
    ? Number(tipCeiling(minNetReward(chain.launchTime, chain.difficulty, BigInt(Math.floor(Date.now() / 1000)))))
    : Number(MAX_TIP_TERM);
  // AUTO = cheapest feasible; a manual pin overrides it (honored even if the
  // pinned relayer's floor is infeasible — the tipFloorBlocksStart guard then
  // blocks Start and warns). A pinned relayer that's gone/unreachable OR out of
  // daily quota falls back to AUTO — routing to a no-quota relayer would just
  // 429 at broadcast on every claim. (Reliability failover is still deferred.)
  const selectedRelayer = (() => {
    if (pinnedRelayer !== null) {
      const pinned = relayerStatuses.find((s) => s.desc.baseUrl === pinnedRelayer);
      if (
        pinned?.reachable && pinned.info?.pubkey
        && (pinned.info.dailyRemaining === undefined || pinned.info.dailyRemaining > 0)
      ) {
        return pinned;
      }
    }
    return selectCheapest(relayerStatuses, tipCeil);
  })();
  const shared: SharedRelayerInfo | null = selectedRelayer?.info ?? null;
  const tipFloor = shared?.minTipTerm ?? 0;

  // Availability — relayers that are set up for this user. Used for topup
  // decisions (the start() wrapper uses these to choose how to fund a
  // burner that's running low), independent of which routing the next
  // claim will take.
  //
  // Shared relayer accepts ANY wallet (Phantom included) — only the topup
  // pathway is burner-specific. Local relayer keypair is browser-only and
  // only meaningful in burner-mode setups.
  const sharedAvailable = !!shared && !!activeWallet.publicKey;
  const localAvailable  = !shared && isBurner && !!relayer.publicKey;

  // Routing preference — self-fund FIRST when the wallet can pay its own
  // way. Each self-funded claim costs ~5K lamports; through a relayer it
  // costs the relayer ~5K SOL AND the user a 0.5 TERM tip (under bootstrap
  // mode). Self-fund is strictly better when feasible. Relayer routing is
  // reserved as a SUBSIDY/fallback for fresh wallets without SOL.
  //
  // Cold first-claim cost (self-fund — the wallet pays all rent + fee) ≈ 4.39M
  // lamports: user TERM ATA 2,039,280 + bond (57B) 1,287,600 + UserState (24B)
  // 1,057,920 + ~5K fee. The gate MUST exceed this, or a wallet passes here and
  // then fails on-chain at first claim (this stranded a real wallet). Repeat
  // claims cost only the ~5K fee. 4.6M leaves ~0.2M headroom for fee variance.
  const SELF_FUND_MIN_LAMPORTS = 4_600_000;
  const burnerSolReady = isBurner && burnerBalance !== null && burnerBalance >= SELF_FUND_MIN_LAMPORTS;
  // External wallets (Phantom) must actually have SOL to self-fund — connecting
  // without funds is not enough. The previous logic let any connected Phantom
  // pretend to be self-fund-ready, so users with empty wallets clicked Start
  // and got cryptic "insufficient lamports" errors mid-claim.
  const externalWalletSelfFundable = !isBurner && !!activeWallet.publicKey
    && activeSolBalance !== null && activeSolBalance >= SELF_FUND_MIN_LAMPORTS;
  const externalWalletNeedsFunding = !isBurner && !!activeWallet.publicKey
    && activeSolBalance !== null && activeSolBalance < SELF_FUND_MIN_LAMPORTS;
  type MiningMode = "loading" | "shared" | "local" | "self-fund-ready"
                  | "self-fund-needs-topup" | "external-needs-funding" | "no-wallet";
  let miningMode: MiningMode;
  if (!activeWallet.publicKey) miningMode = "no-wallet";
  else if (isBurner && shared === null && burnerBalance === null) miningMode = "loading";
  else if (!isBurner && activeSolBalance === null) miningMode = "loading";
  // Explicit user override — but only honored if actually achievable.
  else if (modePreference === "shared" && sharedAvailable) miningMode = "shared";
  else if (modePreference === "local" && localAvailable) miningMode = "local";
  else if (modePreference === "self-fund" && (burnerSolReady || externalWalletSelfFundable)) miningMode = "self-fund-ready";
  else if (modePreference === "self-fund" && isBurner) miningMode = "self-fund-needs-topup";
  else if (modePreference === "self-fund" && externalWalletNeedsFunding) miningMode = "external-needs-funding";
  // Auto fallthrough: self-fund preferred when wallet has SOL, else relayer.
  // A burner that can't self-fund and whose shared-relayer availability isn't
  // known yet waits for the probe (else it shows "needs topup" instead of
  // defaulting to SHARED — and on a slow/failed probe would be stuck there).
  // Explicit self-fund is handled above, so it isn't held up by this.
  else if (isBurner && !burnerSolReady && !sharedProbed) miningMode = "loading";
  else if (burnerSolReady || externalWalletSelfFundable) miningMode = "self-fund-ready";
  else if (sharedAvailable) miningMode = "shared";
  else if (localAvailable) miningMode = "local";
  else if (isBurner) miningMode = "self-fund-needs-topup";
  else if (externalWalletNeedsFunding) miningMode = "external-needs-funding";
  else miningMode = "self-fund-ready"; // unreachable in practice — sanity fallback

  // Broadcaster is derived from the mining mode. Self-fund modes don't use
  // a broadcaster (the wallet signs directly).
  const broadcaster: BroadcastAdapter | undefined =
    miningMode === "shared" && selectedRelayer?.info
      ? sharedRelayerAdapter(selectedRelayer.info.pubkey, selectedRelayer.desc.baseUrl)
    : miningMode === "local" ? (localRelayerAdapter(relayer) ?? undefined)
    : undefined;

  // Backwards-compat shims used in the burner-warning text below.
  const sharedActive = miningMode === "shared";
  const localActive  = miningMode === "local";

  // Tip preset ladder + Start gate, from the bounds computed above (tipFloor /
  // tipCeil): OFF/floor/2×/4× clamped to the net-reward ceiling.
  const { choices: tipChoices, floorInfeasible: tipFloorInfeasible } = deriveTipChoices(tipFloor, tipCeil);
  // Block Start when an explicitly-routed relayer's floor exceeds the base-block
  // net reward — those claims fail tip<=net_reward on ≥50% of blocks. AUTO never
  // selects an infeasible relayer, so this is dormant until manual relayer
  // pinning (step ③); prompt a route switch instead.
  const tipFloorBlocksStart = miningMode === "shared" && tipFloorInfeasible;

  // Auto-nudge the tip up to the active relayer's advertised floor whenever the
  // effective mining mode is SHARED and that relayer advertises a minTipTerm.
  // Gated on the floor itself (not bootstrapMode) so it stays correct once the
  // floor is decoupled from the launch phase. Gating on miningMode (not
  // modePreference) catches both explicit-SHARED and AUTO-resolves-to-SHARED, so
  // a 0-SOL burner in AUTO doesn't sit at tip=0 and get rejected on every repeat
  // claim. claimTip deliberately omitted from deps: prevents the effect from
  // re-firing if the user lowers the tip below the floor manually.
  useEffect(() => {
    if (
      miningMode === "shared" &&
      shared?.minTipTerm !== undefined &&
      shared.minTipTerm > 0 &&
      claimTip < shared.minTipTerm
    ) {
      setClaimTip(shared.minTipTerm);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miningMode, shared?.minTipTerm]);

  // Tip is only meaningful when a relayer is active. In self-fund mode, the
  // "tip" would be a no-op self-transfer (miner ATA → miner ATA) that just
  // burns compute units and confuses balances. Force 0 unless relayed.
  const effectiveTip = (miningMode === "shared" || miningMode === "local") ? claimTip : 0;
  const { status, logs, hashrate, lastEvent, start: rawStart, stop } = useMiner(
    connection,
    activeWallet,
    broadcaster,
    effectiveTip,
  );

  // Wrap start() so we can auto-top-up the burner before the first claim.
  const start = async () => {
    if (!isBurner || !burner.publicKey || burnerBalance === null) {
      rawStart(); return;
    }
    if (burnerBalance >= BURNER_TOPUP_THRESHOLD) { rawStart(); return; }
    // In shared/local mode the relayer signs as both fee_payer and rent_payer,
    // so the burner needs zero SOL. Skip the topup — otherwise we'd burn the
    // per-wallet quota slot to deliver SOL that just sits unused. If the user
    // later switches to a self-fund mode, the "needs topup" state will gate
    // mining and the manual topup button handles it.
    if (miningMode === "shared" || miningMode === "local") {
      rawStart(); return;
    }
    try {
      // Only reaches here in self-fund modes — burner actually needs the SOL.
      if (sharedAvailable) {
        await sharedTopUp(burner.publicKey, selectedRelayer?.desc.baseUrl ?? "");
      } else if (localAvailable) {
        await relayer.topUp(connection, burner.publicKey, BURNER_TOPUP_LAMPORTS);
      } else {
        // No relayer at all — burner has to fund itself. Just start; mining
        // will fail with a clear "no SOL for fees" error if balance too low.
      }
    } catch (err: any) {
      alert(`Top-up failed: ${err.message ?? err}`);
      return;
    }
    rawStart();
  };

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const mining = status === "mining" || status === "submitting";
  // Gate Start while mining mode is still resolving — previously, clicking
  // Start before shared relayer info loaded silently sent the user into
  // self-fund mode without them realizing.
  const canMine = !!activeWallet.publicKey && !!chain && !chain.paused
    && miningMode !== "loading" && miningMode !== "no-wallet"
    && miningMode !== "self-fund-needs-topup"
    && miningMode !== "external-needs-funding"
    && !tipFloorBlocksStart;

  // ── One-click start (new-user onboarding) ────────────────────────────────
  // With no wallet connected, pressing Start generates a burner and — once its
  // mode resolves to a mineable state — begins mining on AUTO (the default), so a
  // brand-new crypto user needs zero config. Passive visitors get no wallet until
  // they ask. A fresh 0-SOL burner routes through the relayer automatically.
  const [autoStartPending, setAutoStartPending] = useState(false);
  const canOneClick = !activeWallet.publicKey && !!chain && !chain.paused;
  const handleStartClick = () => {
    if (!activeWallet.publicKey) {
      handleGenerateBurner();
      setAutoStartPending(true);
    } else {
      start();
    }
  };
  useEffect(() => {
    if (!autoStartPending) return;
    if (mining) { setAutoStartPending(false); return; }
    if (canMine) { setAutoStartPending(false); start(); return; }
    // Settled into a state needing user action → stop waiting; the burner now
    // exists, so the normal UI takes over (topup prompt, route switch, etc.).
    if (miningMode === "self-fund-needs-topup"
      || miningMode === "external-needs-funding"
      || tipFloorBlocksStart) {
      setAutoStartPending(false);
    }
    // else miningMode === "loading" → keep waiting for the probe + balance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartPending, canMine, mining, miningMode, tipFloorBlocksStart]);

  function handleGenerateBurner() {
    burner.generate();
    refreshWallets();
  }

  function handleImportBurner() {
    const json = prompt("Paste secret key (any format):\n• JSON array  [12,34,...]\n• base58      vFM2d7k...\n• hex         0a1b2c...");
    if (!json) return;
    try {
      burner.importFromJson(json.trim());
      refreshWallets();
    } catch (err: any) {
      alert(`Import failed: ${err.message ?? err}`);
    }
  }

  function handleExportBurner() {
    const json = burner.exportAsJson();
    if (!json) return;
    const ok = confirm(
      "EXPORT WARNING\n\n" +
      "The next dialog will reveal your burner wallet's secret key.\n" +
      "Anyone with this key controls the wallet's funds and any TERM you've mined.\n\n" +
      "Continue?"
    );
    if (!ok) return;
    prompt("Burner secret key (copy this somewhere safe):", json);
  }

  function handleClearBurner() {
    const ok = confirm(
      "CLEAR BURNER\n\n" +
      "This deletes the burner keypair from this browser. " +
      "Any TERM held by this burner will be UNRECOVERABLE unless you exported the key first.\n\n" +
      "Continue?"
    );
    if (!ok) return;
    burner.clear();
    refreshWallets();
  }

  function handleGenerateRelayer() { relayer.generate(); refreshWallets(); }

  function handleImportRelayer() {
    const json = prompt("Paste relayer secret key (any format):\n• JSON array  [12,34,...]\n• base58      vFM2d7k...\n• hex         0a1b2c...");
    if (!json) return;
    try { relayer.importFromJson(json.trim()); refreshWallets(); }
    catch (err: any) { alert(`Import failed: ${err.message ?? err}`); }
  }

  function handleExportRelayer() {
    const json = relayer.exportAsJson();
    if (!json) return;
    const ok = confirm(
      "EXPORT WARNING\n\n" +
      "Anyone with this key can drain the relayer's SOL.\n\nContinue?"
    );
    if (!ok) return;
    prompt("Relayer secret key:", json);
  }

  function handleClearRelayer() {
    const ok = confirm(
      "CLEAR RELAYER\n\n" +
      "Any SOL left in the relayer becomes UNRECOVERABLE unless you exported the key first.\n\nContinue?"
    );
    if (!ok) return;
    relayer.clear();
    refreshWallets();
  }

  async function handleTopUpBurner() {
    if (!burner.publicKey) return;
    try {
      if (sharedAvailable) {
        const res = await sharedTopUp(burner.publicKey);
        const detail = res.skipped ? "(already funded)" : `tx: ${res.signature?.slice(0, 16)}…`;
        alert(`Shared-relayer top-up: ${detail}`);
      } else if (localAvailable && connection) {
        const sig = await relayer.topUp(connection, burner.publicKey, BURNER_TOPUP_LAMPORTS);
        alert(`Local-relayer top-up: ${(BURNER_TOPUP_LAMPORTS / 1e9).toFixed(3)} SOL\ntx: ${sig.slice(0, 16)}…`);
      } else {
        alert("No relayer available to top up the burner — send SOL to the burner address manually.");
      }
    } catch (err: any) {
      alert(`Top-up failed: ${err.message ?? err}`);
    }
  }

  // Single placeholder used by every stat tile while we wait for first fetch
  const placeholder = loading ? "…" : (initialized ? "—" : "—");
  const chainStatusLabel =
    loading ? "CONNECTING…" :
    !initialized ? "NOT INITIALIZED" :
    chain?.paused ? "PAUSED" : "LIVE";

  // ── Staking state + actions ──
  const staking = useStaking(connection, activeWallet.publicKey);
  const [stakeInput, setStakeInput] = useState("");
  const [unstakeInput, setUnstakeInput] = useState("");
  const [stakeBusy, setStakeBusy] = useState<null | "stake" | "unstake" | "claim">(null);
  const [stakeMsg, setStakeMsg] = useState<string | null>(null);

  function fmtTerm(raw: bigint): string {
    const whole = raw / 1_000_000n;
    const frac = raw % 1_000_000n;
    return `${whole.toLocaleString()}.${frac.toString().padStart(6, "0")}`;
  }

  async function runStaking(action: "stake" | "unstake" | "claim", amountStr?: string) {
    if (!connection || !activeWallet.publicKey) return;
    let amount = 0n;
    if (action !== "claim") {
      const n = Number(amountStr ?? "0");
      if (!Number.isFinite(n) || n <= 0) { setStakeMsg("Enter a positive amount"); return; }
      amount = BigInt(Math.round(n * 1_000_000)); // TERM has 6 decimals
    }
    setStakeBusy(action); setStakeMsg(null);
    try {
      const res = await executeStakingAction(
        connection,
        activeWallet,
        broadcaster,
        action === "claim" ? "claim_yield" : action,
        amount
      );
      setStakeMsg(`Done. tx ${res.signature.slice(0, 16)}…`);
      if (action === "stake")   setStakeInput("");
      if (action === "unstake") setUnstakeInput("");
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      setStakeMsg(`Failed: ${msg.slice(0, 140)}`);
    } finally {
      setStakeBusy(null);
    }
  }

  // APY estimate (epoch 0, current burn rate, current total_staked)
  // Annual treasury inflow = claims/yr × (base × treasury_bps + claim_fee)
  // For epoch 0: 17 TERM × 3% + 0.01 = 0.52 TERM per claim with stakers
  // Claims/yr at target = (100/600) × 31_557_600 = 5,259,600
  const apyEstimate = (() => {
    if (staking.poolTotalStaked === 0n) return null;
    const treasuryPerClaim = 17_000_000n * 300n / 10_000n + 10_000n; // 0.52 TERM in raw
    const annualInflow = treasuryPerClaim * 5_259_600n;
    const apy = Number(annualInflow * 10000n / staking.poolTotalStaked) / 100;
    return apy;
  })();

  return (
    <div className="terminal">
      <ClaimReveal lastEvent={lastEvent} />
      {/* Header */}
      <div className="header">
        <img src={logoUrl} alt="Terminus Coin" className="header-logo" />
        <div className="header-text">
          <div className="header-title">TERMINUS COIN — MINER v{TERM_VERSION}</div>
          <div className="header-subtitle">
            Proof-of-Work SPL token on Solana &nbsp;|&nbsp; Program: FfA5sr…JH5Y
          </div>
        </div>
      </div>

      {/* Wallet */}
      <div className="wallet-bar">
        <WalletMultiButton />
        {!phantom.publicKey && !burner.publicKey && (
          <>
            <span className="wallet-address">— or —</span>
            <button className="btn" onClick={handleGenerateBurner}>[ GENERATE BURNER ]</button>
            <button className="btn" onClick={handleImportBurner}>[ IMPORT BURNER ]</button>
          </>
        )}
        {isBurner && (
          <>
            <span className="status-pill mining">BURNER</span>
            <span className="wallet-address">{burner.publicKey!.toBase58()}</span>
            <button className="btn" onClick={handleExportBurner}>[ EXPORT KEY ]</button>
            <button className="btn" onClick={handleClearBurner}>[ CLEAR ]</button>
          </>
        )}
        {phantom.publicKey && (
          <span className="wallet-address">{phantom.publicKey.toBase58()}</span>
        )}
      </div>

      {phantom.publicKey && (
        <div className="phantom-tip">
          Tip: Phantom prompts a confirmation for each claim. Generate a burner for continuous, autonomous mining.
        </div>
      )}

      {/* Active wallet balances */}
      {activeWallet.publicKey && (
        <div className="wallet-bar wallet-balances">
          <span className="wallet-address">BALANCE:</span>
          <span className="balance-pill sol">
            {activeSolBalance !== null ? `${(activeSolBalance / 1e9).toFixed(4)} SOL` : "… SOL"}
          </span>
          <span className="balance-pill term">
            {!staking.loading ? `${fmtTerm(staking.walletBalance)} TERM` : "… TERM"}
          </span>
        </div>
      )}

      {/* Primary action — hoisted to the top, above the routing config + tabs,
          so the main CTA isn't buried. Persists across tabs. */}
      <div className="controls">
        {!mining ? (
          <button
            className="btn primary-action"
            disabled={(!canMine && !canOneClick) || autoStartPending}
            onClick={handleStartClick}
            title={canOneClick ? "Generates a burner wallet and starts mining on AUTO — no setup needed" : undefined}
          >
            [ {autoStartPending ? "STARTING…" : "START MINING"} ]
          </button>
        ) : (
          <button className="btn primary-action active" onClick={stop}>
            [ STOP ]
          </button>
        )}

        <span className={`status-pill ${status === "idle" ? "idle" : status === "error" ? "error" : "mining"}`}>
          {tabHidden && mining ? "TAB PAUSED" : status.toUpperCase()}
        </span>

        {chain?.paused && (
          <span className="status-pill error">PROGRAM PAUSED</span>
        )}
      </div>

      {/* Routing config (ROUTE / RELAYERS / MODE / tip) — collapsible so it
          doesn't crowd the CTA or small screens; default collapsed on mobile. */}
      {activeWallet.publicKey && (
      <div className="stats-section">
        <button
          className="stats-header"
          onClick={() => setConfigCollapsed((v) => !v)}
          aria-expanded={!configCollapsed}
        >
          <span>ROUTING {configCollapsed ? "▸" : "▾"}</span>
          {configCollapsed && (
            <span className="stats-summary">
              {miningMode === "shared" ? `via ${selectedRelayer?.desc.name ?? "relayer"}`
                : miningMode === "local" ? "via local relayer"
                : miningMode === "self-fund-ready" ? "self-fund"
                : miningMode === "self-fund-needs-topup" ? "needs topup"
                : miningMode === "external-needs-funding" ? "wallet needs SOL"
                : miningMode === "loading" ? "resolving…" : "—"}
              {(miningMode === "shared" || miningMode === "local") && claimTip > 0
                && ` · tip ${(claimTip / 1e6).toFixed(2)} TERM`}
            </span>
          )}
        </button>
        {!configCollapsed && (<>

      {/* Mode preference selector — user override for routing. AUTO defers
          to the self-fund-preferred decision tree; explicit choices pin the
          routing if achievable, otherwise silently fall back to auto. */}
      {activeWallet.publicKey && (() => {
        const canShared = sharedAvailable;
        const canLocal = localAvailable;
        const canSelf = burnerSolReady || externalWalletSelfFundable || isBurner;
        const options: { value: ModePreference; label: string; enabled: boolean; title: string }[] = [
          { value: "auto",      label: "AUTO",      enabled: true,
            title: "Self-fund when burner has SOL, otherwise route through relayer" },
          { value: "self-fund", label: "SELF-FUND", enabled: canSelf,
            title: canSelf ? "Always pay your own SOL" : "Self-fund requires a wallet" },
          { value: "shared",    label: "SHARED",    enabled: canShared,
            title: canShared ? "Always route through the shared relayer" : "No shared relayer is configured" },
          { value: "local",     label: "LOCAL",     enabled: canLocal,
            title: canLocal ? "Always route through your local relayer" : "No local relayer is set up" },
        ];
        // Detect when the user picked a mode that isn't available — show a hint.
        const requested = modePreference;
        const honored =
          requested === "auto" ||
          (requested === "shared" && canShared) ||
          (requested === "local" && canLocal) ||
          (requested === "self-fund" && canSelf);
        return (
          <div className="wallet-bar">
            <span className="wallet-address" title="Pin how the next claim will be routed; AUTO uses the smart default">
              ROUTE:
            </span>
            {options.map(({ value, label, enabled, title }) => (
              <button
                key={value}
                className={`btn ${modePreference === value ? "active" : ""}`}
                onClick={() => setModePreference(value)}
                disabled={!enabled}
                title={title}
                style={!enabled ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
              >
                [ {label} ]
              </button>
            ))}
            {!honored && (
              <span className="wallet-address" style={{ color: "#ff9933" }} title="Falling back to AUTO because the chosen mode isn't currently available">
                · fallback → auto
              </span>
            )}
          </div>
        );
      })()}

      {/* RELAYERS — the discovered relayer set: probed status, the AUTO/pinned
          selection, and add/remove for custom URLs. Shown when relayer routing
          is in play (AUTO or SHARED). */}
      {activeWallet.publicKey
        && (modePreference === "auto" || modePreference === "shared" || miningMode === "shared")
        && relayerStatuses.length > 0 && (
        <div className="wallet-bar" style={{ flexWrap: "wrap" }}>
          <span className="wallet-address" title="Relayers from the bundled list, runtime roster, and your custom URLs. AUTO routes through the cheapest feasible one; PIN forces a specific relayer.">
            RELAYERS:
          </span>
          {relayerStatuses.map((s) => {
            const sel = selectedRelayer?.desc.baseUrl === s.desc.baseUrl;
            const floor = s.info?.minTipTerm ?? 0;
            const ready = s.reachable
              && floor <= tipCeil
              && (s.info?.dailyRemaining === undefined || s.info.dailyRemaining > 0);
            const state = !s.reachable ? "○ down"
              : floor > tipCeil ? "⚠ floor too high"
              : (s.info?.dailyRemaining !== undefined && s.info.dailyRemaining <= 0) ? "⚠ no quota"
              : "● ready";
            const name = s.desc.name ?? (s.desc.baseUrl === "" ? "same-origin" : s.desc.baseUrl.replace(/^https:\/\//, ""));
            const isPinned = pinnedRelayer === s.desc.baseUrl;
            return (
              <span key={s.desc.baseUrl} className="wallet-address"
                style={{ color: sel ? "#00ff99" : ready ? undefined : "var(--grey)" }}>
                {isPinned ? "📌 " : sel ? "★ " : ""}{name}
                {s.reachable && ` · ${(floor / 1e6).toFixed(2)} TERM`} · {state}
                {(s.reachable || isPinned) && (
                  <button className="btn" style={{ marginLeft: 4 }}
                    onClick={() => setPinnedRelayer(isPinned ? null : s.desc.baseUrl)}
                    title={isPinned ? "Unpin — return to AUTO (cheapest feasible)" : "Pin — always route through this relayer"}>
                    [ {isPinned ? "AUTO" : "PIN"} ]
                  </button>
                )}
                {s.desc.source === "custom" && (
                  <button className="btn" style={{ marginLeft: 2 }}
                    onClick={() => {
                      removeCustomRelayer(s.desc.baseUrl);
                      if (pinnedRelayer === s.desc.baseUrl) setPinnedRelayer(null);
                      setRelayerListVersion((v) => v + 1);
                    }}
                    title="Remove this custom relayer">
                    [ × ]
                  </button>
                )}
              </span>
            );
          })}
          <input
            placeholder="add relayer https URL…"
            value={addRelayerInput}
            onChange={(e) => setAddRelayerInput(e.target.value)}
            style={{ minWidth: 180, background: "transparent", border: "1px solid var(--grey)",
                     color: "inherit", padding: "2px 6px", font: "inherit" }}
          />
          <button className="btn"
            onClick={() => {
              if (addCustomRelayer(addRelayerInput)) { setAddRelayerInput(""); setRelayerListVersion((v) => v + 1); }
              else alert("Enter a valid https relayer URL, e.g. https://relay.example.com");
            }}
            title="Add a custom relayer by URL (https only)">
            [ + ADD ]
          </button>
        </div>
      )}

      {/* MODE — single source of truth for how the next claim will be routed.
          Replaces the prior SHARED/LOCAL RELAYER bars which let users guess. */}
      {activeWallet.publicKey && (() => {
        const modeColor =
          miningMode === "shared" || miningMode === "local" ? "#00ff99"
          : miningMode === "self-fund-ready" ? "#00ff99"
          : miningMode === "self-fund-needs-topup" ? "#ff9933"
          : miningMode === "external-needs-funding" ? "#ff9933"
          : "var(--grey)";
        const modeLabel =
          miningMode === "shared" ? "VIA SHARED RELAYER"
          : miningMode === "local" ? "VIA LOCAL RELAYER"
          : miningMode === "self-fund-ready" ? "SELF-FUND"
          : miningMode === "self-fund-needs-topup" ? "SELF-FUND (needs topup)"
          : miningMode === "external-needs-funding" ? "WALLET NEEDS SOL"
          : miningMode === "loading" ? "INITIALISING…"
          : "NO WALLET";
        return (
          <div className="wallet-bar">
            <span className="wallet-address" style={{ color: modeColor }}>
              MODE: {modeLabel}
            </span>
            {miningMode === "shared" && shared && (
              <>
                <span className="wallet-address">
                  relayer {selectedRelayer?.desc.name ? `${selectedRelayer.desc.name} ` : ""}{shared.pubkey.toBase58().slice(0, 8)}… ({(shared.balance / 1e9).toFixed(4)} SOL)
                </span>
                {shared.dailyRemaining !== undefined && (
                  <span className="wallet-address" title="Total relayer SOL outflow remaining today (resets daily)">
                    · {(shared.dailyRemaining / 1e9).toFixed(3)} SOL left today
                  </span>
                )}
                {shared.wallet && (
                  <span className="wallet-address" title="Topup grants remaining for this wallet">
                    · {shared.wallet.topupsRemaining}/{shared.wallet.topupsMax} free topups
                  </span>
                )}
              </>
            )}
            {miningMode === "local" && relayer.publicKey && (
              <span className="wallet-address">
                relayer {relayer.publicKey.toBase58().slice(0, 8)}…
                {relayerBalance !== null && ` (${(relayerBalance / 1e9).toFixed(4)} SOL)`}
              </span>
            )}
            {(miningMode === "self-fund-ready" || miningMode === "self-fund-needs-topup") && isBurner && (
              <span className="wallet-address">
                burner {burnerBalance !== null ? `${(burnerBalance / 1e9).toFixed(4)} SOL` : "…"}
                {miningMode === "self-fund-needs-topup" && burner.publicKey && (sharedAvailable || localAvailable) && (
                  <> · <button className="btn" onClick={handleTopUpBurner} style={{ marginLeft: 4 }}>[ TOP UP BURNER ]</button></>
                )}
              </span>
            )}
            {miningMode === "self-fund-ready" && isBurner && sharedAvailable && (
              <span className="wallet-address" style={{ color: "var(--grey)" }} title="If your burner runs low, the shared relayer can top it up">
                · shared relayer available (fallback)
              </span>
            )}
            {miningMode === "external-needs-funding" && (
              <span className="wallet-address">
                {activeSolBalance !== null ? `${(activeSolBalance / 1e9).toFixed(4)} SOL` : "…"}
                {" · "}
                fund your wallet (faucet.solana.com) or pick a relayer route
                {sharedAvailable && <> · or pick <b>SHARED</b></>}
              </span>
            )}
          </div>
        );
      })()}

      {/* Local-relayer setup row — only when there's no shared and no local yet,
          and the user is on a burner (so they actually need one). */}
      {!shared && isBurner && !relayer.publicKey && (
        <div className="wallet-bar">
          <span className="wallet-address" style={{ color: "var(--grey)" }}>
            LOCAL RELAYER (optional):
          </span>
          <button className="btn" onClick={handleGenerateRelayer}>[ GENERATE RELAYER ]</button>
          <button className="btn" onClick={handleImportRelayer}>[ IMPORT RELAYER ]</button>
        </div>
      )}

      {/* Local-relayer management row — visible once one is set up. */}
      {!shared && isBurner && relayer.publicKey && (
        <div className="wallet-bar">
          <span className="wallet-address" style={{ color: "var(--grey)" }}>LOCAL RELAYER:</span>
          <span className="wallet-address">{relayer.publicKey.toBase58().slice(0, 16)}…</span>
          <button className="btn" onClick={handleExportRelayer}>[ EXPORT ]</button>
          <button className="btn" onClick={handleClearRelayer}>[ CLEAR ]</button>
        </div>
      )}

      {/* Bootstrap relayer sunset banner — appears only inside the sunset
          window (operator sets BOOTSTRAP_SUNSET_DATE env var + DEPRECATION_BANNER_DAYS). */}
      {shared?.deprecation && (
        <div className="wallet-bar" style={{ borderColor: "#ff9933", color: "#ff9933" }}>
          <span className="wallet-address" style={{ color: "#ff9933" }}>
            ⚠ {shared.deprecation.message}
          </span>
        </div>
      )}

      {/* Claim tip — only meaningful when a relayer is active (self-fund hides
          this; effectiveTip is forced to 0 there). Presets are DERIVED from the
          active relayer's advertised floor and clamped to what a base-block
          claim can actually pay — min(MAX_TIP_TERM, minNetReward) — since the
          program enforces tip <= net_reward. See tipMath.ts. */}
      {(miningMode === "shared" || miningMode === "local") && (
        <div className="wallet-bar">
          <span className="wallet-address" title="Tip in TERM paid to the relayer out of each claim's reward. 0 = no tip (relayer covers its own costs).">
            CLAIM TIP:
          </span>
          {tipFloor > 0 && (
            <span className="wallet-address" style={{ color: "#ff9933" }} title="The relayer requires at least this tip per repeat claim. First-ever claims are subsidized under bootstrap.">
              min {(tipFloor / 1_000_000).toFixed(2)} TERM
            </span>
          )}
          {/* Presets derived in tipMath.deriveTipChoices: OFF only when the
              relayer has no floor; rungs clamped to the net-reward ceiling. */}
          {tipChoices.map(({ raw, label }) => (
            <button
              key={raw}
              className={`btn ${claimTip === raw ? "active" : ""}`}
              onClick={() => setClaimTip(raw)}
              title={raw === 0 ? "Self-fund: relayer absorbs SOL costs" : `Tip ${label} TERM per claim`}
            >
              [ {label === "off" ? "OFF" : `${label} TERM`} ]
            </button>
          ))}
          {/* Custom tip outside the derived presets */}
          {claimTip > 0 && !tipChoices.some((c) => c.raw === claimTip) && (
            <span className="wallet-address" style={{ color: "#00ff99" }}>
              · custom: {(claimTip / 1_000_000).toFixed(3)} TERM
            </span>
          )}
          {/* Infeasible floor: floor > base-block net reward. Start is blocked
              (canMine → tipFloorBlocksStart) because every ordinary block would
              fail tip<=net_reward on-chain; prompt a route switch instead. */}
          {tipFloorInfeasible && (
            <span className="wallet-address" style={{ color: "#ff5555" }} title="This relayer's floor exceeds the current base-block net reward, so an ordinary claim would fail the on-chain tip<=net_reward rule on ≥50% of blocks. Mining through this relayer is paused — switch to self-fund (or another relayer when available).">
              ⚠ floor &gt; base-block reward — mining paused, switch routes
            </span>
          )}
        </div>
      )}

      {(isBurner || relayer.publicKey) && (
        <div className="burner-warning">
          ⚠ Browser-stored burner keypair. Secret key lives in localStorage —
          devnet/testing only. Do not put significant value in this wallet.
          {sharedActive && (
            <> Fee-payer is operated server-side; the SOL pool is funded
              and visible above. Burners get auto-topped-up before first claim.
            </>
          )}
          {localActive && (
            <> Fund the relayer with devnet SOL via{" "}
              <code>solana airdrop 1 {relayer.publicKey?.toBase58()} --url devnet</code>{" "}
              — burners get auto-topped-up at mining start when below 0.008 SOL.
            </>
          )}
        </div>
      )}
        </>)}
      </div>
      )}

      {/* Tab strip */}
      <div className="tab-strip">
        <button className={`tab ${tab === "mine" ? "active" : ""}`} onClick={() => setTab("mine")}>[ MINE ]</button>
        <button className={`tab ${tab === "stake" ? "active" : ""}`} onClick={() => setTab("stake")}>[ STAKE ]</button>
        <button className={`tab ${tab === "help" ? "active" : ""}`} onClick={() => setTab("help")}>[ HELP ]</button>
      </div>

      {tab === "mine" && (<>

      {/* Chain stats — collapsible */}
      <div className="stats-section">
        <button
          className="stats-header"
          onClick={() => setStatsCollapsed((v) => !v)}
          aria-expanded={!statsCollapsed}
        >
          <span>STATS {statsCollapsed ? "▸" : "▾"}</span>
          {statsCollapsed && chain && (
            <span className="stats-summary">
              1/{chain.difficulty.toLocaleString()}
              {" · "}{chain.totalClaims.toLocaleString()} claims
              {" · "}{chainStatusLabel}
            </span>
          )}
        </button>
        {!statsCollapsed && (
          <div className="stats-grid">
            <div className="stat-box">
              <div className="stat-label">Difficulty</div>
              <div className={`stat-value ${chain && chain.difficulty >= 1_000_000n ? "amber" : ""}`}>
                {chain ? `1 / ${chain.difficulty.toLocaleString()}` : placeholder}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Total Claims</div>
              <div className="stat-value">
                {chain ? chain.totalClaims.toLocaleString() : placeholder}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Total Minted</div>
              <div className="stat-value">
                {chain ? `${fmt6(chain.totalMinted)} TERM` : placeholder}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Supply Used</div>
              <div className="stat-value">
                {chain ? `${capPct(chain.totalMinted)}%` : placeholder}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Treasury</div>
              <div className="stat-value">
                {chain ? `${fmt6(chain.treasuryBalance)} TERM` : placeholder}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Hashrate</div>
              <div className={`stat-value ${hashrate && hashrate < 10_000 ? "amber" : ""}`}>
                {hashrate ? `${hashrate.toLocaleString()} H/s` : "—"}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Status</div>
              <div className={`stat-value ${chain?.paused || (!loading && !initialized) ? "red" : ""}`}>
                {chainStatusLabel}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Last Hash</div>
              <div className="stat-value" style={{ fontSize: 11, letterSpacing: "0.02em" }}>
                {chain ? Buffer.from(chain.lastHash).toString("hex").slice(0, 16) + "…" : placeholder}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Log pane */}
      <div className="log-pane" ref={logRef}>
        {logs.map((l) => (
          <div key={l.id} className={`log-line ${l.level}`}>
            {l.text}
          </div>
        ))}
      </div>

      </>)}

      {tab === "stake" && (<>
      {/* Staking actions — hoisted above stats for parity with the mine tab */}
      <div className="controls" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            className="stake-input"
            type="number"
            placeholder="amount to stake"
            value={stakeInput}
            onChange={(e) => setStakeInput(e.target.value)}
            disabled={!activeWallet.publicKey || stakeBusy !== null}
            min={0}
            step="0.000001"
          />
          <button
            className="btn"
            disabled={!activeWallet.publicKey || stakeBusy !== null || !stakeInput}
            onClick={() => runStaking("stake", stakeInput)}
          >
            {stakeBusy === "stake" ? "[ STAKING… ]" : "[ STAKE ]"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            className="stake-input"
            type="number"
            placeholder="amount to unstake"
            value={unstakeInput}
            onChange={(e) => setUnstakeInput(e.target.value)}
            disabled={!activeWallet.publicKey || stakeBusy !== null || staking.staked === 0n}
            min={0}
            step="0.000001"
          />
          <button
            className="btn"
            disabled={!activeWallet.publicKey || stakeBusy !== null || !unstakeInput || staking.staked === 0n}
            onClick={() => runStaking("unstake", unstakeInput)}
          >
            {stakeBusy === "unstake" ? "[ UNSTAKING… ]" : "[ UNSTAKE ]"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn"
            disabled={!activeWallet.publicKey || stakeBusy !== null || staking.pendingYield === 0n}
            onClick={() => runStaking("claim")}
          >
            {stakeBusy === "claim" ? "[ CLAIMING… ]" : `[ CLAIM YIELD${staking.pendingYield > 0n ? ` — ${fmtTerm(staking.pendingYield)} TERM` : ""} ]`}
          </button>
        </div>
        {stakeMsg && <div className="log-line dim" style={{ paddingTop: 6 }}>{stakeMsg}</div>}
      </div>

      {/* Position — collapsible */}
      <div className="stats-section">
        <button
          className="stats-header"
          onClick={() => setStatsCollapsed((v) => !v)}
          aria-expanded={!statsCollapsed}
        >
          <span>POSITION {statsCollapsed ? "▸" : "▾"}</span>
          {statsCollapsed && activeWallet.publicKey && (
            <span className="stats-summary">
              {fmtTerm(staking.staked)} staked
              {" · "}{fmtTerm(staking.pendingYield)} pending
              {" · "}{staking.hasStakeAccount ? "STAKER" : "NOT STAKED"}
            </span>
          )}
        </button>
        {!statsCollapsed && (
          <div className="stats-grid">
            <div className="stat-box">
              <div className="stat-label">Wallet balance</div>
              <div className="stat-value">{activeWallet.publicKey ? `${fmtTerm(staking.walletBalance)} TERM` : placeholder}</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Staked</div>
              <div className="stat-value">{activeWallet.publicKey ? `${fmtTerm(staking.staked)} TERM` : placeholder}</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Pending yield</div>
              <div className="stat-value">{activeWallet.publicKey ? `${fmtTerm(staking.pendingYield)} TERM` : placeholder}</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Pool share</div>
              <div className="stat-value">
                {staking.poolTotalStaked > 0n && staking.staked > 0n
                  ? `${(Number(staking.staked * 10000n / staking.poolTotalStaked) / 100).toFixed(2)}%`
                  : "0.00%"}
              </div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Pool total staked</div>
              <div className="stat-value">{fmtTerm(staking.poolTotalStaked)} TERM</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Treasury</div>
              <div className="stat-value">{fmtTerm(staking.poolTreasury)} TERM</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Est. APY (epoch 0)</div>
              <div className="stat-value">{apyEstimate !== null ? `${apyEstimate.toFixed(1)}%` : "—"}</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Status</div>
              <div className="stat-value">{staking.loading ? "LOADING…" : (staking.hasStakeAccount ? "STAKER" : "NOT STAKED")}</div>
            </div>
          </div>
        )}
      </div>
      </>)}

      {tab === "help" && (
        <HelpTab
          burner={burner}
          isBurner={isBurner}
          walletConnected={!!activeWallet.publicKey}
        />
      )}

      {/* Footer */}
      <div className="footer">
        Supply cap: 1,000,000,000 TERM &nbsp;|&nbsp; Burn: 0.25–5% &nbsp;|&nbsp; Treasury: 3%
        &nbsp;|&nbsp; RPC: {import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8899"}
      </div>
    </div>
  );
}
