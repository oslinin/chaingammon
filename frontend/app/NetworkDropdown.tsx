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

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";

import { useSelectableChains } from "./chains";
import { NetworkDropdownView } from "./NetworkDropdownView";

type WCProvider = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  session?: { namespaces?: Record<string, { accounts?: string[]; chains?: string[]; methods?: string[] }> };
};

export function NetworkDropdown() {
  const { isConnected, chainId: walletChainId, connector } = useAccount();
  const selectableChains = useSelectableChains();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // After every chain change, re-apply the namespace fix. MetaMask mobile
  // omits methods/chains from session namespaces; updateNamespace() resets
  // them on chainChanged, breaking subsequent WC requests (eth_sendTransaction etc.).
  useEffect(() => {
    if (connector?.id !== "walletConnect") return;
    connector.getProvider().then((p: any) => {
      const ns = p?.signer?.rpcProviders?.eip155?.namespace;
      if (ns) {
        if (!ns.chains) ns.chains = (ns.accounts ?? []).map((a: string) => a.split(":").slice(0, 2).join(":"));
        if (!ns.methods) ns.methods = ["wallet_addEthereumChain", "wallet_switchEthereumChain", "eth_sendTransaction", "personal_sign", "eth_accounts", "eth_requestAccounts"];
      }
    }).catch(() => {});
  }, [walletChainId, connector]);

  if (!isConnected) return null;

  if (isPending && connector?.id === "walletConnect") {
    return (
      <span style={{ fontSize: 12, color: "#F6851B", whiteSpace: "nowrap" }}>
        Switch to MetaMask to approve
      </span>
    );
  }

  return (
    <NetworkDropdownView
      activeChainId={walletChainId ?? 0}
      selectableChains={selectableChains}
      isPending={isPending}
      error={error}
      onSwitch={async (id) => {
        const entry = selectableChains.find((c) => c.chain.id === id);
        if (!entry || !connector) return;
        const { chain } = entry;
        setIsPending(true);
        setError(null);
        try {
          const provider = await connector.getProvider() as WCProvider;
          // WC 2.x bug: MetaMask mobile sessions omit `chains` and `methods`
          // from the eip155 namespace. Patch the internal routing namespace so
          // the provider doesn't crash on undefined.includes().
          const internalNs = (provider as any)?.signer?.rpcProviders?.eip155?.namespace;
          if (internalNs) {
            if (!internalNs.chains) internalNs.chains = (internalNs.accounts ?? []).map((a: string) => a.split(":").slice(0, 2).join(":"));
            if (!internalNs.methods) internalNs.methods = ["wallet_addEthereumChain", "wallet_switchEthereumChain", "eth_sendTransaction", "personal_sign"];
          }
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: `0x${id.toString(16)}`,
              chainName: chain.name,
              nativeCurrency: chain.nativeCurrency,
              rpcUrls: chain.rpcUrls.default.http,
              blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [],
            }],
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setIsPending(false);
        }
      }}
    />
  );
}
