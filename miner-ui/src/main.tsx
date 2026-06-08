import React, { useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { BackpackWalletAdapter } from "@solana/wallet-adapter-backpack";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./terminal.css";
import App from "./App";

// Resolve the RPC endpoint at build time. Never silently default to a public
// network: a production build with VITE_RPC_URL unset fails loud — the
// client-side mirror of the server-side RPC_URL guard — instead of quietly
// running the whole app against devnet. In dev, default to the local validator
// (matches .env.example), which fails obviously (connection refused) if absent.
function resolveRpcUrl(): string {
  const url = import.meta.env.VITE_RPC_URL?.trim();
  if (url) return url;
  if (import.meta.env.PROD) {
    throw new Error(
      "VITE_RPC_URL is not set — refusing to default to a public RPC in a production build. " +
        "Set VITE_RPC_URL to your cluster's RPC at build time.",
    );
  }
  return "http://127.0.0.1:8899"; // dev default: local validator
}

const RPC_URL = resolveRpcUrl();

function Root() {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter(), new BackpackWalletAdapter()],
    []
  );
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
