// Phase 35: fixed bottom navigation bar for mobile screens.
// Hidden on md+ breakpoints (>= 768px) where the sidebar is visible.
// Reads lastAgentId from localStorage (same key the match page writes)
// so the Play link targets the most recently used agent.
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function MobileNav() {
  const [lastAgentId, setLastAgentId] = useState<number | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem("lastAgentId");
    if (stored) setLastAgentId(Number(stored));
  }, []);

  const playHref = lastAgentId
    ? `/match?agentId=${lastAgentId}`
    : "/match?agentId=1";

  const linkClass =
    "flex flex-1 items-center justify-center py-3 text-sm font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50";

  return (
    <nav
      data-testid="mobile-nav"
      aria-label="Mobile navigation"
      className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-zinc-200 bg-white md:hidden dark:border-zinc-800 dark:bg-zinc-950"
    >
      <Link href="/" data-testid="mobile-nav-home" className={linkClass}>
        Home
      </Link>
      <Link href={playHref} data-testid="mobile-nav-play" className={linkClass}>
        Play
      </Link>
      <Link href="/transactions" data-testid="mobile-nav-transactions" className={linkClass}>
        Transactions
      </Link>
    </nav>
  );
}
