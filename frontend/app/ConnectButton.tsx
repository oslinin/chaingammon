"use client";

// MetaMask connect button — directly uses wagmi's injected() connector.
// Connection is persisted in localStorage so it survives page reloads.
//
// States:
//   1. Not connected      → "Log in" button (opens MetaMask)
//   2. Connecting         → "Connecting…" (MetaMask approval pending)
//   3. Connected          → network dropdown, profile badge, disconnect

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";
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

function ConnectButtonInner() {
  const { t } = useI18n();
  const { address, isConnected } = useAccount();
  const { connect, isPending, error: connectError, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  // ConnectButton guards this behind a mount check so window/navigator are safe here.
  const [isMobile] = useState(() => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || /Mobi/i.test(navigator.userAgent));
  // Treat window.ethereum as injected only if it's a real browser extension (not WC-injected).
  const [hasInjected] = useState(() => {
    if (!("ethereum" in window)) return false;
    const eth = (window as { ethereum?: { isWalletConnect?: boolean } }).ethereum;
    return !!eth && !eth.isWalletConnect;
  });
  const wcConnector = connectors.find((c) => c.id === "walletConnect");
  const [wcUri, setWcUri] = useState<string | null>(null);

  // Pre-register display_uri listener so there's no race with the async event.
  useEffect(() => {
    if (!wcConnector || !isMobile || hasInjected) return;
    const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
      if (type === "display_uri") {
        const uri = data as string;
        setWcUri(uri);
        // Try the universal link; if the app isn't installed this is a no-op.
        window.location.href = `metamask://wc?uri=${encodeURIComponent(uri)}`;
      }
    };
    wcConnector.emitter.on("message", onMessage);
    return () => { wcConnector.emitter.off("message", onMessage); };
  }, [wcConnector, isMobile, hasInjected]);

  if (isConnected && address) {
    return (
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
        <NetworkDropdown />
        <UsdcBalanceDisplay address={address} />
        <ProfileBadge address={address} />
        <button type="button" onClick={() => disconnect()} style={{ ...secondaryBtn, height: 32, fontSize: 12 }}>
          {t("disconnect")}
        </button>
      </div>
    );
  }

  // On mobile Chrome/Safari, window.ethereum is absent — use WalletConnect.
  if (isMobile && !hasInjected) {
    if (connectError) {
      return (
        <div style={{ fontSize: 11, color: "red", maxWidth: 200 }}>
          Error: {connectError.message}
        </div>
      );
    }

    if (isPending && wcUri) {
      // URI ready but redirect may not have worked — show manual fallback.
      return (
        <a
          href={`metamask://wc?uri=${encodeURIComponent(wcUri)}`}
          data-testid="open-in-metamask"
          style={{ ...primaryBtn, background: "#F6851B", color: "#fff", border: "none", textDecoration: "none" }}
        >
          {t("connect_wallet")}
        </a>
      );
    }

    if (isPending) {
      return (
        <button type="button" disabled style={{ ...secondaryBtn, opacity: 0.6 }}>
          {t("connecting")}
        </button>
      );
    }

    return (
      <button
        type="button"
        data-testid="login-button"
        onClick={() => { if (wcConnector) connect({ connector: wcConnector }); }}
        style={{ ...primaryBtn, background: "#F6851B", color: "#fff", border: "1px solid rgba(0,0,0,0.2)" }}
        className="cg-btn-primary"
      >
        {t("connect_wallet")}
      </button>
    );
  }

  if (isPending) {
    return (
      <button type="button" disabled style={{ ...secondaryBtn, opacity: 0.6 }}>
        {t("connecting")}
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid="login-button"
      onClick={() => connect({ connector: injected() })}
      style={primaryBtn}
      className="cg-btn-primary"
    >
      {t("connect_wallet")}
    </button>
  );
}

export function ConnectButton() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) {
    return (
      <button type="button" style={primaryBtn} className="cg-btn-primary">
        Connect wallet
      </button>
    );
  }
  return <ConnectButtonInner />;
}
