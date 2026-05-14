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

import { useQuery } from "@tanstack/react-query";
import { formatEther } from "viem";
import { useReadContracts } from "wagmi";

import { useActiveChainId } from "./chains";
import {
  AgentRegistryABI,
  MatchRegistryABI,
  useChainContracts,
} from "./contracts";
import { useAgentMatchSummary } from "./useAgentMatchSummary";
import { PersonCard } from "./PersonCard";

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

  const walletQuery = useQuery({
    queryKey: ["agent-wallet", agentId],
    refetchInterval: 8000,
    queryFn: async (): Promise<{ balance_wei: string } | null> => {
      const r = await fetch(`${SERVER}/agents/${agentId}/wallet`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`/agents/${agentId}/wallet → ${r.status}`);
      return r.json();
    },
  });
  const balanceWei = walletQuery.data?.balance_wei
    ? BigInt(walletQuery.data.balance_wei)
    : BigInt(0);
  const balance = walletQuery.isLoading
    ? undefined
    : `${parseFloat(formatEther(balanceWei)).toFixed(4)} ETH`;

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

  const matchQuery = useAgentMatchSummary(agentId);

  const extraLines = trainedCount !== undefined
    ? [`${trainedCount} games trained`]
    : [];

  return (
    <PersonCard
      label={label}
      elo={isLoading ? undefined : elo}
      balance={balance}
      matchSummary={
        matchQuery.isLoading ? undefined : (matchQuery.summary ?? null)
      }
      infoHref={`/agent/${agentId}`}
      infoLabel={`#${agentId}`}
      playHref={`/match?agentId=${agentId}`}
      extraLines={extraLines}
    />
  );
}
