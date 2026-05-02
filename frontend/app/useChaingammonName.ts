// Phase 15: address → chaingammon-subname lookup.
//
// The PlayerSubnameRegistrar (Phase 10) doesn't have an on-chain reverse
// mapping (address → label) because that would double the storage cost
// per mint. Instead we walk the `SubnameMinted(string indexed
// labelHashed, string label, bytes32 indexed node, address indexed
// subnameOwner)` event log filtered by `subnameOwner = address`. The
// label sits in the unindexed event data so we get it back from the
// log directly.
//
// The lookup happens against whichever chain the wallet is currently
// on (Phase 24); the registrar address comes from `chains.ts`.
"use client";

import { useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";

import { useActiveChain, useActiveChainId } from "./chains";
import { useChainContracts } from "./contracts";

const SUBNAME_MINTED_EVENT = parseAbiItem(
  "event SubnameMinted(string indexed labelHashed, string label, bytes32 indexed node, address indexed subnameOwner)",
);

export function useChaingammonName(address: `0x${string}` | undefined) {
  const chainId = useActiveChainId();
  // Pin the public client to the active chain so log scans hit the
  // registrar where it actually lives, not whichever chain the wallet
  // is currently on at the wagmi level (in case those drift).
  const client = usePublicClient({ chainId });
  const { playerSubnameRegistrar } = useChainContracts();
  const deployedBlock = useActiveChain()?.deployedBlock;

  const [label, setLabel] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (
      !address ||
      !client ||
      !playerSubnameRegistrar ||
      playerSubnameRegistrar.length < 4
    ) {
      setLabel(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);

    // Public testnet RPCs cap eth_getLogs to a fixed block range
    // (publicnode Sepolia: 50000 blocks; many providers: 10000). A
    // `fromBlock: "earliest"` request crosses that cap and gets
    // rejected, which the old code swallowed silently — leaving the
    // wallet looking subname-less even after a successful claim.
    // Preferred path: read `deployedBlock` from the deployment record
    // (written by deploy.js) so the scan covers exactly the contract's
    // lifetime. Fallback for older records: a sliding 49k-block window
    // (under the 50k cap; sees ~1 week of Sepolia history). Localhost
    // / hardhat keeps "earliest" since the chain is short.
    const isLocalChain = chainId === 31337;
    const computeFromBlock = async (): Promise<bigint | "earliest"> => {
      if (isLocalChain) return "earliest";
      if (typeof deployedBlock === "number") return BigInt(deployedBlock);
      const tip = await client.getBlockNumber();
      const WINDOW = BigInt(49_000);
      return tip > WINDOW ? tip - WINDOW : BigInt(0);
    };

    computeFromBlock()
      .then((fromBlock) =>
        client.getLogs({
          address: playerSubnameRegistrar,
          event: SUBNAME_MINTED_EVENT,
          args: { subnameOwner: address },
          fromBlock,
        }),
      )
      .then((logs) => {
        if (cancelled) return;
        if (logs.length > 0) {
          // A wallet could in theory own multiple subnames; take the most
          // recently-minted one as the canonical display name.
          const latest = logs[logs.length - 1];
          setLabel(latest.args?.label ?? null);
        } else {
          setLabel(null);
        }
      })
      .catch(() => {
        if (!cancelled) setLabel(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, client, playerSubnameRegistrar, chainId, deployedBlock]);

  const name = label ? `${label}.chaingammon.eth` : null;
  return { label, name, isLoading };
}
