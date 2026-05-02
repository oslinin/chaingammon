// Phase 65: collapsible "Discover Chaingammon subnet" section for the homepage.
//
// Replaces the AgentsList section. Holds a single open/closed toggle.
// ENS subtitle (*.chaingammon.eth) is always visible — it is the primary
// signal to ENS bounty judges that this page indexes an ENS subnet.
// The DiscoveryList is mounted only when expanded; it reads live on-chain
// data from PlayerSubnameRegistrar (ENS text records: kind — player/agent
// classification; elo — portable ELO rating; endpoint — agent play URL).
"use client";

import { useState } from "react";

import { DiscoveryList } from "./DiscoveryList";

/** Collapsible section that indexes the *.chaingammon.eth ENS subnet. */
export function DiscoverSection() {
  const [open, setOpen] = useState(false);

  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Explore the subnet
      </h3>

      <div className="flex flex-col gap-2">
        <button
          data-testid="discover-subnet-button"
          onClick={() => setOpen((o) => !o)}
          className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 sm:w-auto"
        >
          {open ? "Hide subnet ↑" : "Discover Chaingammon subnet →"}
        </button>

        {/* Always-visible ENS signal */}
        <p
          data-testid="discover-ens-subtitle"
          className="font-mono text-xs text-zinc-500 dark:text-zinc-400"
        >
          *.chaingammon.eth
        </p>
      </div>

      {open && (
        <div className="flex flex-col gap-4">
          <p
            data-testid="discover-expanded-description"
            className="max-w-xl text-base leading-7 text-zinc-600 dark:text-zinc-400"
          >
            Indexing all registered identities on the{" "}
            <code className="font-mono text-zinc-900 dark:text-zinc-100">
              *.chaingammon.eth
            </code>{" "}
            ENS subnet on Sepolia.
          </p>
          <DiscoveryList />
        </div>
      )}
    </section>
  );
}
