// HomeActionChips — action chip bar on the home page.
//
// Chips shown per mode:
//   elo      (default) — Off-chain game, On-chain game
//   money               — same as elo (stake option appears on the /match page)
//   advanced            — Mint, Train, Off-chain game, On-chain game
"use client";

import Link from "next/link";
import { useAppMode } from "./AppModeContext";

export function HomeActionChips() {
  const { mode } = useAppMode();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {mode === "advanced" && (
        <>
          <Link href="/create-agent" className="cg-chip cg-chip-gold">Mint</Link>
          <Link href="/training" className="cg-chip cg-chip-muted">Train</Link>
        </>
      )}
      <Link href="/team-demo" className="cg-chip cg-chip-muted">Off-chain game</Link>
      <Link href="/team-demo?settle=1" className="cg-chip cg-chip-warm">On-chain game</Link>
    </div>
  );
}
