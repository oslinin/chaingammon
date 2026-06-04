// wagmi config built from `chains.ts` — the registry that pairs
// chainId → {viem Chain, deployed contract addresses}.
//
// To add a chain: edit `chains.ts`, not this file.
//
// Uses wagmi's standard `createConfig` with the `injected()` connector so
// MetaMask (and any other browser-injected wallet) works directly. Privy
// was removed in favour of this lighter approach — the injected connector
// handles MetaMask in Chrome/Firefox/Brave; mobile browsers without an
// extension see the "Open in MetaMask" deep link in ConnectButton.
//
// IMPORTANT: import `injected` from `@wagmi/core`, NOT from
// `wagmi/connectors` — Webpack chokes on the wagmi/connectors umbrella
// export (pulls in @wagmi/core/tempo which is missing an `accounts`
// sub-package). Turbopack tree-shakes that path away; Webpack does not.

import { http } from "viem";
import { createStorage, noopStorage, createConfig } from "wagmi";
import { injected } from "@wagmi/core";

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

export const config = createConfig({
  chains: ALL_CHAINS,
  transports,
  connectors: [injected()],
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
