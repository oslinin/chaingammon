// wagmi config built from `chains.ts` — the registry that pairs
// chainId → {viem Chain, deployed contract addresses}.
//
// To add a chain: edit `chains.ts`, not this file.
//
// The config is created via `@privy-io/wagmi`'s `createConfig` so that the
// PrivyProvider can register its own connector at runtime. Privy supplies
// the EIP-1193 provider for whatever wallet the user logs in with — email,
// Google (embedded wallet), MetaMask, or WalletConnect — and surfaces it
// to wagmi through that connector. We do NOT pre-register `injected()` /
// `walletConnect()` here; Privy owns the wallet list.

import { http } from "viem";
import { createStorage, noopStorage } from "wagmi";
import { createConfig } from "@privy-io/wagmi";
import { injected } from "wagmi/connectors";

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
