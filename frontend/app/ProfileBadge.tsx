// Phase 15: connected-wallet identity badge.
//
// Three states:
//   1. Looking up name → "…"
//   2. No subname → shortened address + "Claim name" inline form. Submitting
//      POSTs to the server's /subname/mint (the server is the registrar
//      owner and signs `mintSubname` on the user's behalf).
//   3. Subname found → "<label>.chaingammon.eth (1547)" with the ELO
//      pulled from the registrar's `elo` text record (Phase 11 writes it).
"use client";

import { useState } from "react";

import { useChaingammonName } from "./useChaingammonName";
import { useChaingammonProfile } from "./useChaingammonProfile";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

function shorten(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function ProfileBadge({ address }: { address: `0x${string}` }) {
  const { label, name, isLoading: nameLoading } = useChaingammonName(address);
  const { elo } = useChaingammonProfile(label);

  const [showClaim, setShowClaim] = useState(false);
  const [claimInput, setClaimInput] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  if (nameLoading) {
    return (
      <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
        {shorten(address)}
      </span>
    );
  }

  if (label) {
    return (
      <span className="font-mono text-sm text-zinc-700 dark:text-zinc-300">
        {name}
        {elo ? (
          <span className="ml-1 text-zinc-500 dark:text-zinc-400">({elo})</span>
        ) : null}
      </span>
    );
  }

  if (showClaim) {
    const submit = async () => {
      const trimmed = claimInput.trim();
      if (!trimmed) return;
      setClaiming(true);
      setClaimError(null);
      try {
        const res = await fetch(`${API_URL}/subname/mint`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: trimmed, owner_address: address }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => res.statusText);
          throw new Error(detail);
        }
        // Reload so every component re-runs its log scan and re-fetches text
        // records. The subname doesn't show up via wagmi's cache otherwise.
        window.location.reload();
      } catch (e: unknown) {
        setClaimError(e instanceof Error ? e.message : String(e));
      } finally {
        setClaiming(false);
      }
    };
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <input
            value={claimInput}
            onChange={(e) => setClaimInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="alice"
            className="h-8 w-32 rounded-md border border-zinc-300 bg-white px-2 font-mono text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            disabled={claiming}
            autoFocus
          />
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
            .chaingammon.eth
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={claiming || !claimInput.trim()}
            className="h-8 rounded-md bg-indigo-600 px-3 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {claiming ? "Claiming…" : "Claim"}
          </button>
        </div>
        {claimError ? (
          <span className="max-w-xs text-right text-xs text-red-600 dark:text-red-400">
            {claimError}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-sm text-zinc-700 dark:text-zinc-300">
        {shorten(address)}
      </span>
      <button
        type="button"
        onClick={() => setShowClaim(true)}
        className="inline-flex h-8 items-center rounded-full border border-zinc-300 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
      >
        Claim name
      </button>
    </div>
  );
}
