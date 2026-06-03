"use client";

// Privy login button — replaces the previous wagmi-only injected/WalletConnect
// connect flow. A single "Log in" pill opens Privy's modal, which surfaces:
//   - Email (one-time code → Privy embedded wallet)
//   - Google OAuth (→ Privy embedded wallet)
//   - MetaMask (window.ethereum, when injected)
//   - WalletConnect (any mobile wallet via QR)
//
// After login, Privy's wagmi connector promotes the active wallet into
// wagmi state, so `useAccount()` returns the connected address and every
// existing `useReadContract` / `useWriteContract` keeps working unchanged.
//
// States:
//   1. Not authenticated                       → "Log in" button (opens Privy modal)
//   2. Authenticated, wallet not yet in wagmi   → "Connecting…" (embedded-wallet provisioning)
//   3. Authenticated + connected wallet         → network dropdown, profile badge, disconnect
//
// SSR note: no `mounted` guard is needed. During prerender Privy reports
// `authenticated=false` and wagmi has no account, so the server renders the
// "Log in" button; the client's first (hydration) render matches because
// Privy hasn't restored a session yet. A stored session promotes to the
// connected view on a later render, which React permits post-hydration. The
// button shows independent of Privy's async `ready` flag, so the auth entry
// point never disappears if Privy's backend is slow or unreachable — the
// click handler guards on `ready` so a click before init is a safe no-op.

import { usePrivy } from "@privy-io/react-auth";
import { useAccount } from "wagmi";
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

// @privy-io/wagmi's WagmiProvider does not provide wagmi context during SSR
// in Next.js App Router. Guard all wagmi hook calls behind a mount check so
// the server renders a static "Log in" pill (correct — Privy never has an
// authenticated session during SSR) and the client hydrates cleanly.
function ConnectButtonInner() {
  const { t } = useI18n();
  const { ready, authenticated, login, logout } = usePrivy();
  const { address, isConnected } = useAccount();
  // Lazy-initialized once at mount (ConnectButton guards this component
  // behind a mounted check, so window/navigator are always available here).
  const [isMobile] = useState(() => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
  const [hasInjected] = useState(() => "ethereum" in window);

  // Connected: Privy authenticated AND wagmi has promoted the active wallet.
  if (authenticated && isConnected && address) {
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
          onClick={() => { void logout(); }}
          style={{ ...secondaryBtn, height: 32, fontSize: 12 }}
        >
          {t("disconnect")}
        </button>
      </div>
    );
  }

  // Authenticated via Privy, but wagmi hasn't wired up an address yet —
  // common while an embedded wallet (email/Google login) is provisioning,
  // or immediately after login before Privy's wagmi connector finishes.
  // The state can wedge (e.g. a stored session whose wallet no longer
  // restores), so pair it with a log-out escape hatch.
  if (authenticated) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button type="button" disabled style={{ ...secondaryBtn, opacity: 0.6 }}>
          {t("connecting")}
        </button>
        <button
          type="button"
          onClick={() => { void logout(); }}
          style={{ ...secondaryBtn, height: 32, fontSize: 12 }}
        >
          {t("disconnect")}
        </button>
      </div>
    );
  }

  // Not authenticated → "Log in". Shown regardless of `ready`; the handler
  // is a no-op until Privy finishes initialising.
  //
  // On mobile without window.ethereum, also show a deep link that opens the
  // page inside MetaMask Mobile's browser, which injects window.ethereum
  // natively so the user can log in through the Privy modal from there.
  const showDeepLink = isMobile && !hasInjected;

  return (
    <div style={{ display: "flex", gap: "8px" }}>
      <button
        type="button"
        data-testid="login-button"
        onClick={() => { if (ready) login(); }}
        style={primaryBtn}
        className="cg-btn-primary"
      >
        {t("log_in")}
      </button>
      {showDeepLink && (
        <a
          href={`metamask://dapp/${window.location.host}${window.location.pathname}${window.location.search}`}
          data-testid="open-in-metamask"
          style={{ ...pillBase, background: "#F6851B", color: "#fff", border: "1px solid rgba(0,0,0,0.2)", textDecoration: "none" }}
        >
          Open in MetaMask
        </a>
      )}
    </div>
  );
}

export function ConnectButton() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) {
    return (
      <button type="button" style={primaryBtn} className="cg-btn-primary">
        Log in
      </button>
    );
  }
  return <ConnectButtonInner />;
}
