"use client";

// Wraps the app in WagmiProvider + react-query so client components can use
// wagmi hooks (useAccount, useReadContract, useWriteContract). MetaMask is
// connected directly through wagmi's injected() connector — no Privy layer.
// The connection state is persisted in localStorage so it survives page reloads.
//
// Has to be a Client Component because WagmiProvider and QueryClientProvider
// both rely on React context, which doesn't exist on the server.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useEffect, useState } from "react";

import { ComputeBackendsProvider } from "./ComputeBackendsContext";
import { AppModeProvider } from "./AppModeContext";
import { config } from "./wagmi";
import { warmupOnnx } from "../lib/onnx_eval";
import { I18nProvider } from "./i18n";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  useEffect(() => { warmupOnnx(); }, []);

  // WalletConnect sessions expire on the relay (7-day TTL). When the page reloads
  // with a stale session in localStorage, wagmi throws an unhandled "No matching key"
  // rejection. Clear the stale WC data so the next connect starts fresh.
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      const msg = (event.reason as { message?: string })?.message ?? "";
      if (msg.includes("No matching key") || msg.includes("session topic")) {
        event.preventDefault();
        Object.keys(localStorage)
          .filter((k) => k.startsWith("wc@2:"))
          .forEach((k) => localStorage.removeItem(k));
      }
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={config}>
        <AppModeProvider>
          <ComputeBackendsProvider>
            <I18nProvider>{children}</I18nProvider>
          </ComputeBackendsProvider>
        </AppModeProvider>
      </WagmiProvider>
    </QueryClientProvider>
  );
}
