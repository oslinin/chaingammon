// Phase 28: global sidebar navigation. Phase 35: hidden on mobile (md:flex).
// Phase 36: adds three settlement-visualization entries below "Expenses".
//
// Navigation entries:
//   1. "Play with agent" — links to /match with the most recently played
//      agentId (read from localStorage, set by the match page on mount).
//      Falls back to agentId=1 when no prior game exists.
//   2. "Create new agent" — reveals an inline form that calls
//      AgentRegistry.mintAgent via the connected wallet (onlyOwner on the
//      contract). On success the page redirects to "/" so the new agent
//      appears immediately in AgentsList.
//   3. "Expenses" (Phase 30) — links to /expenses, the 0G token spending
//      ledger. Shows coach-hint and game-settlement charges.
//   4. "0G Storage log" (Phase 36) — links to /log/{currentMatchId}, the live
//      match record on 0G Storage. currentMatchId is written to localStorage
//      by the match page on game start. Falls back to /log/no-match.
//   5. "ENS updates" (Phase 36) — links to /ens/{currentMatchId}, showing
//      both players' ENS text records before/after keeper settlement.
//   6. "KeeperHub steps" (Phase 36) — links to /keeper/{currentMatchId}, the
//      KeeperHub workflow step view (escrow, VRF, replay, settlement, ENS).
//
// The component is SSR-safe: localStorage is read inside useEffect after
// hydration so the server-rendered HTML never diverges from the initial
// client render.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";

import { useChainContracts } from "./contracts";

// Inline ABI fragment for mintAgent. Kept here so the sidebar builds
// independently of the Hardhat compile step (same pattern as ClaimForm
// using SELF_MINT_ABI). The full artifact ABI covers all other reads.
//
// Updated post-Commit 0: mintAgent now takes 4 args. The 4th is an
// explicit subname label; passing "" preserves the legacy
// `_cleanLabel(metadataURI)` behaviour. Commit 4 introduces a proper
// /agents/new page with a label input; until then the sidebar form
// passes the user-typed string as both metadataURI AND label_ so the
// on-chain ENS subname matches what the user typed.
const MINT_AGENT_ABI = [
  {
    type: "function",
    name: "mintAgent",
    inputs: [
      { name: "to", type: "address", internalType: "address" },
      { name: "metadataURI", type: "string", internalType: "string" },
      { name: "tier_", type: "uint8", internalType: "uint8" },
      { name: "label_", type: "string", internalType: "string" },
    ],
    outputs: [{ name: "agentId", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

export function Sidebar() {
  // Defer localStorage access until after hydration to avoid SSR mismatch.
  const [mounted, setMounted] = useState(false);
  const [lastAgentId, setLastAgentId] = useState<number | null>(null);
  const [currentMatchId, setCurrentMatchId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Create-agent form state.
  const [agentLabel, setAgentLabel] = useState("");
  const [agentTier, setAgentTier] = useState<number>(0);

  const { address } = useAccount();
  const { agentRegistry } = useChainContracts();

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

  // Read last active agentId and current match ID from localStorage after hydration.
  useEffect(() => {
    setMounted(true);
    const stored = window.localStorage.getItem("lastAgentId");
    if (stored) setLastAgentId(Number(stored));
    const matchId = window.localStorage.getItem("currentMatchId");
    if (matchId) setCurrentMatchId(matchId);
  }, []);

  // Redirect to home after agent creation so the new agent appears in AgentsList.
  useEffect(() => {
    if (isSuccess) {
      window.location.href = "/";
    }
  }, [isSuccess]);

  const creating = signing || confirming;

  const submit = () => {
    if (!address || !agentLabel.trim()) return;
    reset();
    const trimmed = agentLabel.trim();
    writeContract({
      address: agentRegistry,
      abi: MINT_AGENT_ABI,
      functionName: "mintAgent",
      // Pass the user input as both metadataURI and the explicit label_
      // so the resulting ENS subname matches what they typed. Commit 4
      // introduces a proper /agents/new with separate fields.
      args: [address, trimmed, agentTier, trimmed],
    });
  };

  // Before hydration, render only the structural shell so the server HTML
  // matches the initial client render.
  const playHref =
    mounted && lastAgentId ? `/match?agentId=${lastAgentId}` : "/match?agentId=1";

  const playSubtitle =
    mounted && lastAgentId ? `Agent #${lastAgentId}` : "Start a match";

  return (
    <aside
      data-testid="sidebar"
      className="hidden md:flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Navigation
        </span>
      </div>

      <nav className="flex flex-col gap-1 p-3">
        {/* Entry 0: new match selector — full-roster picker (Commit 2) */}
        <Link
          href="/play/new"
          data-testid="sidebar-play-new"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            New match
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Pick sides + length
          </span>
        </Link>

        {/* Entry 1: current play with agent */}
        <Link
          href={playHref}
          data-testid="sidebar-play"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            Play with agent
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {playSubtitle}
          </span>
        </Link>

        {/* Entry 2: create a new agent */}
        <button
          type="button"
          data-testid="sidebar-create-agent"
          onClick={() => setShowCreateForm((v) => !v)}
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            Create new agent
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Mint an iNFT agent
          </span>
        </button>

        {/* Entry 3: 0G token expense ledger */}
        <Link
          href="/expenses"
          data-testid="sidebar-expenses"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            Expenses
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            0G token ledger
          </span>
        </Link>

        {/* Entry 4: 0G Storage log — live match record on 0G Storage */}
        <Link
          href={mounted && currentMatchId ? `/log/${currentMatchId}` : "/log/no-match"}
          data-testid="sidebar-log"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            0G Storage log
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Live match record
          </span>
        </Link>

        {/* Entry 5: ENS text records before/after keeper settlement */}
        <Link
          href={mounted && currentMatchId ? `/ens/${currentMatchId}` : "/ens/no-match"}
          data-testid="sidebar-ens"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            ENS updates
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Reputation writes
          </span>
        </Link>

        {/* Entry 6: KeeperHub workflow step view — escrow, VRF, replay, settlement */}
        <Link
          href={mounted && currentMatchId ? `/keeper/${currentMatchId}` : "/keeper/no-match"}
          data-testid="sidebar-keeper"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            KeeperHub steps
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Workflow + escrow
          </span>
        </Link>

        {/* Inline create-agent form — shown when the entry above is clicked */}
        {showCreateForm && (
          <div
            data-testid="create-agent-form"
            className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-700"
          >
            <input
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
              className="h-8 rounded border border-zinc-300 bg-white px-2 font-mono text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              disabled={creating}
            />
            <select
              data-testid="agent-tier-select"
              value={agentTier}
              onChange={(e) => setAgentTier(Number(e.target.value))}
              className="h-8 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              disabled={creating}
            >
              <option value={0}>Tier 0</option>
              <option value={1}>Tier 1</option>
              <option value={2}>Tier 2</option>
              <option value={3}>Tier 3</option>
            </select>
            <button
              data-testid="create-agent-submit"
              type="button"
              onClick={submit}
              disabled={creating || !agentLabel.trim() || !address}
              className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {signing ? "Signing…" : confirming ? "Confirming…" : "Create"}
            </button>
            {!address && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Connect wallet to create an agent.
              </p>
            )}
            {writeError && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {writeError.message.split("\n")[0]}
              </p>
            )}
          </div>
        )}
      </nav>
    </aside>
  );
}
