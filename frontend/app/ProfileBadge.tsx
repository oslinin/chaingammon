// Phase 21: ENS name selection UX improvements.
//
// ClaimForm is now shown automatically when a connected wallet has no
// backgammon.eth subname — no extra "Claim name" button click required.
// Input is validated against ENS label rules (lowercase alphanumeric +
// hyphens, 1-63 chars). If the chosen name is already taken the component
// surfaces a fallback suggestion (<label><3-digit suffix>) so the user
// can claim a name without starting over.
//
// Phase 22: ENS minting decentralised — ClaimForm now calls
// `selfMintSubname` directly on the PlayerSubnameRegistrar contract via
// wagmi's `useWriteContract`. No central API server is involved. Requires
// the contract to be redeployed with `selfMintSubname` (added in Phase 22).
"use client";

import { useEffect, useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";

import { useChaingammonName } from "./useChaingammonName";
import { useChaingammonProfile } from "./useChaingammonProfile";
import { useChainContracts } from "./contracts";

// Inline ABI fragment for selfMintSubname. Kept here instead of relying
// on the artifact so the component builds independently of the compile
// step. The full artifact ABI is still used by other contract reads.
const SELF_MINT_ABI = [
  {
    type: "function",
    name: "selfMintSubname",
    inputs: [{ name: "label", type: "string", internalType: "string" }],
    outputs: [{ name: "node", type: "bytes32", internalType: "bytes32" }],
    stateMutability: "nonpayable",
  },
] as const;

function shorten(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** ENS label rules: starts/ends with alphanumeric, only a-z 0-9 and hyphens, 1–63 chars. */
function isValidLabel(s: string): boolean {
  return s.length >= 1 && s.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s);
}

/** Returns a human-readable validation problem, or null if the label is valid. */
function labelValidationMessage(s: string): string | null {
  if (!s) return null;
  if (s.length > 63) return "Name must be 63 characters or fewer.";
  if (!/^[a-z0-9]/.test(s)) return "Name must start with a letter or number.";
  if (s.endsWith("-")) return "Name cannot end with a hyphen.";
  if (!/^[a-z0-9-]+$/.test(s)) return "Only lowercase letters, numbers, and hyphens allowed.";
  return null;
}

/** Deterministic-ish 3-digit suffix for fallback name suggestions. */
function randomSuffix(): string {
  return String(Math.floor(Math.random() * 900) + 100);
}

/** True when the wagmi write error indicates the name is already registered. */
function isSubnameAlreadyTaken(error: Error | null): boolean {
  if (!error) return false;
  const msg = error.message;
  return (
    msg.includes("SubnameAlreadyExists") ||
    msg.toLowerCase().includes("subnamealreadyexists") ||
    msg.toLowerCase().includes("already taken")
  );
}

/**
 * Standalone claim form — shown automatically when the wallet has no subname.
 * Exported separately so a test fixture page can render it without the
 * name-lookup hooks that ProfileBadge wraps around it.
 *
 * Calls `selfMintSubname(label)` on the PlayerSubnameRegistrar contract
 * directly via the connected wallet — no central server required.
 */
export function ClaimForm({ address: _address }: { address: `0x${string}` }) {
  const [claimInput, setClaimInput] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const { playerSubnameRegistrar } = useChainContracts();

  const {
    writeContract,
    data: txHash,
    error: writeError,
    isPending: signing,
    reset: resetWrite,
  } = useWriteContract();

  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // Reload so every component re-runs its subname lookup after the tx confirms.
  useEffect(() => {
    if (isSuccess) window.location.reload();
  }, [isSuccess]);

  // Show fallback suggestion when the name is already taken.
  useEffect(() => {
    if (writeError && isSubnameAlreadyTaken(writeError)) {
      setSuggestion(`${claimInput}${randomSuffix()}`);
    } else {
      setSuggestion(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeError]);

  const claiming = signing || confirming;

  // User-facing error string derived from the wagmi write error.
  const claimError = writeError
    ? isSubnameAlreadyTaken(writeError)
      ? `"${claimInput}" is already taken.`
      : writeError.message.split("\n")[0] // first line only
    : null;

  const submit = (labelToUse?: string) => {
    const trimmed = (labelToUse ?? claimInput).trim();
    if (!trimmed || !isValidLabel(trimmed)) return;
    resetWrite();
    setSuggestion(null);
    writeContract({
      address: playerSubnameRegistrar,
      abi: SELF_MINT_ABI,
      functionName: "selfMintSubname",
      args: [trimmed],
    });
  };

  const validationError = claimInput ? labelValidationMessage(claimInput) : null;
  const canSubmit = !claiming && isValidLabel(claimInput);

  return (
    <div data-testid="profile-badge" className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <input
          data-testid="ens-claim-input"
          value={claimInput}
          onChange={(e) => {
            // Auto-lowercase so users don't need to think about casing.
            setClaimInput(e.target.value.toLowerCase());
            resetWrite();
            setSuggestion(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="your-name"
          className="h-8 w-32 rounded-md border border-zinc-300 bg-white px-2 font-mono text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          disabled={claiming}
          autoFocus
        />
        <span
          data-testid="ens-suffix"
          className="font-mono text-xs text-zinc-500 dark:text-zinc-400"
        >
          .backgammon.eth
        </span>
        <button
          data-testid="ens-claim-button"
          type="button"
          onClick={() => submit()}
          disabled={!canSubmit}
          className="h-8 rounded-md bg-indigo-600 px-3 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {signing ? "Signing…" : confirming ? "Confirming…" : "Claim"}
        </button>
      </div>

      {validationError ? (
        <span
          data-testid="ens-validation-error"
          className="max-w-xs text-right text-xs text-amber-600 dark:text-amber-400"
        >
          {validationError}
        </span>
      ) : null}

      {claimError ? (
        <div className="flex flex-col items-end gap-0.5">
          <span className="max-w-xs text-right text-xs text-red-600 dark:text-red-400">
            {claimError}
          </span>
          {suggestion ? (
            <button
              data-testid="ens-suggestion-button"
              type="button"
              onClick={() => {
                setClaimInput(suggestion);
                submit(suggestion);
              }}
              className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Try &ldquo;{suggestion}.backgammon.eth&rdquo; instead
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ProfileBadge({ address }: { address: `0x${string}` }) {
  const { label, name, isLoading: nameLoading } = useChaingammonName(address);
  const { elo } = useChaingammonProfile(label);

  if (nameLoading) {
    return (
      <span
        data-testid="profile-badge"
        className="font-mono text-sm text-zinc-500 dark:text-zinc-400"
      >
        {shorten(address)}
      </span>
    );
  }

  if (label) {
    return (
      <span
        data-testid="profile-badge"
        className="font-mono text-sm text-zinc-700 dark:text-zinc-300"
      >
        {name}
        {elo ? (
          <span className="ml-1 text-zinc-500 dark:text-zinc-400">({elo})</span>
        ) : null}
      </span>
    );
  }

  // No subname — show the claim form immediately; no extra button click needed.
  return <ClaimForm address={address} />;
}
