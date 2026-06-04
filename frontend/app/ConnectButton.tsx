"use client";

// MetaMask connect button — replaces the previous Privy-based login flow.
//
// Connects directly to the browser-injected wallet (MetaMask, Brave, etc.)
// via wagmi's useConnect hook with the injected() connector. No third-party
// auth service is involved, so the button works identically in Chrome,
// Firefox, and Brave as long as MetaMask (or any EIP-1193 wallet) is
// installed.
//
// States:
//   1. Not mounted (SSR)                       → static "Log in" pill
//   2. Mounted, no window.ethereum (mobile)    → "Open in MetaMask" deep link
//   3. Mounted, ethereum present, disconnected → "Log in" button (connects)
//   4. Connecting / pending                    → "Connecting…" + escape hatch
//   5. Connected                               → network dropdown, profile badge, disconnect
//
// The "Open in MetaMask" deep link (state 2) sends mobile users to
// MetaMask Mobile's in-app browser, where window.ethereum IS injected and
// the normal connect flow (state 3→5) works.

import { useConnect, useDisconnect, useAccount } from "wagmi";
import { injected } from "@wagmi/core";
import { useState, useEffect } from "react";

import { NetworkDropdown } from "./NetworkDropdown";
import { ProfileBadge } from "./ProfileBadge";
import { UsdcBalanceDisplay } from "./UsdcBalanceDisplay";
import { useI18n } from "./i18n";

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
  textDecoration: "none",
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

// Inner component — only rendered client-side after mount, so all wagmi
// hooks are safe. The outer ConnectButton shell gates on `mounted`.
function ConnectButtonInner() {
  const { t } = useI18n();
  const { address, isConnected, isConnecting } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  // Connected: wagmi has a live account.
  if (isConnected && address) {
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
        <UsdcBalanceDisplay address={address} />
        <ProfileBadge address={address} />
        <button
          type="button"
          onClick={() => { disconnect(); }}
          style={{ ...secondaryBtn, height: 32, fontSize: 12 }}
        >
          {t("disconnect")}
        </button>
      </div>
    );
  }

  // Connecting: pending wagmi state (eth_requestAccounts in flight).
  if (isConnecting || isPending) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button type="button" disabled style={{ ...secondaryBtn, opacity: 0.6 }}>
          {t("connecting")}
        </button>
        <button
          type="button"
          onClick={() => { disconnect(); }}
          style={{ ...secondaryBtn, height: 32, fontSize: 12 }}
        >
          {t("disconnect")}
        </button>
      </div>
    );
  }

  // Disconnected with ethereum present — normal connect button.
  return (
    <button
      type="button"
      data-testid="login-button"
      onClick={() => { connect({ connector: connectors[0] ?? injected() }); }}
      style={primaryBtn}
      className="cg-btn-primary"
    >
      {t("log_in")}
    </button>
  );
}

export function ConnectButton() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // SSR / pre-hydration: static pill so the server render matches the first
  // client render (no hydration mismatch). Privy used to handle this; now
  // we just render a neutral button until the client has checked the wallet.
  if (!mounted) {
    return (
      <button type="button" style={primaryBtn} className="cg-btn-primary">
        Log in
      </button>
    );
  }

  // Mobile / browsers without an injected EIP-1193 provider: show a deep
  // link that opens the current page inside MetaMask Mobile's in-app
  // browser, where window.ethereum IS injected.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(window as any).ethereum) {
    const deepLink = `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}`;
    return (
      <a
        data-testid="open-in-metamask"
        href={deepLink}
        style={primaryBtn}
        className="cg-btn-primary"
      >
        Open in MetaMask
      </a>
    );
  }

  return <ConnectButtonInner />;
}
