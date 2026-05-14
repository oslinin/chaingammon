// Phase 28: global sidebar navigation. Phase 35: hidden on mobile (md:flex).
// Phase 36: adds three settlement-visualization entries below "Expenses".
//
// Navigation entries:
//   1. "Home" — landing page with agent cards and lobby.
//   2. "Training" — round-robin self-play session launcher.
//   3. "0G Storage log" — live match record on 0G Storage.
//   4. "ENS updates" — players' ENS text records before/after settlement.
//   5. "KeeperHub steps" — KeeperHub workflow step view.
//
// The component is SSR-safe: localStorage is read inside useEffect after
// hydration so the server-rendered HTML never diverges from the initial
// client render.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export function Sidebar() {
  const [currentMatchId, setCurrentMatchId] = useState<string | null>(null);

  useEffect(() => {
    const matchId = window.localStorage.getItem("currentMatchId");
    if (matchId) setCurrentMatchId(matchId);
  }, []);

  return (
    <aside
      data-testid="sidebar"
      className="hidden md:flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
    >
      <nav className="flex flex-col gap-1 p-3">
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

      </nav>
    </aside>
  );
}
