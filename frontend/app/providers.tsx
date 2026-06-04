"use client";

// Wraps the app in wagmi's WagmiProvider + react-query so client
// components can use wagmi hooks (useAccount, useReadContract, etc.).
// The injected() connector in wagmi.ts handles MetaMask (and other
// browser-injected wallets) in Chrome, Firefox, and Brave natively.
// Mobile users without an injected wallet see the "Open in MetaMask"
// deep link rendered by ConnectButton.
//
// Has to be a Client Component because WagmiProvider and
// QueryClientProvider both rely on React context, which doesn't exist
// on the server.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useAccount, useSwitchChain } from "wagmi";
import { useEffect, useState } from "react";

import { ComputeBackendsProvider } from "./ComputeBackendsContext";
import { AppModeProvider } from "./AppModeContext";
import { ALL_CHAINS, config } from "./wagmi";
import { warmupOnnx } from "../lib/onnx_eval";
import { I18nProvider } from "./i18n";

// Silently switch to the app's default chain (Sepolia) when the wallet
// connects on an unsupported chain. MetaMask persists the chain across
// sessions, so this fires once and the prompt never reappears.
//
// Split into two components so wagmi hooks only run on the client.
// During SSR the wagmi context is not yet hydrated; calling useAccount()
// there throws WagmiProviderNotFoundError even though WagmiProvider wraps
// this component — wagmi's provider only becomes active after client-side
// hydration.
function AutoSwitchChainEffect() {
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

function AutoSwitchChain() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return mounted ? <AutoSwitchChainEffect /> : null;
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
        <AppModeProvider>
          <ComputeBackendsProvider>
            <I18nProvider>{children}</I18nProvider>
          </ComputeBackendsProvider>
        </AppModeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
