import { useEffect, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useChainState, SUPPLY_CAP } from "./useChainState";
import { useMiner } from "./useMiner";

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
  const wallet = useWallet();
  const { state: chain, loading, initialized } = useChainState(connection);
  const { status, logs, hashrate, start, stop } = useMiner(connection, wallet);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const mining = status === "mining" || status === "submitting";
  const canMine = !!wallet.publicKey && !!chain && !chain.paused;

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
        <div className="header-title">TERMINUS COIN — MINER v{TERM_VERSION}</div>
        <div className="header-subtitle">
          Proof-of-Work SPL token on Solana &nbsp;|&nbsp; Program: FfA5sr…JH5Y
        </div>
      </div>

      {/* Wallet */}
      <div className="wallet-bar">
        <WalletMultiButton />
        {wallet.publicKey && (
          <span className="wallet-address">{wallet.publicKey.toBase58()}</span>
        )}
      </div>

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
