// ABIs ship as artifacts from the Hardhat compile (`contracts/artifacts/**`).
// Addresses are chain-dependent and come from `chains.ts` via the
// `useChainContracts()` hook below — they track the wallet's current
// chain so reads always go to a deployment that exists on that chain.

import AgentRegistryArtifact from "../../contracts/artifacts/src/AgentRegistry.sol/AgentRegistry.json";
import MatchRegistryArtifact from "../../contracts/artifacts/src/MatchRegistry.sol/MatchRegistry.json";
import PlayerSubnameRegistrarArtifact from "../../contracts/artifacts/src/PlayerSubnameRegistrar.sol/PlayerSubnameRegistrar.json";

import { useActiveChain } from "./chains";

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Address triple for the wallet's current chain. Returns zero-address
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
  };
}

export const AgentRegistryABI = AgentRegistryArtifact.abi;
export const MatchRegistryABI = MatchRegistryArtifact.abi;
export const PlayerSubnameRegistrarABI = PlayerSubnameRegistrarArtifact.abi;
