"use client";

// Phase 12: connect / disconnect / chain-switch button.
//
// Three states:
//   1. No wallet detected (no injected connector)  → show "Install MetaMask"
//   2. Wallet detected, not connected              → show "Connect wallet"
//   3. Connected                                   → show shortened address +
//      a chain-switch nudge if the active chain isn't 0G testnet, plus a
//      disconnect button.

import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import type { Connector } from "wagmi";

import { ProfileBadge } from "./ProfileBadge";
import { CHAIN_REGISTRY } from "./wagmi";

// Any chain in the registry is acceptable; the user gets a nudge back
// to the first registry chain (the wagmi default) if they're on a chain
// we don't have deployments for.
const SUPPORTED_CHAIN_IDS = new Set<number>(
  Object.keys(CHAIN_REGISTRY).map(Number),
);

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending: connectPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switchPending } = useSwitchChain();

  const injectedConnector = connectors.find((c: Connector) => c.type === "injected");

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

  // Any chain in the registry is acceptable. If the wallet is on
  // something else (e.g. mainnet), nudge to the first registry chain
  // (which is also wagmi's default for not-connected reads).
  const onWrongChain = !SUPPORTED_CHAIN_IDS.has(chainId);
  const targetChain = Object.values(CHAIN_REGISTRY)[0]?.chain;

  return (
    <div className="flex items-center gap-2">
      {onWrongChain && targetChain ? (
        <button
          type="button"
          onClick={() => switchChain({ chainId: targetChain.id })}
          disabled={switchPending}
          className="inline-flex h-9 items-center rounded-full bg-amber-500 px-3 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-60"
        >
          {switchPending ? "Switching…" : `Switch to ${targetChain.name}`}
        </button>
      ) : null}
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
