// Phase 15: read text records from a chaingammon subname's profile.
//
// The ENS namehash for `<label>.<parent>` is computed locally as
// `keccak256(parentNode || keccak256(label))`. parentNode is read once
// from the contract (immutable) and cached forever via react-query's
// staleTime: Infinity.
//
// Reads pin to the wallet's current chain (Phase 24); the registrar
// address comes from `chains.ts`.
"use client";

import { encodePacked, keccak256, toBytes } from "viem";
import { usePublicClient, useReadContract } from "wagmi";

import { useActiveChainId, useEnsInfra } from "./chains";
import { PlayerSubnameRegistrarABI, PublicResolverABI, useChainContracts } from "./contracts";
import { useSponsoredWrite } from "./useSponsoredWrite";

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
      // Immutable on-chain, set at registrar deploy time.
      staleTime: Number.POSITIVE_INFINITY,
      enabled: !!playerSubnameRegistrar,
    },
  });

  const node =
    label && parentNode
      ? subnameNode(parentNode as `0x${string}`, label)
      : undefined;

  const { data: elo, isLoading } = useReadContract({
    address: playerSubnameRegistrar,
    abi: PlayerSubnameRegistrarABI,
    functionName: "text",
    args: node ? [node, "elo"] : undefined,
    chainId,
    query: { enabled: !!node },
  });

  const { data: matchCount } = useReadContract({
    address: playerSubnameRegistrar,
    abi: PlayerSubnameRegistrarABI,
    functionName: "text",
    args: node ? [node, "match_count"] : undefined,
    chainId,
    query: { enabled: !!node },
  });

  const eloValue = typeof elo === "string" && elo !== "" ? elo : undefined;
  const matchCountValue =
    typeof matchCount === "string" && matchCount !== "" ? matchCount : undefined;
  return { elo: eloValue, matchCount: matchCountValue, node, isLoading };
}

/**
 * Write ELO + last_match_id to the player's ENS text records.
 *
 * Calls ENS PublicResolver.setText directly from the player's wallet.
 * The player must own the subname (set via selfMintSubname or mintSubname)
 * for the resolver to accept the write — no server key needed.
 *
 * Returns a `sync(label, elo, matchId?)` function and a `syncing` boolean.
 */
export function useSyncEnsProfile() {
  const ensInfra = useEnsInfra();
  const { playerSubnameRegistrar } = useChainContracts();
  const chainId = useActiveChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useSponsoredWrite();

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

  const sync = async (label: string, elo: string, matchId?: string) => {
    if (!ensInfra?.publicResolver) throw new Error("ENS not available on this chain");
    if (!parentNode) throw new Error("parentNode not loaded yet");

    const node = subnameNode(parentNode as `0x${string}`, label);
    const resolver = ensInfra.publicResolver;

    const eloHash = await writeContractAsync({
      address: resolver,
      abi: PublicResolverABI,
      functionName: "setText",
      args: [node, "elo", elo],
    });
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash: eloHash });

    if (matchId) {
      const midHash = await writeContractAsync({
        address: resolver,
        abi: PublicResolverABI,
        functionName: "setText",
        args: [node, "last_match_id", matchId],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: midHash });
    }
  };

  return { sync, syncing: isPending };
}
