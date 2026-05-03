// Phase 31: unified discovery list — humans and agents from
// PlayerSubnameRegistrar in a single view.
//
// Reads kind, elo, and endpoint text records for each registered subname,
// then groups them under separate "Players" and "Agents" sections.
// "Play" button only appears for entries where endpoint is set.
// Authoritative ELO comes from MatchRegistry; the text record is only for
// cross-protocol consumers reading ENS directly.
//
// Phase 65: label resolution. The contract's subnameAt(i) returns only the
// node hash; the human-readable label lives exclusively in the SubnameMinted
// event log. We fetch all SubnameMinted events once via getLogs and build a
// node→label map so each card can display e.g. "alice.chaingammon.eth".
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { parseAbiItem } from "viem";
import { usePublicClient, useReadContract, useReadContracts } from "wagmi";

import { useActiveChain, useActiveChainId } from "./chains";
import { PlayerSubnameRegistrarABI, useChainContracts } from "./contracts";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

interface DiscoveryEntry {
  node: `0x${string}`;
  label: string;
  kind: string;
  elo: string;
  endpoint: string;
  inftId: string; // agent iNFT ID written by AgentRegistry.mintAgent; "" for human entries
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
}

// -------------------------------------------------------------------------
// Main component
// -------------------------------------------------------------------------

export function DiscoveryList({ staticEntries }: DiscoveryListProps = {}) {
  const active = useActiveChain();
  const chainId = useActiveChainId();
  const { playerSubnameRegistrar } = useChainContracts();
  const publicClient = usePublicClient({ chainId });

  // node (bytes32) → human-readable label (e.g. "alice"), populated from
  // SubnameMinted event logs. Starts empty; cards fall back to a short hex
  // prefix until the log fetch completes.
  const [labelMap, setLabelMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!publicClient || !playerSubnameRegistrar || !active || staticEntries) return;
    publicClient
      .getLogs({
        address: playerSubnameRegistrar,
        event: parseAbiItem(
          "event SubnameMinted(string indexed labelHashed, string label, bytes32 indexed node, address indexed subnameOwner)",
        ),
        fromBlock: 0n,
      })
      .then((logs) => {
        const map: Record<string, string> = {};
        for (const log of logs) {
          const { node, label } = log.args as { node?: `0x${string}`; label?: string };
          if (node && label) map[node] = label;
        }
        setLabelMap(map);
      })
      .catch(() => {
        // Non-fatal — cards will show the short node prefix fallback.
      });
  }, [publicClient, playerSubnameRegistrar, active, staticEntries]);

  // Read subnameCount so we know how many indexes to fetch
  const { data: subnameCount, isLoading: countLoading, error: countError } = useReadContract({
    address: playerSubnameRegistrar,
    abi: PlayerSubnameRegistrarABI,
    functionName: "subnameCount",
    chainId,
    query: { enabled: !staticEntries && !!active },
  });

  const count = subnameCount !== undefined ? Number(subnameCount) : 0;

  // Fetch all node IDs via subnameAt(i)
  const indexCalls = Array.from({ length: count }, (_, i) => ({
    address: playerSubnameRegistrar,
    abi: PlayerSubnameRegistrarABI,
    functionName: "subnameAt" as const,
    args: [BigInt(i)] as [bigint],
    chainId,
  }));

  const { data: nodeResults } = useReadContracts({
    contracts: indexCalls,
    query: { enabled: !staticEntries && count > 0 },
  });

  const nodes = (nodeResults ?? [])
    .map((r) => r?.result as `0x${string}` | undefined)
    .filter(Boolean) as `0x${string}`[];

  // For each node, fetch kind + elo + endpoint + inft_id text records in one batch.
  // inft_id is written by AgentRegistry.mintAgent for agent entries; "" for humans.
  const textCalls = nodes.flatMap((node) => [
    { address: playerSubnameRegistrar, abi: PlayerSubnameRegistrarABI, functionName: "text" as const, args: [node, "kind"] as [`0x${string}`, string], chainId },
    { address: playerSubnameRegistrar, abi: PlayerSubnameRegistrarABI, functionName: "text" as const, args: [node, "elo"] as [`0x${string}`, string], chainId },
    { address: playerSubnameRegistrar, abi: PlayerSubnameRegistrarABI, functionName: "text" as const, args: [node, "endpoint"] as [`0x${string}`, string], chainId },
    { address: playerSubnameRegistrar, abi: PlayerSubnameRegistrarABI, functionName: "text" as const, args: [node, "inft_id"] as [`0x${string}`, string], chainId },
  ]);

  const { data: textResults } = useReadContracts({
    contracts: textCalls,
    query: { enabled: !staticEntries && nodes.length > 0 },
  });

  // Build entries from on-chain data (or use static entries for fixture pages).
  // Each node occupies 4 slots in textResults: kind, elo, endpoint, inft_id.
  const entries: DiscoveryEntry[] = staticEntries ?? nodes.map((node, i) => {
    const base = i * 4;
    return {
      node,
      label: labelMap[node] ?? node.slice(0, 10),
      kind: (textResults?.[base]?.result as string) ?? "",
      elo: (textResults?.[base + 1]?.result as string) ?? "",
      endpoint: (textResults?.[base + 2]?.result as string) ?? "",
      inftId: (textResults?.[base + 3]?.result as string) ?? "",
    };
  });

  const humans = entries.filter((e) => e.kind === "human");

  // --- Loading / error states (only relevant when reading on-chain) ---
  if (!staticEntries) {
    if (!active) {
      return (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No Chaingammon deployment on this chain. Switch your wallet to see identities.
        </p>
      );
    }
    if (countLoading) {
      return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
    }
    if (countError || subnameCount === undefined) {
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
          Humans
        </h2>
        {humans.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No humans registered yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {humans.map((e) => (
              <EntryCard key={e.node} entry={e} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
