// wagmi config for the 0G testnet.
//
// Phase 12: define the 0G "Galileo" testnet as a custom viem Chain (no
// public preset for chainId 16602) and wire it into wagmi's config with
// an injected (browser-extension) connector. Phase 13+ adds wallet
// connect / coinbase wallet if needed; for v1 MetaMask / Brave / any
// EIP-1193 injected provider is sufficient.

import { defineChain, http } from "viem";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";

const RPC_URL =
  process.env.NEXT_PUBLIC_OG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const EXPLORER_URL = "https://chainscan-galileo.0g.ai";

export const ogTestnet = defineChain({
  id: 16602,
  name: "0G Galileo Testnet",
  nativeCurrency: { name: "0G", symbol: "OG", decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Chainscan Galileo", url: EXPLORER_URL },
  },
  testnet: true,
});

export const config = createConfig({
  chains: [ogTestnet],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [ogTestnet.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
