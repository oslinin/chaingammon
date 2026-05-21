// wagmi config built from `chains.ts` — the registry that pairs
// chainId → {viem Chain, deployed contract addresses}.
//
// To add a chain: edit `chains.ts`, not this file.

import { http } from "viem";
import { createConfig, createStorage, noopStorage } from "wagmi";
// Import `injected` from `@wagmi/core` rather than `wagmi/connectors` to
// avoid the latter's umbrella export, which transitively pulls in
// `@wagmi/core/tempo` — that file imports a missing `accounts` package
// and crashes Webpack at build time. Turbopack happens to skip the dead
// branch; Webpack does not. `walletConnect` is NOT in @wagmi/core so it
// comes from `@wagmi/connectors` directly (same avoidance of
// `wagmi/connectors` umbrella). next.config.ts aliases `accounts → false`
// so Webpack resolves the optional peer without crashing.
import { injected } from "@wagmi/core";
import { walletConnect } from "@wagmi/connectors";

import { ALL_CHAINS, CHAIN_REGISTRY } from "./chains";

const transports = Object.fromEntries(ALL_CHAINS.map((c) => [c.id, http()]));

// Explicit localStorage so the connection survives a page reload — required
// for MetaMask Mobile, which reloads its in-app browser when the dapp calls
// `wallet_switchEthereumChain`. wagmi's default storage is `localStorage`,
// but pinning it here documents the dependency and avoids future regressions
// (e.g. if a contributor toggles `ssr` and triggers a different default).
const storage = createStorage({
  storage: typeof window !== "undefined" ? window.localStorage : noopStorage,
});

// WalletConnect requires a Project ID from cloud.walletconnect.com.
// Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in your .env (or GitHub secrets
// for CI). If it is missing we skip the connector so the app still boots.
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

// WalletConnect uses IndexedDB for session persistence; guard against SSR
// where indexedDB is not defined.
const connectors =
  typeof window !== "undefined" && projectId
    ? [
        injected(),
        walletConnect({
          projectId,
          metadata: {
            name: "Chaingammon",
            description: "Open protocol for portable backgammon reputation",
            url: window.location.origin,
            icons: ["https://oslinin.github.io/chaingammon/favicon.ico"],
          },
          showQrModal: true,
        }),
      ]
    : [injected()];

export const config = createConfig({
  chains: ALL_CHAINS,
  connectors,
  transports,
  ssr: true,
  storage,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}

// Re-export the registry and full chain list for providers/hooks.
export { ALL_CHAINS, CHAIN_REGISTRY };

// Convenience aliases for the two chains we name in code (other code paths
// reference them by symbol). Both can be undefined if their deployment
// JSON is missing — guard at call sites.
export const ogTestnet = CHAIN_REGISTRY[16602]?.chain;
export const hardhatLocal = CHAIN_REGISTRY[31337]?.chain;
