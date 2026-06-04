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
import { PlayerSubnameRegistrarABI, useChainContracts } from "./contracts";

const SUBNAME_MINTED_EVENT = parseAbiItem(
  "event SubnameMinted(string label, bytes32 indexed node, address indexed subnameOwner, uint256 inftId)",
);

export interface NameEntry { label: string; blockNumber: bigint; }

function preferredKey(address: string) {
  return `cg:preferred-idx:${address.toLowerCase()}`;
}

export function useChaingammonName(address: `0x${string}` | undefined) {
  const chainId = useActiveChainId();
  // Pin the public client to the active chain so log scans hit the
  // registrar where it actually lives, not whichever chain the wallet
  // is currently on at the wagmi level (in case those drift).
  const client = usePublicClient({ chainId });
  const { playerSubnameRegistrar } = useChainContracts();
  const deployedBlock = useActiveChain()?.deployedBlock;

  const [entries, setEntries] = useState<NameEntry[]>([]);
  const [preferredIdx, setPreferredIdxState] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!address) { setPreferredIdxState(0); return; }
    const stored = typeof window !== "undefined"
      ? window.localStorage.getItem(preferredKey(address))
      : null;
    setPreferredIdxState(stored !== null ? Number(stored) : 0);
  }, [address]);

  useEffect(() => {
    if (
      !address ||
      !client ||
      !playerSubnameRegistrar ||
      playerSubnameRegistrar.length < 4
    ) {
      setEntries([]);
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

    // publicnode Sepolia caps eth_getLogs at 50k blocks. Scan in 49k-block
    // chunks so a deployedBlock range of any size succeeds.
    const MAX_BLOCK_RANGE = BigInt(49_000);

    // Scan all SubnameMinted events without an RPC-side address filter.
    // Filtering by args.subnameOwner in getLogs (topics filter) silently
    // fails on some RPC providers (publicnode), while DiscoveryList's
    // unfiltered scan succeeds. We match logs client-side instead.
    const scanChunked = async (fromBlock: bigint | "earliest") => {
      if (fromBlock === "earliest") {
        return client.getLogs({
          address: playerSubnameRegistrar,
          event: SUBNAME_MINTED_EVENT,
          fromBlock,
        });
      }
      const tip = await client.getBlockNumber();
      const chunks: { fromBlock: bigint; toBlock: bigint }[] = [];
      let from = fromBlock;
      while (from <= tip) {
        const to = from + MAX_BLOCK_RANGE <= tip ? from + MAX_BLOCK_RANGE : tip;
        chunks.push({ fromBlock: from, toBlock: to });
        from = to + 1n;
      }
      const results = await Promise.all(
        chunks.map((c) =>
          client.getLogs({
            address: playerSubnameRegistrar,
            event: SUBNAME_MINTED_EVENT,
            ...c,
          }),
        ),
      );
      return results.flat();
    };

    const addrLower = address.toLowerCase();
    computeFromBlock()
      .then((fromBlock) => scanChunked(fromBlock))
      .then(async (logs) => {
        if (cancelled) return;
        // Filter client-side: human names (inftId == 0) owned by this address.
        const humanLogs = logs.filter(
          (log) =>
            log.args?.inftId === 0n &&
            (log.args?.subnameOwner as string | undefined)?.toLowerCase() === addrLower,
        );
        const allFound: NameEntry[] = humanLogs
          .map((log) => ({
            label: log.args?.label as string | undefined,
            blockNumber: log.blockNumber ?? 0n,
          }))
          .filter((e): e is NameEntry => !!e.label);

        // Deduplicate by label — multiple SubnameMinted events can share the
        // same label (ENS allows overwrites); keep only the latest per label.
        const deduped = new Map<string, NameEntry>();
        for (const e of allFound) {
          const prev = deduped.get(e.label);
          if (!prev || e.blockNumber > prev.blockNumber) deduped.set(e.label, e);
        }

        // Verify current ENS ownership to filter out revoked names.
        // On RPC/network error, keep the entry so a transient outage doesn't
        // hide a valid name and incorrectly show the ClaimForm.
        const verified = await Promise.all(
          [...deduped.values()].map(async (e) => {
            try {
              const owner = await client!.readContract({
                address: playerSubnameRegistrar as `0x${string}`,
                abi: PlayerSubnameRegistrarABI,
                functionName: "ownerOf",
                args: [e.label],
              });
              // Only filter out when ENS explicitly returns a different address
              // (revoked → address(0), or overwritten by another wallet).
              return (owner as string).toLowerCase() === addrLower ? e : null;
            } catch {
              // Network / RPC error — keep the entry rather than hiding a name.
              return e;
            }
          }),
        );
        if (!cancelled) setEntries(verified.filter((e): e is NameEntry => e !== null));
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
  }, [address, client, playerSubnameRegistrar, chainId, deployedBlock]);

  const setPreferred = (idx: number) => {
    if (!address) return;
    window.localStorage.setItem(preferredKey(address), String(idx));
    setPreferredIdxState(idx);
  };

  const selectedIdx = preferredIdx < entries.length ? preferredIdx : 0;
  const label = entries[selectedIdx]?.label ?? null;
  const name = label ? `${label}.chaingammon.eth` : null;
  return { label, entries, selectedIdx, name, isLoading, setPreferred };
}
