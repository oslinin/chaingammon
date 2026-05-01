// Roster discovery: walk every `SubnameMinted` event from
// PlayerSubnameRegistrar to enumerate the full backgammon.eth
// player roster (humans + agents).
//
// Same primitive as `useChaingammonName.ts` (Phase 15) but without
// the `subnameOwner` filter — one `getLogs` call per page load,
// no separate indexer service needed.
"use client";

import { useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";

import { useActiveChainId } from "./chains";
import { useChainContracts } from "./contracts";

const SUBNAME_MINTED_EVENT = parseAbiItem(
  "event SubnameMinted(string indexed labelHashed, string label, bytes32 indexed node, address indexed subnameOwner)",
);

export interface SubnameEntry {
  label: string;
  node: `0x${string}`;
  owner: `0x${string}`;
}

export function useAllChaingammonSubnames() {
  const chainId = useActiveChainId();
  const client = usePublicClient({ chainId });
  const { playerSubnameRegistrar } = useChainContracts();

  const [entries, setEntries] = useState<SubnameEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (
      !client ||
      !playerSubnameRegistrar ||
      playerSubnameRegistrar.length < 4
    ) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    client
      .getLogs({
        address: playerSubnameRegistrar,
        event: SUBNAME_MINTED_EVENT,
        fromBlock: "earliest",
      })
      .then((logs) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const out: SubnameEntry[] = [];
        for (const log of logs) {
          const label = log.args?.label;
          const node = log.args?.node as `0x${string}` | undefined;
          const owner = log.args?.subnameOwner as `0x${string}` | undefined;
          if (!label || !node || !owner) continue;
          if (seen.has(node)) continue;
          seen.add(node);
          out.push({ label, node, owner });
        }
        setEntries(out);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, playerSubnameRegistrar]);

  return { entries, isLoading };
}
