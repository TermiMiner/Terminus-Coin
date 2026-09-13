import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";

/**
 * Which Solana cluster the UI is actually pointed at.
 *
 * Derived from the cluster's genesis hash rather than from VITE_RPC_URL, because
 * the URL is not a reliable signal: private RPC providers hand out opaque
 * per-key hostnames, so string-matching "devnet" in the endpoint would misread a
 * mainnet deployment (and vice versa) exactly when it matters most.
 *
 * "local" covers `solana-test-validator`, whose genesis hash is regenerated on
 * every --reset and therefore never matches a known cluster.
 */
export type Cluster = "mainnet" | "devnet" | "testnet" | "local" | "unknown";

const GENESIS: Record<string, Cluster> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

/**
 * Resolves the cluster once per connection. Starts as "unknown" and settles when
 * the genesis hash comes back.
 *
 * Copy that differs between real and play money must be written so that
 * "unknown" reads correctly too — this resolves a tick after first paint, and an
 * RPC outage can leave it unresolved indefinitely. `isPlayMoney` below is the
 * safe way to branch: it only relaxes the warning once the cluster is known NOT
 * to be mainnet.
 */
export function useCluster(connection: Connection | undefined): Cluster {
  const [cluster, setCluster] = useState<Cluster>("unknown");

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    connection
      .getGenesisHash()
      .then((hash) => {
        if (!cancelled) setCluster(GENESIS[hash] ?? "local");
      })
      .catch(() => {
        // Leave "unknown" — the copy is written to stay accurate that way.
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  return cluster;
}

/**
 * True only when the cluster is *known* to carry worthless SOL/TERM. "unknown"
 * is deliberately not play money: an unresolved cluster must never downgrade a
 * real-value warning.
 */
export function isPlayMoney(cluster: Cluster): boolean {
  return cluster === "devnet" || cluster === "testnet" || cluster === "local";
}

/** CLI flag for `solana` commands against this cluster, e.g. `--url devnet`. */
export function clusterUrlFlag(cluster: Cluster): string {
  switch (cluster) {
    case "devnet":
      return "--url devnet";
    case "testnet":
      return "--url testnet";
    case "local":
      return "--url localhost";
    default:
      return "--url mainnet-beta";
  }
}
