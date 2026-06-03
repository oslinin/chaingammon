"use client";

import { encodePacked, keccak256, parseAbiItem, toBytes } from "viem";
import { useChainId, useReadContract } from "wagmi";

import { useEnsInfra } from "./chains";

const ENS_CHAINS = new Set([1, 11155111]);

const RESOLVER_ABI = [
  parseAbiItem("function name(bytes32 node) view returns (string)"),
] as const;

function computeNamehash(name: string): `0x${string}` {
  let node = ("0x" + "0".repeat(64)) as `0x${string}`;
  if (name === "") return node;
  const labels = name.split(".");
  for (let i = labels.length - 1; i >= 0; i--) {
    const labelHash = keccak256(toBytes(labels[i]));
    node = keccak256(encodePacked(["bytes32", "bytes32"], [node, labelHash]));
  }
  return node;
}

export function useEnsName(address: `0x${string}` | undefined) {
  const chainId = useChainId();
  const ensInfra = useEnsInfra();

  const isEnsChain = ENS_CHAINS.has(chainId);
  const reverseNode = address
    ? computeNamehash(`${address.toLowerCase().slice(2)}.addr.reverse`)
    : undefined;

  const { data: resolvedName, isLoading } = useReadContract({
    address: ensInfra?.publicResolver,
    abi: RESOLVER_ABI,
    functionName: "name",
    args: reverseNode ? [reverseNode] : undefined,
    query: {
      enabled: isEnsChain && !!ensInfra?.publicResolver && !!reverseNode,
    },
  });

  const name =
    !resolvedName || resolvedName.endsWith(".chaingammon.eth")
      ? null
      : resolvedName;

  return { name, isLoading };
}
