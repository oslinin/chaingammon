// Phase 31: unified discovery list — humans and agents from
// PlayerSubnameRegistrar in a single view.
//
// The contract delegates all subname state to ENS NameWrapper + PublicResolver
// and exposes no enumeration functions (no subnameCount, subnameAt, or text).
// Enumeration is driven entirely by SubnameMinted event logs, scanned in
// 49k-block chunks to stay within publicnode Sepolia's 50k block range cap.
// kind + inftId come directly from the event; elo + endpoint are read from
// the ENS PublicResolver via a batched useReadContracts call.
//
// Human ELO fallback: ENS PublicResolver only stores elo when KeeperHub
// settlement writes it. For human entries, MatchRegistry.humanElo(owner)
// is read as a fallback (mirrors ProfileBadge behaviour).
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { parseAbiItem } from "viem";
import { usePublicClient, useReadContracts } from "wagmi";

import { useActiveChain, useActiveChainId, useEnsInfra } from "./chains";
import { MatchRegistryABI, useChainContracts } from "./contracts";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

interface DiscoveryEntry {
  node: `0x${string}`;
  label: string;
  kind: string;
  elo: string;
  endpoint: string;
  inftId: string; // agent iNFT ID written by AgentRegistry.mintAgent; "" for humans
  owner?: `0x${string}`;
}

interface ScanEntry {
  node: `0x${string}`;
  label: string;
  kind: string;
  inftId: string;
  owner: `0x${string}`;
}

// -------------------------------------------------------------------------
// Discovery entry card
// -------------------------------------------------------------------------

function EntryCard({ entry }: { entry: DiscoveryEntry }) {
  const hasEndpoint = !!entry.endpoint;
  const hasInfoLink = entry.kind === "agent" && !!entry.inftId;
  return (
    <div
      data-testid="discovery-entry"
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-50 break-all">
          {entry.label}.chaingammon.eth
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          {hasInfoLink && (
            <a
              href={`/agent/${entry.inftId}`}
              target="_blank"
              rel="noreferrer"
              data-testid="discovery-agent-info-link"
              title="Open agent info in a new tab"
              className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
            >
              Info ↗
            </a>
          )}
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {entry.kind || "unknown"}
          </span>
        </div>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          ELO
        </span>
        <span className="font-mono text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          {entry.elo || "—"}
        </span>
      </div>

      {hasEndpoint && (
        <Link
          href={`/match?endpoint=${encodeURIComponent(entry.endpoint)}`}
          data-testid="discovery-play-button"
          className="mt-1 rounded-md bg-indigo-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        >
          Play
        </Link>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Prop types for static fixture use
// -------------------------------------------------------------------------

export interface DiscoveryListProps {
  /** Pre-populated entries for test fixture pages (no blockchain read). */
  staticEntries?: DiscoveryEntry[];
  /** When true, only the Players section is rendered. Use on pages where
   *  AgentsList already shows agent cards so they aren't duplicated. */
  playersOnly?: boolean;
}

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const SUBNAME_MINTED_EVENT = parseAbiItem(
  "event SubnameMinted(string label, bytes32 indexed node, address indexed subnameOwner, uint256 inftId)",
);

// Minimal ABI for ENS PublicResolver.text(bytes32, string) → string.
const RESOLVER_ABI = [
  {
    name: "text",
    type: "function" as const,
    inputs: [
      { name: "node", type: "bytes32" as const },
      { name: "key", type: "string" as const },
    ],
    outputs: [{ name: "", type: "string" as const }],
    stateMutability: "view" as const,
  },
] as const;

// publicnode Sepolia caps eth_getLogs at 50k blocks; stay safely under.
const MAX_BLOCK_RANGE = BigInt(49_000);

// -------------------------------------------------------------------------
// Main component
// -------------------------------------------------------------------------

export function DiscoveryList({ staticEntries, playersOnly }: DiscoveryListProps = {}) {
  const active = useActiveChain();
  const chainId = useActiveChainId();
  const { playerSubnameRegistrar, matchRegistry } = useChainContracts();
  const publicClient = usePublicClient({ chainId });
  const ensInfra = useEnsInfra();

  // Partial entries from event scan (elo + endpoint added below via resolver reads).
  const [scanEntries, setScanEntries] = useState<ScanEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanError, setScanError] = useState(false);

  useEffect(() => {
    if (!publicClient || !playerSubnameRegistrar || !active || staticEntries) return;
    let cancelled = false;
    setLoading(true);
    setScanError(false);

    // Scan from deployedBlock when known; BigInt(0) fallback is safe because
    // the chunked scanner handles any range size.
    const fromBlock: bigint | "earliest" =
      chainId === 31337
        ? "earliest"
        : typeof active.deployedBlock === "number"
        ? BigInt(active.deployedBlock)
        : BigInt(0);

    const scan = async () => {
      if (fromBlock === "earliest") {
        return publicClient.getLogs({
          address: playerSubnameRegistrar,
          event: SUBNAME_MINTED_EVENT,
          fromBlock,
        });
      }
      const tip = await publicClient.getBlockNumber();
      const chunks: { fromBlock: bigint; toBlock: bigint }[] = [];
      let from = fromBlock;
      while (from <= tip) {
        const to = from + MAX_BLOCK_RANGE <= tip ? from + MAX_BLOCK_RANGE : tip;
        chunks.push({ fromBlock: from, toBlock: to });
        from = to + 1n;
      }
      const results = await Promise.all(
        chunks.map((c) =>
          publicClient.getLogs({
            address: playerSubnameRegistrar,
            event: SUBNAME_MINTED_EVENT,
            ...c,
          }),
        ),
      );
      return results.flat();
    };

    scan()
      .then((logs) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const result: ScanEntry[] = [];
        for (const log of logs) {
          const { label, node, subnameOwner, inftId } = log.args as {
            label?: string;
            node?: `0x${string}`;
            subnameOwner?: `0x${string}`;
            inftId?: bigint;
          };
          if (!node || !label || seen.has(node)) continue;
          seen.add(node);
          result.push({
            node,
            label,
            kind: (inftId ?? 0n) > 0n ? "agent" : "human",
            inftId: inftId && inftId > 0n ? inftId.toString() : "",
            owner: subnameOwner ?? "0x0000000000000000000000000000000000000000",
          });
        }
        setScanEntries(result);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setScanError(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [publicClient, playerSubnameRegistrar, active, chainId, staticEntries]);

  // Batch-read elo + endpoint from ENS PublicResolver for each discovered node.
  // When ensInfra is absent (e.g. localhost), resolver is undefined and calls
  // are skipped — elo/endpoint show as empty strings.
  const resolver = ensInfra?.publicResolver as `0x${string}` | undefined;
  const nodes = scanEntries.map((e) => e.node);
  const textCalls = resolver
    ? nodes.flatMap((node) => [
        {
          address: resolver,
          abi: RESOLVER_ABI,
          functionName: "text" as const,
          args: [node, "elo"] as [`0x${string}`, string],
          chainId,
        },
        {
          address: resolver,
          abi: RESOLVER_ABI,
          functionName: "text" as const,
          args: [node, "endpoint"] as [`0x${string}`, string],
          chainId,
        },
      ])
    : [];

  const { data: textResults } = useReadContracts({
    contracts: textCalls,
    query: { enabled: nodes.length > 0 && !!resolver },
  });

  // Fallback ELO for humans: ENS resolver only stores elo after KeeperHub
  // settlement. Read MatchRegistry.humanElo(owner) for every human entry so
  // freshly-minted subnames still show a rating (mirrors ProfileBadge).
  const humanEntries = scanEntries.filter((e) => e.kind !== "agent");
  const humanEloCalls = matchRegistry
    ? humanEntries.map((e) => ({
        address: matchRegistry,
        abi: MatchRegistryABI,
        functionName: "humanElo" as const,
        args: [e.owner] as [`0x${string}`],
        chainId,
      }))
    : [];

  const { data: humanEloResults } = useReadContracts({
    contracts: humanEloCalls,
    query: { enabled: humanEntries.length > 0 && !!matchRegistry },
  });

  // Map owner address → chain ELO for O(1) lookup in liveEntries.
  const humanEloByOwner = new Map<string, string>();
  humanEntries.forEach((e, i) => {
    const raw = humanEloResults?.[i]?.result;
    if (raw != null && e.owner) humanEloByOwner.set(e.owner, String(raw));
  });

  const liveEntries: DiscoveryEntry[] = scanEntries.map((e, i) => {
    const ensElo = resolver ? ((textResults?.[i * 2]?.result as string) ?? "") : "";
    const chainElo = e.kind !== "agent" && e.owner ? (humanEloByOwner.get(e.owner) ?? "") : "";
    const elo = ensElo || chainElo;
    return {
      ...e,
      elo,
      endpoint: resolver ? ((textResults?.[i * 2 + 1]?.result as string) ?? "") : "",
    };
  });

  const entries: DiscoveryEntry[] = staticEntries ?? liveEntries;
  const humans = entries.filter((e) => e.kind !== "agent");
  const agents = entries.filter((e) => e.kind === "agent");

  // --- Loading / error states (only relevant for live on-chain path) ---
  if (!staticEntries) {
    if (!active) {
      return (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No Chaingammon deployment on this chain. Switch your wallet to see identities.
        </p>
      );
    }
    if (loading) {
      return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
    }
    if (scanError) {
      return (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Could not reach PlayerSubnameRegistrar at{" "}
          <code className="font-mono">{playerSubnameRegistrar}</code>.
        </p>
      );
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section data-testid="discovery-humans-section">
        <h2
          data-testid="discovery-humans-header"
          className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Players
        </h2>
        {humans.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No players registered yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {humans.map((e) => (
              <EntryCard key={e.node} entry={e} />
            ))}
          </div>
        )}
      </section>

      {!playersOnly && (
        <section data-testid="discovery-agents-section">
          <h2
            data-testid="discovery-agents-header"
            className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50"
          >
            Agents
          </h2>
          {agents.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No agents registered yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((e) => (
                <EntryCard key={e.node} entry={e} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
