"use client";

// Wraps the app in WagmiProvider + react-query so client components can use
// wagmi hooks (useAccount, useReadContract, useWriteContract). MetaMask is
// connected directly through wagmi's injected() connector — no Privy layer.
// The connection state is persisted in localStorage so it survives page reloads.
//
// Has to be a Client Component because WagmiProvider and QueryClientProvider
// both rely on React context, which doesn't exist on the server.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useConnect } from "wagmi";
import { useEffect, useState } from "react";

import { ComputeBackendsProvider } from "./ComputeBackendsContext";
import { AppModeProvider } from "./AppModeContext";
import { config } from "./wagmi";
import { warmupOnnx } from "../lib/onnx_eval";
import { I18nProvider } from "./i18n";

// MetaMask mobile returns WC sessions with accounts but no chains in the eip155
// namespace. The WC UniversalProvider crashes on `undefined.includes(...)` when
// routing any request through that namespace. Patch the provider's request method
// to ensure chains is always populated before each call.
function WCNamespacePatch() {
  const { connectors } = useConnect();
  useEffect(() => {
    const wc = connectors.find((c) => c.id === "walletConnect");
    if (!wc) return;
    wc.getProvider().then((raw) => {
      if (!raw) return;
      const provider = raw as {
        request?: (...a: unknown[]) => Promise<unknown>;
        chainId?: number;
        session?: { namespaces?: Record<string, { accounts?: string[]; chains?: string[] }> };
      };
      if (typeof provider.request !== "function" || (provider.request as { _patched?: boolean })._patched) return;
      const original = provider.request.bind(provider);
      const patched = function (...args: unknown[]) {
        if (provider.session?.namespaces?.eip155) {
          const ns = provider.session.namespaces.eip155;
          if (!ns.chains) {
            const fromAccounts = (ns.accounts ?? []).map((a) => a.split(":").slice(0, 2).join(":"));
            const configChain = `eip155:${provider.chainId ?? 11155111}`;
            ns.chains = [...new Set([configChain, ...fromAccounts])];
          }
        }
        try {
          return original(...args);
        } catch (e) {
          // Swallow crashes from internal WC calls (e.g. switchEthereumChain
          // fired by session_event before signer is fully initialized).
          return Promise.reject(e);
        }
      };
      (patched as { _patched?: boolean })._patched = true;
      provider.request = patched as typeof provider.request;
    }).catch(() => {/* provider not ready yet — will be patched on next mount */});
  }, [connectors]);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  useEffect(() => { warmupOnnx(); }, []);

  // WalletConnect sessions expire on the relay (7-day TTL). When the page reloads
  // with a stale session in localStorage, wagmi throws an unhandled "No matching key"
  // rejection. Clear the stale WC data so the next connect starts fresh.
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      const msg = (event.reason as { message?: string })?.message ?? "";
      const isStaleSession = msg.includes("No matching key") || msg.includes("session topic");
      const isSuppressable = isStaleSession ||
        (msg.includes("Cannot read properties of undefined") && msg.includes("'request'"));
      if (isSuppressable) {
        event.preventDefault();
        // Only clear stale session data for relay-not-found errors.
        // The request error is an internal WC race condition — don't nuke the session.
        if (isStaleSession) {
          Object.keys(localStorage)
            .filter((k) => k.startsWith("wc@2:"))
            .forEach((k) => localStorage.removeItem(k));
        }
      }
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={config}>
          <WCNamespacePatch />
        <AppModeProvider>
          <ComputeBackendsProvider>
            <I18nProvider>{children}</I18nProvider>
          </ComputeBackendsProvider>
        </AppModeProvider>
      </WagmiProvider>
    </QueryClientProvider>
  );
}
