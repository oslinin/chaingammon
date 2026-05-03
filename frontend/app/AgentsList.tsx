// Phase 13 + Phase 24: reads agentCount from AgentRegistry on the chain
// the wallet is currently on. Address comes from `chains.ts` (which
// reads `contracts/deployments/<network>.json`) — there's no env-var
// chainId to keep in sync.
//
// Phase N: switched from agentCount + 1..N iteration to
// activeAgentCount + activeAgentAt(i) multicall so burned agents
// are never rendered.
"use client";

import { useReadContract, useReadContracts } from "wagmi";

import { useActiveChain, useActiveChainId } from "./chains";
import { AgentCard } from "./AgentCard";
import { AgentRegistryABI, useChainContracts } from "./contracts";

export function AgentsList() {
  const active = useActiveChain();
  const chainId = useActiveChainId();
  const { agentRegistry } = useChainContracts();

  // Step 1 — how many active (non-burned) agents exist?
  const { data: activeCount, isLoading, error } = useReadContract({
    address: agentRegistry,
    abi: AgentRegistryABI,
    functionName: "activeAgentCount",
    chainId,
    query: { enabled: !!active },
  });

  const count = activeCount !== undefined ? Number(activeCount) : 0;

  // Step 2 — fetch the actual agentId at each active index in one batch.
  const indexCalls = Array.from({ length: count }, (_, i) => ({
    address: agentRegistry,
    abi: AgentRegistryABI,
    functionName: "activeAgentAt" as const,
    args: [BigInt(i)] as [bigint],
    chainId,
  }));

  const { data: idResults } = useReadContracts({
    contracts: indexCalls,
    query: { enabled: !!active && count > 0 },
  });

  const agentIds = (idResults ?? [])
    .map((r) => r?.result as bigint | undefined)
    .filter((v): v is bigint => v !== undefined)
    .map(Number);

  const chainName = active?.chain.name ?? `chainId ${chainId}`;

  if (!active) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No Chaingammon deployment on this chain ({chainName}). Switch your
        wallet to one of the supported chains to see agents.
      </p>
    );
  }

  if (isLoading) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Loading agents…
      </p>
    );
  }

  if (error || activeCount === undefined) {
    return (
      <div className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
        <p>No agents found.</p>
        <p className="text-xs">
          Could not reach <code className="font-mono">AgentRegistry</code> at{" "}
          <code className="font-mono">{agentRegistry}</code> on {chainName}.
          {error ? (
            <>
              {" "}
              <span className="text-red-600 dark:text-red-400">
                {error.message}
              </span>
            </>
          ) : null}
        </p>
      </div>
    );
  }

  if (count === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No agents registered yet.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {agentIds.map((id) => (
        <AgentCard key={id} agentId={id} />
      ))}
    </div>
  );
}
