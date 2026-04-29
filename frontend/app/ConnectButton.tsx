"use client";

// Phase 12: connect / disconnect button + network dropdown.
//
// Three states:
//   1. No wallet detected (no injected connector)  → "Install MetaMask"
//   2. Wallet detected, not connected              → "Connect wallet"
//   3. Connected                                   → network dropdown
//      (replaces the old amber "Switch to X" nudge), profile badge,
//      disconnect button.
//
// SSR note: wagmi is configured with ssr:true, which means the server has no
// access to window.ethereum and renders connectors as []. Without a mounted
// guard the server emits "Install MetaMask" while the client wants "Connect
// wallet" — a structural mismatch that causes React hydration to silently
// drop the click handler. The `mounted` state defers the real render until
// after hydration so both trees agree.

import { useAccount, useConnect, useDisconnect } from "wagmi";
import type { Connector } from "wagmi";
import { useState, useEffect } from "react";

import { NetworkDropdown } from "./NetworkDropdown";
import { ProfileBadge } from "./ProfileBadge";

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: connectPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const injectedConnector = connectors.find((c: Connector) => c.type === "injected");

  // Render nothing until hydration is complete — avoids a structural mismatch
  // between the SSR output (no window.ethereum) and the client tree.
  if (!mounted) return null;

  if (!isConnected) {
    if (!injectedConnector) {
      return (
        <a
          href="https://metamask.io/download/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center rounded-full border border-zinc-300 px-4 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Install MetaMask
        </a>
      );
    }
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => connect({ connector: injectedConnector })}
          disabled={connectPending}
          className="inline-flex h-10 items-center rounded-full bg-zinc-900 px-4 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {connectPending ? "Connecting…" : "Connect wallet"}
        </button>
        {connectError ? (
          <span className="text-xs text-red-600 dark:text-red-400">
            {connectError.message}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <NetworkDropdown />
      {address ? <ProfileBadge address={address} /> : null}
      <button
        type="button"
        onClick={() => disconnect()}
        className="inline-flex h-9 items-center rounded-full border border-zinc-300 px-3 text-xs font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
      >
        Disconnect
      </button>
    </div>
  );
}
