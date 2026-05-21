// ABIs ship as artifacts from the Hardhat compile (`contracts/artifacts/**`).
// Addresses are chain-dependent and come from `chains.ts` via the
// `useChainContracts()` hook below — they track the wallet's current
// chain so reads always go to a deployment that exists on that chain.

import type { Abi } from "viem";

import AgentRegistryArtifact from "../../contracts/artifacts/src/AgentRegistry.sol/AgentRegistry.json";
import AgentVaultArtifact from "../../contracts/artifacts/src/AgentVault.sol/AgentVault.json";
import MatchEscrowArtifact from "../../contracts/artifacts/src/MatchEscrow.sol/MatchEscrow.json";
import MatchRegistryArtifact from "../../contracts/artifacts/src/MatchRegistry.sol/MatchRegistry.json";
import PlayerSubnameRegistrarArtifact from "../../contracts/artifacts/src/PlayerSubnameRegistrar.sol/PlayerSubnameRegistrar.json";

import { useActiveChain } from "./chains";

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Address bundle for the wallet's current chain. Returns zero-address
 * placeholders when the wallet is on a chain without deployments — call
 * sites should treat that as "no contracts on this chain" (the read
 * will revert / surface as an error in the UI).
 */
export function useChainContracts() {
  const active = useActiveChain();
  return {
    matchRegistry: (active?.contracts.matchRegistry ?? ZERO) as `0x${string}`,
    agentRegistry: (active?.contracts.agentRegistry ?? ZERO) as `0x${string}`,
    playerSubnameRegistrar: (active?.contracts.playerSubnameRegistrar ?? ZERO) as `0x${string}`,
    matchEscrow: (active?.contracts.matchEscrow ?? ZERO) as `0x${string}`,
    agentVault: (active?.contracts.agentVault ?? ZERO) as `0x${string}`,
  };
}

// Cast each artifact's `abi` to viem's `Abi` so consumers can pass them
// to wagmi / viem hooks without per-call-site casts. The JSON imports
// otherwise come back as a wide structural type whose `type: string`
// fields don't narrow to the discriminated-union viem expects.
export const AgentRegistryABI = AgentRegistryArtifact.abi as Abi;
export const AgentVaultABI = AgentVaultArtifact.abi as Abi;
export const MatchEscrowABI = MatchEscrowArtifact.abi as Abi;
export const MatchRegistryABI = MatchRegistryArtifact.abi as Abi;
export const PlayerSubnameRegistrarABI = PlayerSubnameRegistrarArtifact.abi as Abi;

// Minimal ENS PublicResolver ABI — only the functions the frontend calls directly.
// Full ABI: https://github.com/ensdomains/ens-contracts/blob/master/contracts/resolvers/PublicResolver.sol
export const PublicResolverABI = [
  {
    name: "setText",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "", type: "string" }],
  },
] as const satisfies Abi;
