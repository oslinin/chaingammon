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

import sepoliaDeployment from "../../contracts/deployments/sepolia.json";

interface ChainDef {
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl: string;
  explorerUrl?: string;
  testnet?: boolean;
}

const CHAIN_DEFS: Record<number, ChainDef> = {
  11155111: {
    name: "Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrl:
      process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ??
      "https://ethereum-sepolia.publicnode.com",
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
    PlayerSubnameRegistrar?: string | null;
    MatchEscrow?: string;
    AgentVault?: string;
    NameWrapper?: string;
    PublicResolver?: string;
  };
  // Captured by deploy.js as the chain head right before the first
  // deploy tx. Used by log-scan hooks (e.g. useChaingammonName) to
  // stay inside public-RPC `eth_getLogs` block-range caps. Older
  // deployment records may be missing this field — callers should
  // treat it as optional and fall back to a sliding window.
  deployedBlock?: number;
}

/// ENS infrastructure for chains where chaingammon delegates subname
/// state to real ENS (NameWrapper-backed PlayerSubnameRegistrar). The
/// subgraph URL is used by DiscoveryList to enumerate subnames under
/// chaingammon.eth without scanning event logs.
export interface EnsInfra {
  nameWrapper: `0x${string}`;
  publicResolver: `0x${string}`;
  subgraphUrl: string;
}

const ENS_INFRA_BY_CHAIN: Record<number, EnsInfra> = {
  // Sepolia ENS deployment + hosted subgraph.
  11155111: {
    nameWrapper: "0x0635513f179D50A207757E05759CbD106d7dFcE8",
    publicResolver: "0x8FADE66B79cC9f707aB26799354482EB93a5B7dD",
    subgraphUrl: "https://api.studio.thegraph.com/query/49574/enssepolia/version/latest",
  },
};

export function useEnsInfra(): EnsInfra | undefined {
  const chainId = useChainId();
  return ENS_INFRA_BY_CHAIN[chainId];
}

const ALL_DEPLOYMENTS: DeploymentRecord[] = [
  sepoliaDeployment as DeploymentRecord,
];

export interface ChainEntry {
  chain: Chain;
  contracts: {
    matchRegistry: `0x${string}`;
    agentRegistry: `0x${string}`;
    playerSubnameRegistrar?: `0x${string}`;
    matchEscrow?: `0x${string}`;
    agentVault?: `0x${string}`;
  };
  /** Block at which the contracts were deployed. Optional for older records. */
  deployedBlock?: number;
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
      matchEscrow: dep.contracts.MatchEscrow as `0x${string}` | undefined,
      agentVault: dep.contracts.AgentVault as `0x${string}` | undefined,
    },
    deployedBlock: dep.deployedBlock,
  };
}

export const CHAIN_REGISTRY: Record<number, ChainEntry> = Object.fromEntries(
  ALL_DEPLOYMENTS.filter((d) => CHAIN_DEFS[d.chainId]).map((d) => [
    d.chainId,
    buildEntry(d, CHAIN_DEFS[d.chainId]),
  ]),
);

// Tuple form for wagmi's `chains:` (it requires `[Chain, ...Chain[]]`).
// Built from ALL_DEPLOYMENTS order rather than Object.values so the first
// entry controls wagmi's default chain.
const allChains = ALL_DEPLOYMENTS
  .map((d) => CHAIN_REGISTRY[d.chainId])
  .filter((entry): entry is ChainEntry => entry !== undefined)
  .map((entry) => entry.chain);
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

// Sepolia is the only chain exposed in the network dropdown.
export function useSelectableChains(): ChainEntry[] {
  const entry = CHAIN_REGISTRY[11155111];
  return entry ? [entry] : [];
}
