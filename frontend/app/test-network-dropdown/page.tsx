"use client";

// Fixture page for `NetworkDropdownView` Playwright coverage.
//
// Renders the presentational dropdown with controlled props so the
// rendering can be exercised without standing up a mock wagmi config.
// Variants are selected with `?variant=…` — see the test spec for the
// supported values.
//
// This page is non-production. It must not be linked from the main UI
// and Vercel/CI builds may safely include or exclude it.

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

import { useSelectableChains } from "../chains";
import { NetworkDropdownView } from "../NetworkDropdownView";

export default function TestNetworkDropdownPage() {
  return (
    <Suspense fallback={<p className="p-8">Loading…</p>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const params = useSearchParams();
  const variant = params.get("variant") ?? "active";

  const selectableChains = useSelectableChains();
  const [lastSwitch, setLastSwitch] = useState<number | null>(null);

  let activeChainId = 16602; // 0G Galileo Testnet
  let isPending = false;
  if (variant === "wrong") activeChainId = 1; // Mainnet, not in registry
  if (variant === "switching") isPending = true;

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-zinc-50 p-12 dark:bg-black">
      <h1 className="text-lg font-semibold">
        NetworkDropdownView fixture — variant={variant}
      </h1>
      <NetworkDropdownView
        activeChainId={activeChainId}
        selectableChains={selectableChains}
        isPending={isPending}
        onSwitch={(id) => setLastSwitch(id)}
      />
      <pre
        data-testid="last-switch"
        className="rounded bg-zinc-100 px-2 py-1 font-mono text-xs dark:bg-zinc-900"
      >
        {lastSwitch === null ? "" : String(lastSwitch)}
      </pre>
    </div>
  );
}
