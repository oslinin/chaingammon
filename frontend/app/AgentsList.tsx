// Phase 13 + Phase 24: reads agentCount from AgentRegistry on the chain
// the wallet is currently on. Address comes from `chains.ts` (which
// reads `contracts/deployments/<network>.json`) — there's no env-var
// chainId to keep in sync.
"use client";

import { useReadContract } from "wagmi";

import { useActiveChain, useActiveChainId } from "./chains";
import { AgentCard } from "./AgentCard";
import { AgentRegistryABI, useChainContracts } from "./contracts";

export function AgentsList() {
  const active = useActiveChain();
  const chainId = useActiveChainId();
  const { agentRegistry } = useChainContracts();

  const { data: agentCount, isLoading, error } = useReadContract({
    address: agentRegistry,
    abi: AgentRegistryABI,
    functionName: "agentCount",
    chainId,
    query: { enabled: !!active },
  });

  const chainName = active?.chain.name ?? `chainId ${chainId}`;

  if (!active) {
    // Wallet is on a chain we have no deployments for (e.g. mainnet) —
    // ask the user to switch instead of pretending to load.
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

  // The read failed (RPC unreachable, or no contract at agentRegistry on
  // this chain). Tell the user what we tried instead of pretending the
  // list is just empty.
  if (error || agentCount === undefined) {
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

  const count = Number(agentCount);

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
