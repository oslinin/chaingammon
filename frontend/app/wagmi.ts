// wagmi config built from `chains.ts` — the registry that pairs
// chainId → {viem Chain, deployed contract addresses}.
//
// To add a chain: edit `chains.ts`, not this file.

import { http } from "viem";
import { createConfig } from "wagmi";
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

// WalletConnect requires a Project ID from cloud.walletconnect.com.
// Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in your .env (or GitHub secrets
// for CI). If it is missing we skip the connector so the app still boots.
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

const connectors = projectId
  ? [
      injected({ shimDisconnect: true }),
      walletConnect({
        projectId,
        metadata: {
          name: "Chaingammon",
          description: "Open protocol for portable backgammon reputation",
          url:
            typeof window !== "undefined"
              ? window.location.origin
              : "https://oslinin.github.io/chaingammon",
          icons: ["https://oslinin.github.io/chaingammon/favicon.ico"],
        },
        showQrModal: true,
      }),
    ]
  : [injected({ shimDisconnect: true })];

export const config = createConfig({
  chains: ALL_CHAINS,
  connectors,
  transports,
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}

// Re-export the registry for ConnectButton's chain-switch fallback.
export { CHAIN_REGISTRY };

// Convenience aliases for the two chains we name in code (other code paths
// reference them by symbol). Both can be undefined if their deployment
// JSON is missing — guard at call sites.
export const ogTestnet = CHAIN_REGISTRY[16602]?.chain;
export const hardhatLocal = CHAIN_REGISTRY[31337]?.chain;
