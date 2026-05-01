// /play/new — match selector. The user picks one or more subnames per
// side, the match length, and the mode (single-game vs career). The
// adaptive Start button routes to either /play/auto (when all sides
// are agents) or /match (when at least one human is involved).
//
// Roster comes from PlayerSubnameRegistrar's SubnameMinted event log
// — see useAllChaingammonSubnames. ELO + agent_id discriminator come
// from each subname's profile (eloOf typed view + agent_id text record).
import { Suspense } from "react";

import { ConnectButton } from "../../ConnectButton";
import { Sidebar } from "../../Sidebar";
import { PlayNewPicker } from "./PlayNewPicker";

export default function PlayNewPage() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1">
        <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <h1 className="text-lg font-semibold">New match</h1>
          <ConnectButton />
        </header>
        <Suspense fallback={<div className="p-6">Loading roster…</div>}>
          <PlayNewPicker />
        </Suspense>
      </main>
    </div>
  );
}
