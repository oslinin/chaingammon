// Phase 15: read text records from a chaingammon subname's profile.
//
// The ENS namehash for `<label>.<parent>` is computed locally as
// `keccak256(parentNode || keccak256(label))`. parentNode is read once
// from the contract (immutable) and cached forever via react-query's
// staleTime: Infinity.
"use client";

import { encodePacked, keccak256, toBytes } from "viem";
import { useReadContract } from "wagmi";

import { PLAYER_SUBNAME_REGISTRAR_ADDRESS, PlayerSubnameRegistrarABI } from "./contracts";

function subnameNode(parentNode: `0x${string}`, label: string): `0x${string}` {
  const labelHash = keccak256(toBytes(label));
  return keccak256(encodePacked(["bytes32", "bytes32"], [parentNode, labelHash]));
}

export function useChaingammonProfile(label: string | null) {
  const { data: parentNode } = useReadContract({
    address: PLAYER_SUBNAME_REGISTRAR_ADDRESS,
    abi: PlayerSubnameRegistrarABI,
    functionName: "parentNode",
    query: {
      // Immutable on-chain, set at registrar deploy time.
      staleTime: Number.POSITIVE_INFINITY,
      enabled: !!PLAYER_SUBNAME_REGISTRAR_ADDRESS,
    },
  });

  const node =
    label && parentNode
      ? subnameNode(parentNode as `0x${string}`, label)
      : undefined;

  const { data: elo, isLoading } = useReadContract({
    address: PLAYER_SUBNAME_REGISTRAR_ADDRESS,
    abi: PlayerSubnameRegistrarABI,
    functionName: "text",
    args: node ? [node, "elo"] : undefined,
    query: { enabled: !!node },
  });

  const eloValue = typeof elo === "string" && elo !== "" ? elo : undefined;
  return { elo: eloValue, node, isLoading };
}
