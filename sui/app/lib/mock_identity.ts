// mock_identity.ts — AUTH_MODE=mock stand-in for zkLogin (Task 5).
//
// Real zkLogin needs Enoki (NEXT_PUBLIC_ENOKI_API_KEY) + a Google OAuth
// client id (NEXT_PUBLIC_GOOGLE_CLIENT_ID) — neither is configured in this
// environment. Per the plan's Task 5 Step 1 ("implement behind a
// NEXT_PUBLIC_AUTH_MODE=mock|enoki switch, ship mock, flag missing keys —
// do NOT stall the plan"), this module is the `mock` side: a real Sui
// Ed25519 keypair generated in the browser and persisted in localStorage,
// giving every guest a real address (as the design spec's §6 "guest =
// zkLogin user with zero SUI" model intends) without any OAuth round-trip.
// Swap this module out for a real Enoki session once
// `authMode() === "enoki"` has something to connect to.

"use client";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const STORAGE_KEY = "chaingammon.sui.mockIdentitySecretKey";

export type AuthMode = "mock" | "enoki";

/** Which auth path is configured. Defaults to "mock" — see module doc comment. */
export function authMode(): AuthMode {
  const mode = process.env.NEXT_PUBLIC_AUTH_MODE;
  return mode === "enoki" ? "enoki" : "mock";
}

/** True once Enoki + Google OAuth are actually configured (never in this environment yet). */
export function enokiConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_ENOKI_API_KEY && !!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
}

export interface MockIdentity {
  keypair: Ed25519Keypair;
  address: string;
}

/**
 * Load the persisted mock identity for this browser, or generate and
 * persist a fresh one. Stable across reloads (same address every time) so
 * a returning guest keeps the same on-chain profile.
 */
export function getOrCreateMockIdentity(): MockIdentity {
  if (typeof window === "undefined") {
    throw new Error("getOrCreateMockIdentity() is browser-only");
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const keypair = stored
    ? Ed25519Keypair.fromSecretKey(stored)
    : Ed25519Keypair.generate();
  if (!stored) {
    window.localStorage.setItem(STORAGE_KEY, keypair.getSecretKey());
  }
  return { keypair, address: keypair.getPublicKey().toSuiAddress() };
}

/** Forget the persisted mock identity (sign out). A new one is generated next sign-in. */
export function clearMockIdentity(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
