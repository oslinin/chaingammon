"use client";

// Wagmi-aware wrapper around `NetworkDropdownView`.
//
// Renders nothing when the wallet is disconnected — the dropdown's
// purpose is wallet-mediated chain switching, so without a wallet
// there's nothing to drive. When connected, it pulls the wallet's
// ACTUAL chainId from `useAccount()` (NOT `useChainId()`, which is
// clamped to a configured chain by wagmi and would lie about the
// wallet's real state after WalletConnect reconnects on a chain we
// don't deploy to). The view shows "Wrong network" when that chainId
// isn't in `selectableChains`.

import { useAccount, useSwitchChain } from "wagmi";

import { useSelectableChains } from "./chains";
import { NetworkDropdownView } from "./NetworkDropdownView";

export function NetworkDropdown() {
  const { isConnected, chainId: walletChainId } = useAccount();
  const selectableChains = useSelectableChains();
  const { switchChain, isPending, error } = useSwitchChain();

  if (!isConnected) return null;

  return (
    <NetworkDropdownView
      activeChainId={walletChainId ?? 0}
      selectableChains={selectableChains}
      isPending={isPending}
      error={error?.message ?? null}
      onSwitch={(id) => switchChain({ chainId: id })}
    />
  );
}
