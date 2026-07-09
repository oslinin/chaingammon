// SignInPanel.tsx — Task 5 sign-in: mock zkLogin stand-in + HumanProfile.
//
// AUTH_MODE=mock (the only mode this environment can actually run — no
// Enoki API key / Google OAuth client id configured, see mock_identity.ts)
// generates a real Sui address in the browser and, when a localnet
// configuration is available (see sui_client.ts's loadLocalnetConfig),
// creates/loads that address's on-chain HumanProfile and renders its ELO.
"use client";

import { useCallback, useEffect, useState } from "react";
import { authMode, enokiConfigured, getOrCreateMockIdentity } from "../lib/mock_identity";
import {
  createProfile,
  fetchProfile,
  hasProfile,
  loadLocalnetConfig,
  profileIdFor,
  requestFaucet,
  type ProfileSummary,
} from "../lib/sui_client";

type Status = "signed-out" | "signing-in" | "signed-in" | "error";

export function SignInPanel() {
  const [status, setStatus] = useState<Status>("signed-out");
  const [address, setAddress] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [chainAvailable, setChainAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async () => {
    setStatus("signing-in");
    setError(null);
    try {
      const identity = getOrCreateMockIdentity();
      setAddress(identity.address);

      const config = await loadLocalnetConfig();
      setChainAvailable(!!config);
      if (!config) {
        // No localnet published (this sandbox, or a fresh deployment) —
        // still "signed in" with a real address, just no on-chain profile
        // yet. Per Task 5 Step 1: don't stall the rest of the app on this.
        setStatus("signed-in");
        return;
      }

      await requestFaucet(config, identity.address).catch(() => {
        // Faucet can rate-limit or be briefly unavailable — a returning
        // guest with an already-funded address doesn't need it anyway.
      });

      if (!(await hasProfile(config, identity.address))) {
        const shortAddr = identity.address.slice(0, 8);
        await createProfile(config, identity.keypair, `guest-${shortAddr}`);
      }
      const profileId = await profileIdFor(config, identity.address);
      setProfile(await fetchProfile(config, profileId));
      setStatus("signed-in");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  // Auto sign-in if a mock identity already exists from a previous visit.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("chaingammon.sui.mockIdentitySecretKey")) {
      void signIn();
    }
  }, [signIn]);

  if (status === "signed-in" && address) {
    return (
      <div style={{ fontSize: 12, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-mono)", textAlign: "center" }}>
        <span style={{ color: "var(--cg-brass-hi)" }}>{address.slice(0, 10)}…</span>
        {profile ? (
          <>
            {" · "}{profile.displayName}{" · ELO "}{profile.elo}
          </>
        ) : (
          chainAvailable === false && <> · localnet not configured, chain features unavailable</>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        className="cg-chip"
        style={{ fontSize: 13 }}
        onClick={() => void signIn()}
        disabled={status === "signing-in"}
      >
        {status === "signing-in" ? "Signing in…" : "Sign in"}
      </button>
      <span style={{ fontSize: 11, color: "var(--cg-fg-4)" }}>
        {authMode() === "mock" && !enokiConfigured()
          ? "Mock identity (Enoki not configured) — a real Sui address, no Google sign-in yet."
          : "zkLogin via Google"}
      </span>
      {status === "error" && error && (
        <span style={{ fontSize: 11, color: "var(--cg-danger)" }}>{error}</span>
      )}
    </div>
  );
}
