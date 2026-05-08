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
  const burner = useMemo(() => new BrowserKeypairWallet(BURNER_STORAGE_KEY), []);
  const relayer = useMemo(() => new BrowserKeypairWallet(RELAYER_STORAGE_KEY), []);
  const [walletVersion, setWalletVersion] = useState(0);
  const refreshWallets = () => setWalletVersion((v) => v + 1);
  void walletVersion;

  // Probe the deployment for a configured shared relayer.
  const [shared, setShared] = useState<SharedRelayerInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchSharedRelayerInfo().then((info) => { if (!cancelled) setShared(info); });
    // Re-poll the shared balance every 30s for transparency
    const id = setInterval(() => {
      fetchSharedRelayerInfo().then((info) => { if (!cancelled) setShared(info); });
    }, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Live SOL balances for burner + local relayer (polled every 5s)
  const [burnerBalance, setBurnerBalance] = useState<number | null>(null);
  const [relayerBalance, setRelayerBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    async function poll() {
      if (!connection || cancelled) return;
      const b = burner.publicKey ? await connection.getBalance(burner.publicKey).catch(() => null) : null;
      const r = relayer.publicKey ? await connection.getBalance(relayer.publicKey).catch(() => null) : null;
      if (!cancelled) { setBurnerBalance(b); setRelayerBalance(r); }
    }
    poll();
    const id = setInterval(poll, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [connection, burner, relayer, walletVersion]);

  // Pick which wallet drives mining: prefer Phantom if connected, else burner.
  const activeWallet: MinerWallet = phantom.publicKey
    ? { publicKey: phantom.publicKey, signTransaction: phantom.signTransaction }
    : burner;
  const isBurner = !phantom.publicKey && !!burner.publicKey;

  // Choose broadcaster: shared (server) > local (browser) > none.
  const broadcaster: BroadcastAdapter | undefined =
    shared ? sharedRelayerAdapter(shared.pubkey)
    : (isBurner ? localRelayerAdapter(relayer) ?? undefined : undefined);
  const sharedActive = !!shared && isBurner;
  const localActive  = !shared && isBurner && !!relayer.publicKey;

  const { status, logs, hashrate, start: rawStart, stop } = useMiner(
    connection,
    activeWallet,
    broadcaster
  );

  // Wrap start() so we can auto-top-up the burner before the first claim.
  const start = async () => {
    if (!isBurner || !burner.publicKey || burnerBalance === null) {
      rawStart(); return;
    }
    if (burnerBalance >= BURNER_TOPUP_THRESHOLD) { rawStart(); return; }
    try {
      if (sharedActive) {
        await sharedTopUp(burner.publicKey);
      } else if (localActive) {
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
  const canMine = !!activeWallet.publicKey && !!chain && !chain.paused;

  function handleGenerateBurner() {
    burner.generate();
    refreshWallets();
  }

  function handleImportBurner() {
    const json = prompt("Paste keypair JSON (64-element number array, same format as solana-keygen):");
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
    const json = prompt("Paste relayer keypair JSON (64-element number array):");
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

  async function handleManualTopUp() {
    if (!connection || !relayer.publicKey || !burner.publicKey) return;
    try {
      const sig = await relayer.topUp(connection, burner.publicKey, BURNER_TOPUP_LAMPORTS);
      alert(`Top-up sent: ${(BURNER_TOPUP_LAMPORTS / 1e9).toFixed(3)} SOL\ntx: ${sig.slice(0, 16)}…`);
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
            <span className="wallet-address">
              {burner.publicKey!.toBase58()}
              {burnerBalance !== null && ` (${(burnerBalance / 1e9).toFixed(4)} SOL)`}
            </span>
            <button className="btn" onClick={handleExportBurner}>[ EXPORT KEY ]</button>
            <button className="btn" onClick={handleClearBurner}>[ CLEAR ]</button>
          </>
        )}
        {phantom.publicKey && (
          <span className="wallet-address">{phantom.publicKey.toBase58()}</span>
        )}
      </div>

      {/* Relayer — shared (server) takes precedence; local (browser) is fallback */}
      {shared ? (
        <div className="wallet-bar">
          <span className="wallet-address" style={{ color: sharedActive ? "#00ff99" : "var(--grey)" }}>
            SHARED RELAYER {sharedActive ? "ON" : "READY"}:
          </span>
          <span className="wallet-address">
            {shared.pubkey.toBase58()} ({(shared.balance / 1e9).toFixed(4)} SOL)
          </span>
        </div>
      ) : (
        <div className="wallet-bar">
          <span className="wallet-address" style={{ color: localActive ? "#00ff99" : "var(--grey)" }}>
            LOCAL RELAYER {localActive ? "ON" : (relayer.publicKey ? "READY" : "OFF")}:
          </span>
          {!relayer.publicKey && (
            <>
              <button className="btn" onClick={handleGenerateRelayer}>[ GENERATE RELAYER ]</button>
              <button className="btn" onClick={handleImportRelayer}>[ IMPORT RELAYER ]</button>
            </>
          )}
          {relayer.publicKey && (
            <>
              <span className="wallet-address">
                {relayer.publicKey.toBase58()}
                {relayerBalance !== null && ` (${(relayerBalance / 1e9).toFixed(4)} SOL)`}
              </span>
              {burner.publicKey && (
                <button className="btn" onClick={handleManualTopUp}>[ TOP UP BURNER ]</button>
              )}
              <button className="btn" onClick={handleExportRelayer}>[ EXPORT ]</button>
              <button className="btn" onClick={handleClearRelayer}>[ CLEAR ]</button>
            </>
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

      {/* Chain stats */}
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

      {/* Controls */}
      <div className="controls">
        {!mining ? (
          <button className="btn" disabled={!canMine} onClick={start}>
            [ START MINING ]
          </button>
        ) : (
          <button className="btn active" onClick={stop}>
            [ STOP ]
          </button>
        )}

        <span className={`status-pill ${status === "idle" ? "idle" : status === "error" ? "error" : "mining"}`}>
          {status.toUpperCase()}
        </span>

        {chain?.paused && (
          <span className="status-pill error">PROGRAM PAUSED</span>
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

      {/* Footer */}
      <div className="footer">
        Supply cap: 1,000,000,000 TERM &nbsp;|&nbsp; Burn: 1% &nbsp;|&nbsp; Treasury: 0.5%
        &nbsp;|&nbsp; RPC: {import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8899"}
      </div>
    </div>
  );
}
