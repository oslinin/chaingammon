"use client";

// Phase 12: wraps the app in WagmiProvider + react-query so client
// components can use wagmi hooks (useConnect, useAccount, useReadContract).
// Has to be a Client Component because both providers rely on React
// context, which doesn't exist on the server.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useState } from "react";

import { config } from "./wagmi";

export function Providers({ children }: { children: React.ReactNode }) {
  // One QueryClient per render tree, kept stable across renders. Avoids
  // re-creating the cache on every render, which would defeat caching.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
