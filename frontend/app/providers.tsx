"use client";

// Phase 12: wraps the app in WagmiProvider + react-query so client
// components can use wagmi hooks (useConnect, useAccount, useReadContract).
// Has to be a Client Component because both providers rely on React
// context, which doesn't exist on the server.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useEffect, useState } from "react";

import { ComputeBackendsProvider } from "./ComputeBackendsContext";
import { config } from "./wagmi";
import { warmupOnnx } from "../lib/onnx_eval";
import { I18nProvider } from "./i18n";

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
        <ComputeBackendsProvider>
          <I18nProvider>{children}</I18nProvider>
        </ComputeBackendsProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
