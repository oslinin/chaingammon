// Single source of truth for which chains the frontend speaks to and
// which contract addresses live where.
//
// Adding a new chain is two steps:
//   1. Deploy contracts to it: `pnpm exec hardhat run script/deploy.js
//      --network <name>` writes `contracts/deployments/<name>.json` with
//      addresses + chainId.
//   2. Drop the new deployment record into `ALL_DEPLOYMENTS` below and
//      a matching display entry into `CHAIN_DEFS` (chainId → name, RPC,
//      explorer). Done.
//
// The active chain follows the wallet at runtime via `useActiveChain()`
// (a wagmi `useChainId()` lookup). For SSR / not-connected, the
// fallback is the first chain in `ALL_CHAINS` (which is wagmi's own
// default chain too). There is no `NEXT_PUBLIC_CHAIN_ID` env var —
// chainIds live in the deployment JSON, the active selector lives in
// the wallet.

import type { Chain } from "viem";
import { defineChain } from "viem";
import { useChainId } from "wagmi";

import localhostDeployment from "../../contracts/deployments/localhost.json";
import ogTestnetDeployment from "../../contracts/deployments/0g-testnet.json";
import sepoliaDeployment from "../../contracts/deployments/sepolia.json";

interface ChainDef {
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl: string;
  explorerUrl?: string;
  testnet?: boolean;
}

// Display + network metadata, keyed by chainId. Hardhat localhost RPC
// stays http://127.0.0.1:8545 by convention; testnet RPC is overridable
// via NEXT_PUBLIC_OG_RPC_URL for self-hosted RPC providers.
const CHAIN_DEFS: Record<number, ChainDef> = {
  16602: {
    name: "0G Galileo Testnet",
    nativeCurrency: { name: "0G", symbol: "OG", decimals: 18 },
    rpcUrl:
      process.env.NEXT_PUBLIC_OG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
    explorerUrl: "https://chainscan-galileo.0g.ai",
    testnet: true,
  },
  31337: {
    name: "Hardhat Localhost",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrl: "http://127.0.0.1:8545",
    testnet: true,
  },
  11155111: {
    name: "Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    // Public RPC; replace via NEXT_PUBLIC_SEPOLIA_RPC_URL for an Alchemy
    // / Infura key if the public endpoint is rate-limiting the demo.
    rpcUrl:
      process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org",
    explorerUrl: "https://sepolia.etherscan.io",
    testnet: true,
  },
};

interface DeploymentRecord {
  network: string;
  chainId: number;
  contracts: {
    MatchRegistry: string;
    AgentRegistry: string;
    PlayerSubnameRegistrar?: string;
  };
}

const ALL_DEPLOYMENTS: DeploymentRecord[] = [
  ogTestnetDeployment as DeploymentRecord,
  localhostDeployment as DeploymentRecord,
  sepoliaDeployment as DeploymentRecord,
];

export interface ChainEntry {
  chain: Chain;
  contracts: {
    matchRegistry: `0x${string}`;
    agentRegistry: `0x${string}`;
    playerSubnameRegistrar?: `0x${string}`;
  };
}

function buildEntry(dep: DeploymentRecord, def: ChainDef): ChainEntry {
  return {
    chain: defineChain({
      id: dep.chainId,
      name: def.name,
      nativeCurrency: def.nativeCurrency,
      rpcUrls: { default: { http: [def.rpcUrl] } },
      ...(def.explorerUrl
        ? {
            blockExplorers: {
              default: { name: def.name, url: def.explorerUrl },
            },
          }
        : {}),
      testnet: def.testnet,
    }),
    contracts: {
      matchRegistry: dep.contracts.MatchRegistry as `0x${string}`,
      agentRegistry: dep.contracts.AgentRegistry as `0x${string}`,
      playerSubnameRegistrar: dep.contracts.PlayerSubnameRegistrar as
        | `0x${string}`
        | undefined,
    },
  };
}

export const CHAIN_REGISTRY: Record<number, ChainEntry> = Object.fromEntries(
  ALL_DEPLOYMENTS.filter((d) => CHAIN_DEFS[d.chainId]).map((d) => [
    d.chainId,
    buildEntry(d, CHAIN_DEFS[d.chainId]),
  ]),
);

// Tuple form for wagmi's `chains:` (it requires `[Chain, ...Chain[]]`).
const allChains = Object.values(CHAIN_REGISTRY).map((e) => e.chain);
if (allChains.length === 0) {
  throw new Error(
    "chaingammon: no chains in CHAIN_REGISTRY — check contracts/deployments/*.json files",
  );
}
const [firstChain, ...restChains] = allChains;
export const ALL_CHAINS: readonly [Chain, ...Chain[]] = [firstChain, ...restChains];

// First chain in wagmi's `chains:` array doubles as the SSR / not-
// connected fallback. wagmi's `useChainId()` returns this when no
// wallet is attached, so the registry lookup stays consistent across
// SSR and post-hydration.
export const FALLBACK_CHAIN_ID = firstChain.id;

/**
 * Active chain hook — the chain the wallet is currently on, or
 * `FALLBACK_CHAIN_ID` if no wallet is connected. Reads against this
 * chain's contract addresses are guaranteed to hit a chain we have
 * deployments for.
 *
 * Returns `undefined` if the wallet is on a chain we have no entry
 * for (e.g. mainnet) — call sites should treat that as "no contracts
 * on this chain" and surface a clear empty state.
 */
export function useActiveChain(): ChainEntry | undefined {
  const chainId = useChainId();
  return CHAIN_REGISTRY[chainId];
}

export function useActiveChainId(): number {
  return useChainId();
}

// Chain IDs the user can pick from in the network dropdown.
// Order matters — this is the order they render in the menu.
//   - 0G Galileo Testnet (16602) — primary chain, listed first.
//   - Sepolia (11155111) — secondary, listed second.
//   - Hardhat Localhost (31337) — dev only, listed last.
const SELECTABLE_CHAIN_IDS_PROD = [16602, 11155111] as const;
const SELECTABLE_CHAIN_IDS_DEV = [16602, 11155111, 31337] as const;

/**
 * The chains the user can pick from in the network dropdown.
 *
 * Always includes the primary chains (0G Galileo Testnet, Sepolia).
 * Includes Hardhat Localhost only when `process.env.NODE_ENV !== "production"`,
 * so the demo build does not surface a chain that won't reach a node.
 *
 * Each entry is the same `ChainEntry` shape served from `CHAIN_REGISTRY`,
 * so a chain absent from the registry (e.g. its deployment JSON is missing)
 * is silently skipped.
 */
export function useSelectableChains(): ChainEntry[] {
  const ids =
    process.env.NODE_ENV === "production"
      ? SELECTABLE_CHAIN_IDS_PROD
      : SELECTABLE_CHAIN_IDS_DEV;
  return ids
    .map((id) => CHAIN_REGISTRY[id])
    .filter((entry): entry is ChainEntry => entry !== undefined);
}
