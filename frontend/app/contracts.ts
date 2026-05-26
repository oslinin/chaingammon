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
    usdcToken: (active?.contracts.usdcToken ?? ZERO) as `0x${string}`,
    matchEscrowUsdc: (active?.contracts.matchEscrowUsdc ?? ZERO) as `0x${string}`,
    agentVaultToken: (active?.contracts.agentVaultToken ?? ZERO) as `0x${string}`,
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

// MatchEscrowUsdc ABI — ERC-20 escrow; deposit is non-payable (pulls via transferFrom).
export const MatchEscrowUsdcABI = [
  { name: "deposit", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "bytes32" }, { name: "amount", type: "uint256" }],
    outputs: [] },
  { name: "refund", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "bytes32" }], outputs: [] },
  { name: "payoutWinner", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "bytes32" }, { name: "winner", type: "address" }],
    outputs: [] },
  { name: "payoutSplit", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "bytes32" }, { name: "winners", type: "address[]" }, { name: "shares", type: "uint256[]" }],
    outputs: [] },
  { name: "pot", type: "function", stateMutability: "view",
    inputs: [{ name: "matchId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }] },
  { name: "token", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "settler", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "address" }] },
] as const satisfies Abi;

// AgentVaultToken ABI — ERC-20 vault; deposit(agentId, amount) pulls tokens.
export const AgentVaultTokenABI = [
  { name: "balances", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }] },
  { name: "deposit", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "amount", type: "uint256" }],
    outputs: [] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [] },
  { name: "withdrawAll", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "to", type: "address" }],
    outputs: [] },
  { name: "depositToEscrow", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "matchId", type: "bytes32" }, { name: "stake", type: "uint256" }, { name: "escrow", type: "address" }],
    outputs: [] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "operator", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [] },
] as const satisfies Abi;

// Minimal ERC-20 ABI — the subset the frontend actually calls.
export const ERC20ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const satisfies Abi;

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
