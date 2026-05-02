// Phase 21: ENS name selection UX improvements.
//
// ClaimForm is now shown automatically when a connected wallet has no
// chaingammon.eth subname — no extra "Claim name" button click required.
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

import { useEffect, useRef, useState } from "react";
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";

import { useChaingammonName } from "./useChaingammonName";
import { useChaingammonProfile } from "./useChaingammonProfile";
import { useActiveChainId } from "./chains";
import { MatchRegistryABI, useChainContracts } from "./contracts";
import { recordExpense } from "./expenses";

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
  // Track the label actually submitted so the expense description is accurate
  // even when the suggestion button changes `claimInput` before confirming.
  const submittedLabelRef = useRef<string>("");

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

  // Record the gas expense and reload after the tx confirms so every component
  // re-runs its subname lookup with the newly registered name.
  useEffect(() => {
    if (isSuccess) {
      recordExpense({
        type: "ens_subname",
        description: `ENS subname registered: ${submittedLabelRef.current}.chaingammon.eth`,
      });
      window.location.reload();
    }
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
    submittedLabelRef.current = trimmed;
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
          .chaingammon.eth
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
              Try &ldquo;{suggestion}.chaingammon.eth&rdquo; instead
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ProfileBadge({ address }: { address: `0x${string}` }) {
  const { label, name, isLoading: nameLoading } = useChaingammonName(address);
  const { elo: ensElo, matchCount } = useChaingammonProfile(label);
  const [renaming, setRenaming] = useState(false);

  // Fallback: read ELO directly from MatchRegistry.humanElo when the ENS
  // text record hasn't been written yet (settlement flow omitted the label).
  const chainId = useActiveChainId();
  const { matchRegistry } = useChainContracts();
  const { data: chainEloRaw } = useReadContract({
    address: matchRegistry,
    abi: MatchRegistryABI,
    functionName: "humanElo",
    args: [address],
    chainId,
    query: { enabled: !!address && !ensElo },
  });
  const elo = ensElo ?? (chainEloRaw != null ? String(chainEloRaw) : undefined);

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

  if (label && !renaming) {
    return (
      <span
        data-testid="profile-badge"
        className="flex items-center gap-2 font-mono text-sm text-zinc-700 dark:text-zinc-300"
      >
        {name}
        {elo ? (
          <span
            title="ELO rating"
            className="rounded bg-indigo-100 px-1.5 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
          >
            ELO {elo}
          </span>
        ) : null}
        {matchCount ? (
          <span
            title="Matches played"
            className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          >
            {matchCount}M
          </span>
        ) : null}
        <button
          title="Claim a new name"
          onClick={() => setRenaming(true)}
          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
        >
          ✎
        </button>
      </span>
    );
  }

  // No subname (or rename requested) — show the claim form.
  return <ClaimForm address={address} />;
}
