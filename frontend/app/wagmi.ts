// wagmi config built from `chains.ts` — the registry that pairs
// chainId → {viem Chain, deployed contract addresses}.
//
// To add a chain: edit `chains.ts`, not this file.

import { http } from "viem";
import { createConfig, createStorage, noopStorage } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

import { ALL_CHAINS, CHAIN_REGISTRY } from "./chains";

const transports = Object.fromEntries(ALL_CHAINS.map((c) => [c.id, http()]));

// Explicit localStorage so the MetaMask connection survives a page reload.
const storage = createStorage({
  storage: typeof window !== "undefined" ? window.localStorage : noopStorage,
});

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

export const config = createConfig({
  chains: ALL_CHAINS,
  transports,
  connectors: [injected(), walletConnect({ projectId, showQrModal: false })],
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
