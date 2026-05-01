// Phase 15 + Commit 0 typed-ELO: read a backgammon subname's profile.
//
// ELO comes from the typed `eloOf(node)` view (uint256 → bigint via viem),
// not from a `text(node, "elo")` string round-trip. The ENS namehash is
// computed locally as `keccak256(parentNode || keccak256(label))`;
// parentNode is read once from the contract (immutable) and cached
// forever via react-query's staleTime: Infinity.
//
// `agent_id` is still a text record on the subname (see
// `useAllChaingammonSubnames` for the picker discriminator).
//
// Reads pin to the wallet's current chain (Phase 24); the registrar
// address comes from `chains.ts`.
"use client";

import { encodePacked, keccak256, toBytes } from "viem";
import { useReadContract } from "wagmi";

import { useActiveChainId } from "./chains";
import { PlayerSubnameRegistrarABI, useChainContracts } from "./contracts";

function subnameNode(parentNode: `0x${string}`, label: string): `0x${string}` {
  const labelHash = keccak256(toBytes(label));
  return keccak256(encodePacked(["bytes32", "bytes32"], [parentNode, labelHash]));
}

export function useChaingammonProfile(label: string | null) {
  const chainId = useActiveChainId();
  const { playerSubnameRegistrar } = useChainContracts();

  const { data: parentNode } = useReadContract({
    address: playerSubnameRegistrar,
    abi: PlayerSubnameRegistrarABI,
    functionName: "parentNode",
    chainId,
    query: {
      staleTime: Number.POSITIVE_INFINITY,
      enabled: !!playerSubnameRegistrar,
    },
  });

  const node =
    label && parentNode
      ? subnameNode(parentNode as `0x${string}`, label)
      : undefined;

  const { data: eloRaw, isLoading: eloLoading } = useReadContract({
    address: playerSubnameRegistrar,
    abi: PlayerSubnameRegistrarABI,
    functionName: "eloOf",
    args: node ? [node] : undefined,
    chainId,
    query: { enabled: !!node },
  });

  const { data: agentIdRaw, isLoading: agentLoading } = useReadContract({
    address: playerSubnameRegistrar,
    abi: PlayerSubnameRegistrarABI,
    functionName: "text",
    args: node ? [node, "agent_id"] : undefined,
    chainId,
    query: { enabled: !!node },
  });

  const elo = typeof eloRaw === "bigint" ? Number(eloRaw) : undefined;
  const agentId =
    typeof agentIdRaw === "string" && agentIdRaw !== "" ? agentIdRaw : undefined;

  return { elo, agentId, node, isLoading: eloLoading || agentLoading };
}
