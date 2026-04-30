"use client";

// Connect / disconnect button with injected-wallet and WalletConnect support.
//
// Four states:
//   1. Not mounted (SSR)          → null (avoids hydration mismatch)
//   2. No wallet / no WC config   → "Install MetaMask" link
//   3. Not connected, wallet(s) available → injected button + WalletConnect
//      button (if projectId is configured)
//   4. Connected                  → network dropdown, profile badge, disconnect
//
// SSR note: wagmi is configured with ssr:true so the server renders connectors
// as []. The `mounted` guard defers the real render until after hydration so
// both trees agree and the click handler is never silently dropped.

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
  const wcConnector = connectors.find((c: Connector) => c.type === "walletConnect");

  if (!mounted) return null;

  if (!isConnected) {
    const hasAnyConnector = injectedConnector || wcConnector;
    if (!hasAnyConnector) {
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
        <div className="flex flex-wrap justify-end gap-2">
          {injectedConnector && (
            <button
              type="button"
              onClick={() => connect({ connector: injectedConnector })}
              disabled={connectPending}
              className="inline-flex h-10 items-center rounded-full bg-zinc-900 px-4 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {connectPending ? "Connecting…" : "Browser wallet"}
            </button>
          )}
          {wcConnector && (
            <button
              type="button"
              onClick={() => connect({ connector: wcConnector })}
              disabled={connectPending}
              className="inline-flex h-10 items-center rounded-full border border-zinc-300 px-4 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
            >
              WalletConnect
            </button>
          )}
        </div>
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
