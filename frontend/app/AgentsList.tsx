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

  const { data: activeCount, isLoading, error } = useReadContract({
    address: agentRegistry,
    abi: AgentRegistryABI,
    functionName: "activeAgentCount",
    chainId,
    query: { enabled: !!active },
  });

  const count = activeCount !== undefined ? Number(activeCount) : 0;

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
      <p style={{ fontSize: 14, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
        No Chaingammon deployment on this chain ({chainName}). Switch your
        wallet to one of the supported chains to see agents.
      </p>
    );
  }

  if (isLoading) {
    return (
      <p style={{ fontSize: 14, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
        Loading agents…
      </p>
    );
  }

  if (error || activeCount === undefined) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14, color: "var(--cg-fg-3)" }}>
        <p style={{ margin: 0 }}>No agents found.</p>
        <p style={{ margin: 0, fontSize: 12 }}>
          Could not reach{" "}
          <code style={{ fontFamily: "var(--cg-font-mono)" }}>AgentRegistry</code> at{" "}
          <code style={{ fontFamily: "var(--cg-font-mono)" }}>{agentRegistry}</code> on {chainName}.
          {error ? (
            <span style={{ color: "var(--cg-danger)", marginLeft: 4 }}>
              {error.message}
            </span>
          ) : null}
        </p>
      </div>
    );
  }

  if (count === 0) {
    return (
      <p style={{ fontSize: 14, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
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
