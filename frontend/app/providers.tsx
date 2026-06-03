"use client";

// Wraps the app in PrivyProvider + Privy's WagmiProvider + react-query so
// client components can use Privy hooks (usePrivy, useWallets) and wagmi
// hooks (useAccount, useReadContract). PrivyProvider owns the connector
// list — email/Google login produces a Privy embedded wallet, while
// MetaMask (injected) and WalletConnect surface as external connectors.
// Both flows expose a single active wallet through `useAccount()` so the
// rest of the app (ProfileBadge, ENS lookup, on-chain reads) is
// connector-agnostic.
//
// Has to be a Client Component because PrivyProvider, WagmiProvider, and
// QueryClientProvider all rely on React context, which doesn't exist on
// the server.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
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
// this component — @privy-io/wagmi's provider only becomes active after
// client-side hydration.
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

// Privy App ID. Required for Privy to initialise — without it the login
// modal cannot mount. Provision a free app at https://dashboard.privy.io
// and put the ID in `frontend/.env` (or `.env.local`).
//
// Privy validates the app ID format (must be exactly 25 chars). When the
// env var is unset we fall back to a 25-char placeholder so PrivyProvider
// still mounts in dev / CI / preview builds — the bundle renders, the
// "Log in" button is interactable, and clicking it surfaces Privy's own
// "invalid app ID" error message in the modal. This keeps SSR + Playwright
// from crashing the whole page when the secret isn't wired up.
const PRIVY_APP_ID =
  process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "MISSING-PRIVY-APP-ID-ENV0";

// WalletConnect Project ID — Privy forwards this to the WalletConnect
// connector it constructs internally. Get a free Project ID from
// https://cloud.walletconnect.com. Without it, the WalletConnect option
// in the Privy modal is disabled (email/Google still work).
const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export function Providers({ children }: { children: React.ReactNode }) {
  // One QueryClient per render tree, kept stable across renders. Avoids
  // re-creating the cache on every render, which would defeat caching.
  const [queryClient] = useState(() => new QueryClient());

  // Kick off ONNX WASM loading once at app startup so the model is ready
  // before the first agent move. warmupOnnx() is idempotent — re-renders and
  // React Strict Mode double-invocations are safe.
  useEffect(() => { warmupOnnx(); }, []);

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        // Three login methods per requirements: email and Google (each
        // generates a Privy embedded wallet for the user), plus the
        // generic "wallet" entry that covers MetaMask (injected) and
        // WalletConnect-compatible mobile wallets.
        loginMethods: ["email", "google", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#C99B5C",
          walletList: ["wallet_connect"],
          showWalletLoginFirst: false,
        },
        embeddedWallets: {
          ethereum: {
            // Auto-create an embedded wallet only for users who haven't
            // linked an external wallet (e.g. email/Google login). Users
            // who connect MetaMask use that wallet directly.
            createOnLogin: "users-without-wallets",
          },
        },
        // Forward the WalletConnect Project ID so the modal can render
        // the WalletConnect QR option. Falls back to undefined when
        // unset — Privy then hides that option.
        walletConnectCloudProjectId: WALLETCONNECT_PROJECT_ID,
        externalWallets: {
          walletConnect: { enabled: Boolean(WALLETCONNECT_PROJECT_ID) },
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={config}>
          <AutoSwitchChain />
          <AppModeProvider>
            <ComputeBackendsProvider>
              <I18nProvider>{children}</I18nProvider>
            </ComputeBackendsProvider>
          </AppModeProvider>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
