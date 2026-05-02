// Chain-only summary of an agent's match history.
//
// Replaces the server-rendered `summary` field in the agent-card hover
// popover for the "match counts" use case. The summary blob on 0G Storage
// only updates when the trainer runs, so freshly-played matches don't
// appear in `match_count` until retraining. Deriving the count from
// `MatchRegistry.MatchRecorded` event logs is always live and needs no
// server, no 0G Storage round-trip, and no Python decoder.
//
// Event signature (MatchRegistry.sol:81):
//   MatchRecorded(uint256 indexed matchId, uint256 winnerAgentId,
//                 address winnerHuman,      uint256 loserAgentId,
//                 address loserHuman,       uint256 newWinnerElo,
//                 uint256 newLoserElo)
// Only `matchId` is indexed, so the agent filter happens client-side
// after the log fetch — fine at testnet match volumes.
"use client";

import { useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";

import { useActiveChain, useActiveChainId } from "./chains";
import { useChainContracts } from "./contracts";

const MATCH_RECORDED_EVENT = parseAbiItem(
  "event MatchRecorded(uint256 indexed matchId, uint256 winnerAgentId, address winnerHuman, uint256 loserAgentId, address loserHuman, uint256 newWinnerElo, uint256 newLoserElo)",
);

export interface AgentMatchSummary {
  matches: number;
  wins: number;
  losses: number;
}

export function useAgentMatchSummary(agentId: number) {
  const chainId = useActiveChainId();
  const client = usePublicClient({ chainId });
  const { matchRegistry } = useChainContracts();
  const deployedBlock = useActiveChain()?.deployedBlock;

  const [summary, setSummary] = useState<AgentMatchSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !matchRegistry || matchRegistry.length < 4) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    // Same `fromBlock` strategy as useChaingammonName: prefer the
    // deployment-recorded block, fall back to a sliding 49k-block
    // window for live chains (under publicnode's 50k-block cap),
    // "earliest" for hardhat localhost.
    const isLocalChain = chainId === 31337;
    const computeFromBlock = async (): Promise<bigint | "earliest"> => {
      if (isLocalChain) return "earliest";
      if (typeof deployedBlock === "number") return BigInt(deployedBlock);
      const tip = await client.getBlockNumber();
      const WINDOW = BigInt(49_000);
      return tip > WINDOW ? tip - WINDOW : BigInt(0);
    };

    const targetId = BigInt(agentId);

    computeFromBlock()
      .then((fromBlock) =>
        client.getLogs({
          address: matchRegistry,
          event: MATCH_RECORDED_EVENT,
          fromBlock,
        }),
      )
      .then((logs) => {
        if (cancelled) return;
        let wins = 0;
        let losses = 0;
        for (const log of logs) {
          const args = log.args;
          if (!args) continue;
          if (args.winnerAgentId === targetId) wins += 1;
          else if (args.loserAgentId === targetId) losses += 1;
        }
        setSummary({ matches: wins + losses, wins, losses });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, client, matchRegistry, chainId, deployedBlock]);

  return { summary, isLoading, error };
}

/**
 * Format the chain-derived match summary as the popover prose. Mirrors
 * the cadence of agent_profile.summarize() so the UI stays consistent
 * after the swap from server fetch to chain read.
 */
export function formatAgentMatchProse(
  summary: AgentMatchSummary | null,
  currentElo: bigint | undefined,
): string {
  if (!summary) return "Loading match history…";
  if (summary.matches === 0) {
    return "No matches played yet — fresh agent.";
  }
  const eloDelta =
    currentElo !== undefined ? Number(currentElo) - 1500 : null;
  const eloPart =
    eloDelta === null
      ? ""
      : eloDelta === 0
      ? ""
      : ` (ELO ${eloDelta > 0 ? "+" : ""}${eloDelta} from 1500)`;
  const recordPart = `${summary.matches} match${summary.matches === 1 ? "" : "es"} played · ${summary.wins} won · ${summary.losses} lost`;
  return `${recordPart}${eloPart}.`;
}
