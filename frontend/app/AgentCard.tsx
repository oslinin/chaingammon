// Phase 13: on-chain agent card with live ELO.
// Match record (played / won / lost) is derived chain-only from
// MatchRegistry's MatchRecorded event log via useAgentMatchSummary —
// always live, no server, no 0G fetch — and rendered inline on the card
// (was an on-hover popover; the eth_getLogs round-trip was too slow to
// only fire on hover, so it now resolves once at mount).
//
// Reads agentMetadata (label/URI) from AgentRegistry and agentElo from
// MatchRegistry in a single batched call. The "Play" link navigates to
// /match?agentId=N where the match flow begins.
"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";

import { useActiveChainId } from "./chains";
import {
  AgentRegistryABI,
  MatchRegistryABI,
  useChainContracts,
} from "./contracts";
import {
  formatAgentMatchProse,
  useAgentMatchSummary,
} from "./useAgentMatchSummary";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

interface AgentCardProps {
  agentId: number;
}

interface ProfileResponse {
  match_count: number;
}

export function AgentCard({ agentId }: AgentCardProps) {
  const chainId = useActiveChainId();
  const { agentRegistry, matchRegistry } = useChainContracts();

  const { data, isLoading } = useReadContracts({
    contracts: [
      {
        address: agentRegistry,
        abi: AgentRegistryABI,
        functionName: "agentMetadata",
        args: [BigInt(agentId)],
        chainId,
      },
      {
        address: matchRegistry,
        abi: MatchRegistryABI,
        functionName: "agentElo",
        args: [BigInt(agentId)],
        chainId,
      },
    ],
    // Sepolia block time is ~12s and ELO bumps once recordMatch lands.
    // Without a poll the card stays frozen until manual refresh.
    query: { refetchInterval: 8000 },
  });

  const metadataUri = data?.[0]?.result as string | undefined;
  const elo = data?.[1]?.result as bigint | undefined;

  // 0G "games trained" — read from the trained checkpoint metadata via
  // the FastAPI /profile endpoint. Bumped only by training rounds, never
  // by single matches. Pairs with the on-chain "matches played" derived
  // from MatchRecorded events below; together they're the two sides of
  // the agent's progression. Polled at 8s to pick up freshly-finished
  // training without forcing a manual reload.
  const profileQuery = useQuery({
    queryKey: ["agent-profile", agentId],
    refetchInterval: 8000,
    queryFn: async (): Promise<ProfileResponse> => {
      const r = await fetch(`${SERVER}/agents/${agentId}/profile`);
      if (!r.ok) throw new Error(`/agents/${agentId}/profile → ${r.status}`);
      return r.json();
    },
  });
  const trainedCount = profileQuery.data?.match_count;

  // Phase 15: format the agent identity as `<label>.chaingammon.eth` for
  // visual parity with player names. metadataUri is the string passed at
  // mintAgent time (e.g. `ipfs://gnubg-default-placeholder`); strip the
  // protocol prefix and any path slashes, then attach the parent. Fall
  // back to a plain `Agent #N` if it's missing or suspiciously long
  // (would be a real URI rather than a short label).
  const cleanedLabel = metadataUri
    ? metadataUri.replace(/^ipfs:\/\//, "").replace(/^[^:]+:\/\//, "").replaceAll("/", "-")
    : "";
  const label =
    cleanedLabel && cleanedLabel.length <= 60
      ? cleanedLabel
      : `Agent #${agentId}`;

  const eloDisplay = elo !== undefined ? elo.toString() : "—";

  const matchQuery = useAgentMatchSummary(agentId);
  const matchProse = formatAgentMatchProse(matchQuery.summary, elo);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-50 break-all">
          {label}
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          {/* Info link — opens the agent detail page in a new tab. */}
          <a
            href={`/agent/${agentId}`}
            target="_blank"
            rel="noreferrer"
            data-testid="agent-card-info-link"
            title="Open agent info in a new tab"
            className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
          >
            Info ↗
          </a>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            #{agentId}
          </span>
        </div>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          ELO
        </span>
        <span className="font-mono text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          {isLoading ? "…" : eloDisplay}
        </span>
      </div>

      {/* Two counters, two sources — see test_counter_separation.py.
          • games trained  — match_count embedded in the trained
            checkpoint blob on 0G Storage (bumped only by training).
          • matches played — derived from MatchRegistry.MatchRecorded
            event log (bumped only by recordMatch). */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
        {trainedCount !== undefined && (
          <p
            className="font-mono text-zinc-500 dark:text-zinc-400"
            title="0G — embedded in the trained checkpoint blob"
          >
            <span className="font-semibold text-zinc-700 dark:text-zinc-200">
              {trainedCount}
            </span>{" "}
            games trained
          </p>
        )}
        {matchQuery.summary && (
          <p
            className="font-mono text-zinc-500 dark:text-zinc-400"
            title="On-chain — MatchRegistry.MatchRecorded events"
          >
            <span className="font-semibold text-zinc-700 dark:text-zinc-200">
              {matchQuery.summary.matches}
            </span>{" "}
            matches played
          </p>
        )}
      </div>

      <div className="text-xs">
        {matchQuery.isLoading ? (
          <p className="text-zinc-400 dark:text-zinc-500">Reading chain…</p>
        ) : matchQuery.error ? (
          <p className="text-red-600 dark:text-red-400">
            Could not read MatchRegistry.
          </p>
        ) : matchQuery.summary ? (
          <>
            <p className="font-mono text-zinc-700 dark:text-zinc-300">
              {matchQuery.summary.wins} won · {matchQuery.summary.losses} lost
            </p>
            <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">
              {matchProse}
            </p>
          </>
        ) : null}
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
