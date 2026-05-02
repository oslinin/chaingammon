// Phase 28: global sidebar navigation. Phase 35: hidden on mobile (md:flex).
//
// Navigation entries:
//   0. "Home" — lobby and agent list.
//   1. "Play with agent" — links to /match with the most recently played
//      agentId (read from localStorage). Falls back to agentId=1.
//   2. "Create new agent" — links to /create-agent (AgentRegistry.mintAgent).
//   3. "Transactions" — links to /transactions, the gas/KeeperHub/0G ledger.
//      Short summaries of all protocol events (0G storage, ENS, KeeperHub,
//      agent ops) are recorded here.
//   4. "Training" — round-robin self-play training.
//   5. "Play with team" — team-mode advisor demo (per-turn advisor signals).
//
// The component is SSR-safe: localStorage is read inside useEffect after
// hydration so the server-rendered HTML never diverges from the initial
// client render.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export function Sidebar() {
  // Defer localStorage access until after hydration to avoid SSR mismatch.
  const [mounted, setMounted] = useState(false);
  const [lastAgentId, setLastAgentId] = useState<number | null>(null);

  // Read last active agentId from localStorage after hydration.
  useEffect(() => {
    setMounted(true);
    const stored = window.localStorage.getItem("lastAgentId");
    if (stored) setLastAgentId(Number(stored));
  }, []);

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
        {/* Entry 0: home page */}
        <Link
          href="/"
          data-testid="sidebar-home"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            Home
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Agents &amp; lobby
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

        {/* Entry 2: create a new agent — navigates to dedicated /create-agent page */}
        <Link
          href="/create-agent"
          data-testid="sidebar-create-agent"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            Create new agent
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Mint an iNFT agent
          </span>
        </Link>

        {/* Entry 3: transaction ledger */}
        <Link
          href="/transactions"
          data-testid="sidebar-transactions"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            Transactions
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Gas, KeeperHub, 0G ledger
          </span>
        </Link>

        {/* Entry 3.5: round-robin training (Phase F) */}
        <Link
          href="/training"
          data-testid="sidebar-training"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            Training
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Round-robin self-play
          </span>
        </Link>

        {/* Entry 3.6: team-mode advisor demo (Phase K) */}
        <Link
          href="/team-demo"
          data-testid="sidebar-team-demo"
          className="flex flex-col gap-0.5 rounded-md px-3 py-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            Play with team
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Per-turn advisor signals
          </span>
        </Link>
      </nav>
    </aside>
  );
}
