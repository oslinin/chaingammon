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
  background: "var(--cg-brass)",
  color: "var(--cg-brass-ink)",
  border: "none",
};

const secondaryBtn: React.CSSProperties = {
  ...pillBase,
  background: "transparent",
  color: "var(--cg-fg-2)",
  border: "1px solid var(--cg-line-2)",
};

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: connectPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const injectedConnector = connectors.find((c: Connector) => c.type === "injected");
  const wcConnector = connectors.find((c: Connector) => c.type === "walletConnect");
  const [userAttempted, setUserAttempted] = useState(false);

  if (!mounted) return null;

  if (!isConnected) {
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
              className="disabled:opacity-60"
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
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
