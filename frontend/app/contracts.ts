// Deployed contract addresses + ABIs for the frontend.
//
// Addresses are sourced from NEXT_PUBLIC_* env vars (set in .env.local
// after `pnpm exec hardhat run script/deploy.js --network 0g-testnet`).
// ABIs ship as artifacts from the Hardhat compile and are imported here.

import AgentRegistryArtifact from "../../contracts/artifacts/src/AgentRegistry.sol/AgentRegistry.json";
import MatchRegistryArtifact from "../../contracts/artifacts/src/MatchRegistry.sol/MatchRegistry.json";

export const AGENT_REGISTRY_ADDRESS = (process.env.NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS ?? "") as `0x${string}`;
export const MATCH_REGISTRY_ADDRESS = (process.env.NEXT_PUBLIC_MATCH_REGISTRY_ADDRESS ?? "") as `0x${string}`;

export const AgentRegistryABI = AgentRegistryArtifact.abi;
export const MatchRegistryABI = MatchRegistryArtifact.abi;
