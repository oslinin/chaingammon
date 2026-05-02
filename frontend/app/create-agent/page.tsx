// Create-agent page. The sidebar "Create new agent" link navigates here;
// this page owns the mint form that was previously inlined in the sidebar.
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";

import { useChainContracts } from "../contracts";
import { useActiveChainId } from "../chains";
import { recordExpense } from "../expenses";

// Inline ABI fragment — same as the one that was in Sidebar.tsx.
const MINT_AGENT_ABI = [
  {
    type: "function",
    name: "mintAgent",
    inputs: [
      { name: "to", type: "address", internalType: "address" },
      { name: "metadataURI", type: "string", internalType: "string" },
      { name: "tier_", type: "uint8", internalType: "uint8" },
    ],
    outputs: [{ name: "agentId", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

export default function CreateAgentPage() {
  const router = useRouter();
  const { address } = useAccount();
  const { agentRegistry } = useChainContracts();
  const chainId = useActiveChainId();

  const [agentLabel, setAgentLabel] = useState("");
  const [agentTier, setAgentTier] = useState<number>(0);

  const {
    writeContract,
    data: txHash,
    error: writeError,
    isPending: signing,
    reset,
  } = useWriteContract();

  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // Record expense and navigate home once the tx is confirmed.
  useEffect(() => {
    if (isSuccess) {
      recordExpense({
        type: "agent_mint",
        description: `Agent minted: "${agentLabel}" (Tier ${agentTier})`,
        txHash,
        chainId,
      });
      router.push("/");
    }
  }, [isSuccess, agentLabel, agentTier, router, txHash, chainId]);

  const creating = signing || confirming;

  const submit = () => {
    if (!address || !agentLabel.trim()) return;
    reset();
    writeContract({
      address: agentRegistry,
      abi: MINT_AGENT_ABI,
      functionName: "mintAgent",
      args: [address, agentLabel.trim(), agentTier],
    });
  };

  return (
    <main className="flex flex-1 flex-col gap-6 p-6 max-w-md">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          Create new agent
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Mint an iNFT agent on-chain. You must be the contract owner.
        </p>
      </div>

      <div
        data-testid="create-agent-form"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
          <label
            htmlFor="agent-label"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Agent label
          </label>
          <input
            id="agent-label"
            data-testid="agent-label-input"
            type="text"
            value={agentLabel}
            onChange={(e) => {
              setAgentLabel(e.target.value);
              reset();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="agent-label"
            className="h-9 rounded border border-zinc-300 bg-white px-3 font-mono text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            disabled={creating}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="agent-tier"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Tier
          </label>
          <select
            id="agent-tier"
            data-testid="agent-tier-select"
            value={agentTier}
            onChange={(e) => setAgentTier(Number(e.target.value))}
            className="h-9 rounded border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            disabled={creating}
          >
            <option value={0}>Tier 0</option>
            <option value={1}>Tier 1</option>
            <option value={2}>Tier 2</option>
            <option value={3}>Tier 3</option>
          </select>
        </div>

        {!address && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Connect your wallet to create an agent.
          </p>
        )}

        {writeError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {writeError.message.split("\n")[0]}
          </p>
        )}

        <button
          data-testid="create-agent-submit"
          type="button"
          onClick={submit}
          disabled={creating || !agentLabel.trim() || !address}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {signing ? "Signing…" : confirming ? "Confirming…" : "Create agent"}
        </button>
      </div>
    </main>
  );
}
