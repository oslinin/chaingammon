"use client";

// Wagmi-aware wrapper around `NetworkDropdownView`.
//
// Renders nothing when the wallet is disconnected — the dropdown's
// purpose is wallet-mediated chain switching, so without a wallet
// there's nothing to drive. When connected, it pulls the active chain
// from `useChainId()` (kept in sync with the wallet's `chainChanged`
// event by wagmi, so MetaMask-originated switches update the trigger
// label automatically) and feeds the view.

import { useAccount, useChainId, useSwitchChain } from "wagmi";

import { useSelectableChains } from "./chains";
import { NetworkDropdownView } from "./NetworkDropdownView";

export function NetworkDropdown() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const selectableChains = useSelectableChains();
  const { switchChain, isPending, error } = useSwitchChain();

  if (!isConnected) return null;

  return (
    <NetworkDropdownView
      activeChainId={chainId}
      selectableChains={selectableChains}
      isPending={isPending}
      error={error?.message ?? null}
      onSwitch={(id) => switchChain({ chainId: id })}
    />
  );
}
