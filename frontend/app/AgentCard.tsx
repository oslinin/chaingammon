// Phase 13: on-chain agent card with live ELO.
//
// Reads agentMetadata (label/URI) from AgentRegistry and agentElo from
// MatchRegistry in a single batched call. The "Play" link navigates to
// /match?agentId=N where the match flow begins.
"use client";

import Link from "next/link";
import { useReadContracts } from "wagmi";
import {
  AgentRegistryABI,
  MatchRegistryABI,
  AGENT_REGISTRY_ADDRESS,
  MATCH_REGISTRY_ADDRESS,
} from "./contracts";

interface AgentCardProps {
  agentId: number;
}

export function AgentCard({ agentId }: AgentCardProps) {
  const { data, isLoading } = useReadContracts({
    contracts: [
      {
        address: AGENT_REGISTRY_ADDRESS,
        abi: AgentRegistryABI,
        functionName: "agentMetadata",
        args: [BigInt(agentId)],
      },
      {
        address: MATCH_REGISTRY_ADDRESS,
        abi: MatchRegistryABI,
        functionName: "agentElo",
        args: [BigInt(agentId)],
      },
    ],
  });

  const metadataUri = data?.[0]?.result as string | undefined;
  const elo = data?.[1]?.result as bigint | undefined;

  // metadataUri is the label passed at mintAgent time — short human-readable
  // strings like "gnubg-classic". Fall back to the numeric ID if it's missing
  // or suspiciously long (a real URI rather than a label).
  const label =
    metadataUri && metadataUri.length <= 80
      ? metadataUri
      : `Agent #${agentId}`;

  const eloDisplay = elo !== undefined ? elo.toString() : "—";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-50 break-all">
          {label}
        </h3>
        <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          #{agentId}
        </span>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          ELO
        </span>
        <span className="font-mono text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          {isLoading ? "…" : eloDisplay}
        </span>
      </div>

      <Link
        href={`/match?agentId=${agentId}`}
        className="mt-1 rounded-md bg-indigo-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
      >
        Play
      </Link>
    </div>
  );
}
