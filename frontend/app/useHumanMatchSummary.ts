// Chain-only summary of a human player's match history.
//
// Matches useAgentMatchSummary.ts but filters by address instead of agentId.
"use client";

import { useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";

import { useActiveChain, useActiveChainId } from "./chains";
import { useChainContracts } from "./contracts";

const MATCH_RECORDED_EVENT = parseAbiItem(
  "event MatchRecorded(uint256 indexed matchId, uint256 winnerAgentId, address winnerHuman, uint256 loserAgentId, address loserHuman, uint256 newWinnerElo, uint256 newLoserElo)",
);

export interface MatchSummary {
  matches: number;
  wins: number;
  losses: number;
}

export function useHumanMatchSummary(address: `0x${string}` | undefined) {
  const chainId = useActiveChainId();
  const client = usePublicClient({ chainId });
  const { matchRegistry } = useChainContracts();
  const deployedBlock = useActiveChain()?.deployedBlock;

  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !matchRegistry || !address || address === "0x0000000000000000000000000000000000000000") {
      setSummary(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const isLocalChain = chainId === 31337;
    const computeFromBlock = async (): Promise<bigint | "earliest"> => {
      if (isLocalChain) return "earliest";
      if (typeof deployedBlock === "number") return BigInt(deployedBlock);
      const tip = await client.getBlockNumber();
      const WINDOW = BigInt(49_000);
      return tip > WINDOW ? tip - WINDOW : BigInt(0);
    };

    const targetAddr = address.toLowerCase();

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
          if (args.winnerHuman?.toLowerCase() === targetAddr) wins += 1;
          else if (args.loserHuman?.toLowerCase() === targetAddr) losses += 1;
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
  }, [address, client, matchRegistry, chainId, deployedBlock]);

  return { summary, isLoading, error };
}
