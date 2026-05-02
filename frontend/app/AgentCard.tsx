// Phase 13: on-chain agent card with live ELO.
// Phase F: hover popover surfaces the on-chain profile (match count +
// summary) by lazy-fetching /agents/{id}/profile when the card is
// hovered or focused — kept lazy so the home page doesn't fan out N
// requests on mount.
//
// Reads agentMetadata (label/URI) from AgentRegistry and agentElo from
// MatchRegistry in a single batched call. The "Play" link navigates to
// /match?agentId=N where the match flow begins.
"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";

import { useActiveChainId } from "./chains";
import {
  AgentRegistryABI,
  MatchRegistryABI,
  useChainContracts,
} from "./contracts";

// /agents/{id}/profile lives on the backend FastAPI server (port 8000),
// not on coach_service (port 8002). Earlier this constant pointed at
// the coach URL by mistake, which 404'd every profile fetch and surfaced
// "Profile unavailable" on every agent-card hover popover.
const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

interface AgentProfile {
  agent_id: number;
  kind: "model" | "overlay" | "null";
  match_count: number;
  summary: string;
}

interface AgentCardProps {
  agentId: number;
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
  });

  const metadataUri = data?.[0]?.result as string | undefined;
  const elo = data?.[1]?.result as bigint | undefined;

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
      ? `${cleanedLabel}.chaingammon.eth`
      : `Agent #${agentId}`;

  const eloDisplay = elo !== undefined ? elo.toString() : "—";

  // Phase F: hover/focus → lazy-fetch the agent's profile from
  // /agents/{id}/profile. Stale-time 60s so re-hovering the same card
  // doesn't refetch; `enabled: hovered` keeps the home page from
  // fanning out N requests when the user just lands on it.
  const [hovered, setHovered] = useState(false);
  const profileQuery = useQuery({
    enabled: hovered,
    staleTime: 60_000,
    queryKey: ["agent-profile", agentId],
    queryFn: async (): Promise<AgentProfile> => {
      const r = await fetch(`${SERVER}/agents/${agentId}/profile`);
      if (!r.ok) throw new Error(`/profile → ${r.status}`);
      return r.json();
    },
  });

  return (
    <div
      className="relative group flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
      onMouseEnter={() => setHovered(true)}
      onFocus={() => setHovered(true)}
    >
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

      {/* Hover popover — surfaces the profile loaded from the backend.
          Hidden by default; revealed on hover/focus via Tailwind group. */}
      <div className="invisible absolute left-full top-0 z-10 ml-2 w-64 rounded-lg border border-zinc-200 bg-white p-3 text-xs shadow-lg group-hover:visible group-focus-within:visible dark:border-zinc-700 dark:bg-zinc-950">
        <div className="mb-1 font-mono uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Profile
        </div>
        {profileQuery.isLoading ? (
          <p className="text-zinc-500">Loading profile…</p>
        ) : profileQuery.error ? (
          <p className="text-red-600">Profile unavailable.</p>
        ) : profileQuery.data ? (
          <>
            <p className="mb-1 text-zinc-700 dark:text-zinc-300">
              <span className="font-mono">
                Matches: {profileQuery.data.match_count}
              </span>
              <span className="ml-2 rounded bg-zinc-100 px-1 py-0.5 font-mono text-[10px] uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                {profileQuery.data.kind}
              </span>
            </p>
            <p className="text-zinc-600 dark:text-zinc-400">
              {profileQuery.data.summary}
            </p>
          </>
        ) : (
          <p className="text-zinc-500">Hover to load.</p>
        )}
      </div>
    </div>
  );
}
