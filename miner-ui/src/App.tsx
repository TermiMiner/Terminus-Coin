import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useChainState, SUPPLY_CAP } from "./useChainState";
import { useMiner } from "./useMiner";
import {
  BrowserKeypairWallet,
  BURNER_STORAGE_KEY,
  RELAYER_STORAGE_KEY,
  type MinerWallet,
} from "./burnerWallet";
import {
  type BroadcastAdapter,
  fetchSharedRelayerInfo,
  localRelayerAdapter,
  sharedRelayerAdapter,
  sharedTopUp,
  type SharedRelayerInfo,
} from "./relayerAdapter";
import { useStaking } from "./useStaking";
import { executeStakingAction } from "./stakingActions";
import logoUrl from "./assets/logo.jpg";

// First-claim setup costs: ATA rent (~0.00204 SOL) + bond_account rent (~0.00107 SOL)
// + user_state rent (~0.00100 SOL) = ~0.00411 SOL one-time. Top up generously
// so the first claim has room to spare.
const BURNER_TOPUP_LAMPORTS  = 15_000_000;  // 0.015 SOL per top-up
const BURNER_TOPUP_THRESHOLD = 8_000_000;   // top up when burner < 0.008 SOL

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
  const [tab, setTab] = useState<"mine" | "stake">("mine");

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

  // Probe the deployment for a configured shared relayer (also re-fetches
  // when activeWallet changes so per-wallet quota info reflects the right key).
  const [shared, setShared] = useState<SharedRelayerInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      fetchSharedRelayerInfo(activeWallet.publicKey ?? undefined)
        .then((info) => { if (!cancelled) setShared(info); });
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeWallet.publicKey?.toBase58()]);
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

  // Availability — relayers that are set up for this user. Used for topup
  // decisions (the start() wrapper uses these to choose how to fund a
  // burner that's running low), independent of which routing the next
  // claim will take.
  const sharedAvailable = !!shared && isBurner;
  const localAvailable  = !shared && isBurner && !!relayer.publicKey;

  // Routing preference — self-fund FIRST when the wallet can pay its own
  // way. Each self-funded claim costs ~5K lamports; through a relayer it
  // costs the relayer ~5K SOL AND the user a 0.5 TERM tip (under bootstrap
  // mode). Self-fund is strictly better when feasible. Relayer routing is
  // reserved as a SUBSIDY/fallback for fresh wallets without SOL.
  //
  // Burner self-fund needs ≥ ~0.003 SOL (bond + UserState + ATA + tx fee
  // for first claim). Repeat claims need far less; the first-claim
  // threshold is the conservative "ready" check.
  const SELF_FUND_MIN_LAMPORTS = 3_500_000;
  const burnerSolReady = isBurner && burnerBalance !== null && burnerBalance >= SELF_FUND_MIN_LAMPORTS;
  const externalWalletSelfFundable = !isBurner && !!activeWallet.publicKey;
  type MiningMode = "loading" | "shared" | "local" | "self-fund-ready" | "self-fund-needs-topup" | "no-wallet";
  let miningMode: MiningMode;
  if (!activeWallet.publicKey) miningMode = "no-wallet";
  else if (isBurner && shared === null && burnerBalance === null) miningMode = "loading";
  else if (burnerSolReady || externalWalletSelfFundable) miningMode = "self-fund-ready";
  else if (sharedAvailable) miningMode = "shared";
  else if (localAvailable) miningMode = "local";
  else if (isBurner) miningMode = "self-fund-needs-topup";
  else miningMode = "self-fund-ready"; // unreachable in practice — sanity fallback

  // Broadcaster is derived from the mining mode. Self-fund modes don't use
  // a broadcaster (the wallet signs directly).
  const broadcaster: BroadcastAdapter | undefined =
    miningMode === "shared" && shared ? sharedRelayerAdapter(shared.pubkey)
    : miningMode === "local" ? (localRelayerAdapter(relayer) ?? undefined)
    : undefined;

  // Backwards-compat shims used in the burner-warning text below.
  const sharedActive = miningMode === "shared";
  const localActive  = miningMode === "local";

  // Tip is only meaningful when a relayer is active. In self-fund mode, the
  // "tip" would be a no-op self-transfer (miner ATA → miner ATA) that just
  // burns compute units and confuses balances. Force 0 unless relayed.
  const effectiveTip = (miningMode === "shared" || miningMode === "local") ? claimTip : 0;
  const { status, logs, hashrate, start: rawStart, stop } = useMiner(
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
    try {
      // Topup uses whichever relayer is AVAILABLE, regardless of which
      // mode mining will use afterwards. (Burner will likely self-fund
      // claims once topped up.)
      if (sharedAvailable) {
        await sharedTopUp(burner.publicKey);
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
    && miningMode !== "self-fund-needs-topup";

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

      {/* MODE — single source of truth for how the next claim will be routed.
          Replaces the prior SHARED/LOCAL RELAYER bars which let users guess. */}
      {activeWallet.publicKey && (() => {
        const modeColor =
          miningMode === "shared" || miningMode === "local" ? "#00ff99"
          : miningMode === "self-fund-ready" ? "#00ff99"
          : miningMode === "self-fund-needs-topup" ? "#ff9933"
          : "var(--grey)";
        const modeLabel =
          miningMode === "shared" ? "VIA SHARED RELAYER"
          : miningMode === "local" ? "VIA LOCAL RELAYER"
          : miningMode === "self-fund-ready" ? "SELF-FUND"
          : miningMode === "self-fund-needs-topup" ? "SELF-FUND (needs topup)"
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
                  relayer {shared.pubkey.toBase58().slice(0, 8)}… ({(shared.balance / 1e9).toFixed(4)} SOL)
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

      {/* Claim tip — only meaningful when a relayer is active. Self-fund mode
          hides this entirely (effectiveTip is forced to 0 anyway). Presets
          are in TERM raw units (6 decimals); MAX_TIP_TERM = 5 TERM = 5_000_000
          raw. Default 0 = no tip. When bootstrap mode is on, repeat claims
          must tip at least minTipTerm. */}
      {(miningMode === "shared" || miningMode === "local") && (
        <div className="wallet-bar">
          <span className="wallet-address" title="Tip in TERM paid to the relayer out of each claim's reward. 0 = no tip (relayer covers its own costs).">
            CLAIM TIP:
          </span>
          {shared?.bootstrapMode && shared.minTipTerm !== undefined && shared.minTipTerm > 0 && (
            <span className="wallet-address" style={{ color: "#ff9933" }} title="The shared relayer requires this minimum tip per claim. First-ever claims are subsidized.">
              min {(shared.minTipTerm / 1_000_000).toFixed(2)} TERM
            </span>
          )}
          {[
            { raw: 0,         label: "off" },
            { raw: 500_000,   label: "0.5" },
            { raw: 1_000_000, label: "1" },
            { raw: 2_000_000, label: "2" },
          ].map(({ raw, label }) => (
            <button
              key={raw}
              className={`btn ${claimTip === raw ? "active" : ""}`}
              onClick={() => setClaimTip(raw)}
              title={raw === 0 ? "Self-fund: relayer absorbs SOL costs" : `Tip ${label} TERM per claim`}
            >
              [ {label === "off" ? "OFF" : `${label} TERM`} ]
            </button>
          ))}
          {/* Custom tip outside the presets — shows when value is non-zero and not a preset */}
          {claimTip > 0 && ![500_000, 1_000_000, 2_000_000].includes(claimTip) && (
            <span className="wallet-address" style={{ color: "#00ff99" }}>
              · custom: {(claimTip / 1_000_000).toFixed(3)} TERM
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

      {/* Tab strip */}
      <div className="tab-strip">
        <button className={`tab ${tab === "mine" ? "active" : ""}`} onClick={() => setTab("mine")}>[ MINE ]</button>
        <button className={`tab ${tab === "stake" ? "active" : ""}`} onClick={() => setTab("stake")}>[ STAKE ]</button>
      </div>

      {tab === "mine" && (<>

      {/* Controls — hoisted above stats so the primary action isn't buried */}
      <div className="controls">
        {!mining ? (
          <button className="btn primary-action" disabled={!canMine} onClick={start}>
            [ START MINING ]
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

      {/* Footer */}
      <div className="footer">
        Supply cap: 1,000,000,000 TERM &nbsp;|&nbsp; Burn: 1% &nbsp;|&nbsp; Treasury: 0.5%
        &nbsp;|&nbsp; RPC: {import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8899"}
      </div>
    </div>
  );
}
