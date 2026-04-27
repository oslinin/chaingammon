// Phase 13: reads agentCount from AgentRegistry, then renders one AgentCard
// per registered agent. Separated from page.tsx so the server-rendered page
// shell is static and only this component hydrates on the client.
"use client";

import { useReadContract } from "wagmi";
import { AgentRegistryABI, AGENT_REGISTRY_ADDRESS } from "./contracts";
import { AgentCard } from "./AgentCard";

export function AgentsList() {
  const { data: agentCount, isLoading } = useReadContract({
    address: AGENT_REGISTRY_ADDRESS,
    abi: AgentRegistryABI,
    functionName: "agentCount",
  });

  const count = agentCount ? Number(agentCount) : 0;

  if (isLoading) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Loading agents…
      </p>
    );
  }

  if (count === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No agents registered yet.
      </p>
    );
  }

  // Agent IDs start at 1 (incrementing counter in AgentRegistry.mintAgent).
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => i + 1).map((id) => (
        <AgentCard key={id} agentId={id} />
      ))}
    </div>
  );
}
