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

import { useActiveChainId } from "./chains";
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
    client
      .getLogs({
        address: playerSubnameRegistrar,
        event: SUBNAME_MINTED_EVENT,
        args: { subnameOwner: address },
        fromBlock: "earliest",
      })
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
  }, [address, client, playerSubnameRegistrar]);

  const name = label ? `${label}.chaingammon.eth` : null;
  return { label, name, isLoading };
}
