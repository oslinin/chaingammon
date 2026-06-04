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

import { useAccount, useConnect } from "wagmi";
import { useState, useEffect, useRef } from "react";

import { useSelectableChains } from "./chains";
import { NetworkDropdownView } from "./NetworkDropdownView";

type EIP1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  chainId?: number; // WC EthereumProvider's current chainId (set from rpc.chains config)
  session?: { namespaces?: Record<string, { accounts?: string[]; chains?: string[] }> };
};

export function NetworkDropdown() {
  const { isConnected, chainId: walletChainId } = useAccount();
  const selectableChains = useSelectableChains();
  const { connectors } = useConnect();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const isWC = connectors.some((c) => c.id === "walletConnect");
  const isMobileRef = useRef(typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent));

  // When chain changes (user approved in MetaMask), clear the awaiting state.
  useEffect(() => { setAwaitingApproval(false); }, [walletChainId]);

  if (!isConnected) return null;

  const handleSwitch = async (chainId: number) => {
    const entry = selectableChains.find((c) => c.chain.id === chainId);
    if (!entry) return;
    setIsPending(true);
    setError(null);
    try {
      const { chain } = entry;
      const connector = connectors.find((c) => c.id === "walletConnect") ?? connectors[0];
      if (!connector) return;
      const provider = (await connector.getProvider()) as EIP1193Provider | undefined;
      if (!provider) { setError("Wallet not initialized — please disconnect and reconnect."); return; }
      const hexChainId = `0x${chainId.toString(16)}`;

      // WC sessions from MetaMask mobile omit `chains` from the eip155 namespace.
      // The UniversalProvider crashes on `undefined.includes(...)` when validating
      // the request context. Patch it to include both the accounts' chains AND the
      // provider's configured chainId (which is used as the request context).
      if (provider.session?.namespaces?.eip155) {
        const ns = provider.session.namespaces.eip155;
        if (!ns.chains) {
          const accountChains = (ns.accounts ?? []).map((a) => a.split(":").slice(0, 2).join(":"));
          const configChain = `eip155:${provider.chainId ?? 11155111}`;
          ns.chains = [...new Set([configChain, ...accountChains])];
        }
      }

      // wallet_switchEthereumChain is silently ignored by MetaMask via WC for chains
      // not already in the approved session namespace. wallet_addEthereumChain works
      // unconditionally and prompts the user even for new chains.
      const switchPromise = provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexChainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [],
        }],
      });

      // On mobile WC, the switch prompt appears inside MetaMask. Open MetaMask
      // so the user can see and approve it before it times out.
      if (isMobileRef.current && isWC) {
        setAwaitingApproval(true);
        window.location.href = "metamask://";
      }

      await switchPromise;
    } catch (e) {
      setAwaitingApproval(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsPending(false);
    }
  };

  if (awaitingApproval) {
    return (
      <a
        href="metamask://"
        style={{ fontSize: 12, color: "#F6851B", textDecoration: "none", whiteSpace: "nowrap" }}
      >
        Approve in MetaMask ↗
      </a>
    );
  }

  return (
    <NetworkDropdownView
      activeChainId={walletChainId ?? 0}
      selectableChains={selectableChains}
      isPending={isPending}
      error={error}
      onSwitch={handleSwitch}
    />
  );
}
