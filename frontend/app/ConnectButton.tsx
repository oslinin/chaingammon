"use client";

// Connect / disconnect button with injected-wallet and WalletConnect support.
//
// States:
//   1. Not mounted (SSR)                      → null (avoids hydration mismatch)
//   2. Mobile, no injected wallet + WC        → "Connect wallet" (WalletConnect)
//   3. No wallet / no WC config               → "Install MetaMask" link
//   4. Not connected, wallet(s) available     → connect buttons
//   5. Connected                              → network dropdown, profile badge, disconnect
//
// SSR note: wagmi is configured with ssr:true so the server renders connectors
// as []. The `mounted` guard defers the real render until after hydration so
// both trees agree and the click handler is never silently dropped.

import { useAccount, useConnect, useDisconnect } from "wagmi";
import type { Connector } from "wagmi";
import { useState, useEffect } from "react";

import { NetworkDropdown } from "./NetworkDropdown";
import { ProfileBadge } from "./ProfileBadge";

const pillBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 36,
  borderRadius: "var(--cg-radius-pill)",
  padding: "0 16px",
  fontSize: 13,
  fontWeight: 500,
  fontFamily: "var(--cg-font-sans)",
  cursor: "pointer",
  transition: "background 120ms ease, border-color 120ms ease",
  whiteSpace: "nowrap",
};

const primaryBtn: React.CSSProperties = {
  ...pillBase,
  background: "linear-gradient(180deg, #E3B779 0%, #C99B5C 55%, #B0843E 100%)",
  color: "var(--cg-brass-ink)",
  border: "1px solid rgba(0,0,0,0.3)",
  boxShadow: "0 1px 0 0 rgba(255,236,196,0.35) inset, 0 -1px 0 0 rgba(0,0,0,0.25) inset, 0 4px 12px -3px rgba(140,90,30,0.4)",
};

const secondaryBtn: React.CSSProperties = {
  ...pillBase,
  background: "transparent",
  color: "var(--cg-fg-2)",
  border: "1px solid var(--cg-line-2)",
};

/** True when running on a phone or tablet (UA-based; post-mount only). */
function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

/** True when an EIP-1193 provider (window.ethereum) is actually injected. */
function hasInjectedProvider(): boolean {
  return typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
}

/** Deep link that opens the current page inside MetaMask Mobile's in-app browser. */
function metaMaskDeepLink(): string {
  const { hostname, pathname, search } = window.location;
  return `https://metamask.app.link/dapp/${hostname}${pathname}${search}`;
}

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: connectPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [hasProvider, setHasProvider] = useState(false);
  const [userAttempted, setUserAttempted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setIsMobile(isMobileBrowser());
    setHasProvider(hasInjectedProvider());
  }, []);

  // wagmi v3 always includes the `injected()` connector in its config regardless
  // of whether window.ethereum exists, so a truthy `connectors.find(...)` does
  // NOT mean a wallet is installed. Gate the injected flow on `hasProvider`
  // (a runtime window.ethereum check) — otherwise clicking "Browser wallet" on
  // a vanilla mobile browser throws `ProviderNotFoundError`.
  const injectedConnector = hasProvider
    ? connectors.find((c: Connector) => c.type === "injected")
    : undefined;
  const wcConnector = connectors.find((c: Connector) => c.type === "walletConnect");

  if (!mounted) return null;

  if (!isConnected) {
    // Mobile browser without window.ethereum — show both the MetaMask deep
    // link (opens dapp in MetaMask's browser where ethereum is injected) and
    // WalletConnect (QR / deep link into any mobile wallet).
    if (isMobile && !injectedConnector) {
      return (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
          <a
            href={metaMaskDeepLink()}
            data-testid="open-in-metamask"
            style={primaryBtn}
            className="cg-btn-primary"
          >
            Open in MetaMask
          </a>
          {wcConnector && (
            <button
              type="button"
              onClick={() => { setUserAttempted(true); connect({ connector: wcConnector }); }}
              disabled={connectPending}
              style={secondaryBtn}
              className="disabled:opacity-60"
            >
              WalletConnect
            </button>
          )}
        </div>
      );
    }

    const hasAnyConnector = injectedConnector || wcConnector;
    if (!hasAnyConnector) {
      return (
        <a
          href="https://metamask.io/download/"
          target="_blank"
          rel="noopener noreferrer"
          style={secondaryBtn}
        >
          Install MetaMask
        </a>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
          {injectedConnector && (
            <button
              type="button"
              onClick={() => { setUserAttempted(true); connect({ connector: injectedConnector }); }}
              disabled={connectPending}
              style={primaryBtn}
              className="cg-btn-primary disabled:opacity-60"
            >
              {connectPending ? "Connecting…" : "Connect wallet"}
            </button>
          )}
          {wcConnector && (
            <button
              type="button"
              onClick={() => { setUserAttempted(true); connect({ connector: wcConnector }); }}
              disabled={connectPending}
              style={secondaryBtn}
              className="disabled:opacity-60"
            >
              WalletConnect
            </button>
          )}
        </div>
        {userAttempted && connectError ? (
          <span style={{ fontSize: 11, color: "var(--cg-danger)" }}>
            {connectError.message}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        gap: 8,
      }}
    >
      <NetworkDropdown />
      {address ? <ProfileBadge address={address} /> : null}
      <button
        type="button"
        onClick={() => disconnect()}
        style={{ ...secondaryBtn, height: 32, fontSize: 12 }}
      >
        Disconnect
      </button>
    </div>
  );
}
