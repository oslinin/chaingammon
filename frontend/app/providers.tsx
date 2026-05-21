"use client";

// Phase 12: wraps the app in WagmiProvider + react-query so client
// components can use wagmi hooks (useConnect, useAccount, useReadContract).
// Has to be a Client Component because both providers rely on React
// context, which doesn't exist on the server.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useAccount, useSwitchChain } from "wagmi";
import { useEffect, useState } from "react";

import { ComputeBackendsProvider } from "./ComputeBackendsContext";
import { ALL_CHAINS, config } from "./wagmi";
import { warmupOnnx } from "../lib/onnx_eval";
import { I18nProvider } from "./i18n";

// Silently switch to the app's default chain (Sepolia) when the wallet
// connects on an unsupported chain. MetaMask persists the chain across
// sessions, so this fires once and the prompt never reappears.
function AutoSwitchChain() {
  const { address, chainId: walletChainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const supportedIds = new Set(ALL_CHAINS.map((c) => c.id));
  const defaultChainId = ALL_CHAINS[0].id;

  useEffect(() => {
    if (address && walletChainId !== undefined && !supportedIds.has(walletChainId)) {
      switchChain({ chainId: defaultChainId });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, walletChainId]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  // One QueryClient per render tree, kept stable across renders. Avoids
  // re-creating the cache on every render, which would defeat caching.
  const [queryClient] = useState(() => new QueryClient());

  // Kick off ONNX WASM loading once at app startup so the model is ready
  // before the first agent move. warmupOnnx() is idempotent — re-renders and
  // React Strict Mode double-invocations are safe.
  useEffect(() => { warmupOnnx(); }, []);

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <AutoSwitchChain />
        <ComputeBackendsProvider>
          <I18nProvider>{children}</I18nProvider>
        </ComputeBackendsProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
