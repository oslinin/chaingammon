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
import { useChaingammonProfile, useSyncEnsProfile } from "./useChaingammonProfile";
import { useActiveChainId } from "./chains";
import { MatchRegistryABI, useChainContracts } from "./contracts";
import { recordTransaction } from "./transactions";

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

function isValidLabel(s: string): boolean {
  return s.length >= 1 && s.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s);
}

function labelValidationMessage(s: string): string | null {
  if (!s) return null;
  if (s.length > 63) return "Name must be 63 characters or fewer.";
  if (!/^[a-z0-9]/.test(s)) return "Name must start with a letter or number.";
  if (s.endsWith("-")) return "Name cannot end with a hyphen.";
  if (!/^[a-z0-9-]+$/.test(s)) return "Only lowercase letters, numbers, and hyphens allowed.";
  return null;
}

function randomSuffix(): string {
  return String(Math.floor(Math.random() * 900) + 100);
}

function isSubnameAlreadyTaken(error: Error | null): boolean {
  if (!error) return false;
  const msg = error.message;
  return (
    msg.includes("SubnameAlreadyExists") ||
    msg.toLowerCase().includes("subnamealreadyexists") ||
    msg.toLowerCase().includes("already taken")
  );
}

export function ClaimForm({ address: _address }: { address: `0x${string}` }) {
  const [claimInput, setClaimInput] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const submittedLabelRef = useRef<string>("");

  const { playerSubnameRegistrar } = useChainContracts();

  const {
    writeContract,
    data: txHash,
    error: writeError,
    isPending: signing,
    reset: resetWrite,
  } = useWriteContract();

  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess) {
      recordTransaction({
        type: "ens_subname",
        description: `ENS subname registered: ${submittedLabelRef.current}.chaingammon.eth`,
      });
      window.location.reload();
    }
  }, [isSuccess]);

  useEffect(() => {
    if (writeError && isSubnameAlreadyTaken(writeError)) {
      setSuggestion(`${claimInput}${randomSuffix()}`);
    } else {
      setSuggestion(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeError]);

  const claiming = signing || confirming;

  const claimError = writeError
    ? isSubnameAlreadyTaken(writeError)
      ? `"${claimInput}" is already taken.`
      : writeError.message.split("\n")[0]
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
    <div data-testid="profile-badge" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          data-testid="ens-claim-input"
          value={claimInput}
          onChange={(e) => {
            setClaimInput(e.target.value.toLowerCase());
            resetWrite();
            setSuggestion(null);
          }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="your-name"
          disabled={claiming}
          autoFocus
          style={{
            height: 32,
            width: 128,
            borderRadius: "var(--cg-radius-sm)",
            border: "1px solid var(--cg-line-2)",
            background: "var(--cg-bg-1)",
            color: "var(--cg-fg-1)",
            fontFamily: "var(--cg-font-mono)",
            fontSize: 13,
            padding: "0 8px",
            outline: "none",
          }}
        />
        <span
          data-testid="ens-suffix"
          style={{ fontFamily: "var(--cg-font-mono)", fontSize: 12, color: "var(--cg-fg-3)" }}
        >
          .chaingammon.eth
        </span>
        <button
          data-testid="ens-claim-button"
          type="button"
          onClick={() => submit()}
          disabled={!canSubmit}
          style={{
            height: 32,
            borderRadius: "var(--cg-radius-sm)",
            background: "var(--cg-brass)",
            color: "var(--cg-brass-ink)",
            padding: "0 12px",
            fontSize: 12,
            fontWeight: 600,
            border: "none",
            cursor: canSubmit ? "pointer" : "not-allowed",
            opacity: canSubmit ? 1 : 0.5,
            fontFamily: "var(--cg-font-sans)",
          }}
        >
          {signing ? "Signing…" : confirming ? "Confirming…" : "Claim"}
        </button>
      </div>

      {validationError ? (
        <span
          data-testid="ens-validation-error"
          style={{ fontSize: 11, color: "var(--cg-warn)", textAlign: "right", maxWidth: 240 }}
        >
          {validationError}
        </span>
      ) : null}

      {claimError ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <span style={{ fontSize: 11, color: "var(--cg-danger)", textAlign: "right", maxWidth: 240 }}>
            {claimError}
          </span>
          {suggestion ? (
            <button
              data-testid="ens-suggestion-button"
              type="button"
              onClick={() => { setClaimInput(suggestion); submit(suggestion); }}
              style={{ fontSize: 11, color: "var(--cg-brass)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
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
  const { sync, syncing } = useSyncEnsProfile();
  const [syncError, setSyncError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const chainId = useActiveChainId();
  const { matchRegistry } = useChainContracts();
  const { data: chainEloRaw } = useReadContract({
    address: matchRegistry,
    abi: MatchRegistryABI,
    functionName: "humanElo",
    args: [address],
    chainId,
    query: { enabled: !!address, refetchInterval: 10000 },
  });
  const chainElo = chainEloRaw != null ? String(chainEloRaw) : undefined;
  const elo = chainElo ?? ensElo;

  if (nameLoading) {
    return (
      <span
        data-testid="profile-badge"
        style={{ fontFamily: "var(--cg-font-mono)", fontSize: 13, color: "var(--cg-fg-3)" }}
      >
        {shorten(address)}
      </span>
    );
  }

  if (label && !renaming) {
    return (
      <span
        data-testid="profile-badge"
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          justifyContent: "flex-end",
          gap: 8,
          fontFamily: "var(--cg-font-mono)",
          fontSize: 13,
        }}
      >
        <a
          href={`https://app.ens.domains/${name}`}
          target="_blank"
          rel="noreferrer"
          title={name ?? undefined}
          style={{ color: "var(--cg-fg-1)", textDecoration: "none" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = "var(--cg-brass)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = "var(--cg-fg-1)"; }}
        >
          {/* Narrow screens see just the label (e.g. "oleg") so the connected
              header fits inside a phone-width viewport without horizontal
              scroll; ≥640px (sm: breakpoint) sees the full subname. The
              tooltip exposes the full name on either size. */}
          <span className="sm:hidden">{label}</span>
          <span className="hidden sm:inline">{name}</span>
        </a>
        {elo ? (
          <span
            title="ELO rating"
            style={{
              borderRadius: "var(--cg-radius-sm)",
              background: "rgba(201,155,92,0.15)",
              border: "1px solid rgba(201,155,92,0.30)",
              padding: "1px 6px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--cg-brass-hi)",
              fontFamily: "var(--cg-font-mono)",
            }}
          >
            ELO {elo}
          </span>
        ) : null}
        {chainElo && label && chainElo !== ensElo ? (
          <button
            title={syncError ?? "Push current ELO to your ENS profile"}
            disabled={syncing}
            onClick={async () => {
              setSyncError(null);
              try { await sync(label, chainElo); }
              catch (e) { setSyncError(e instanceof Error ? e.message : String(e)); }
            }}
            style={{
              fontSize: 10,
              color: syncError ? "var(--cg-red, #e55)" : "var(--cg-fg-4)",
              background: "none",
              border: "none",
              cursor: syncing ? "wait" : "pointer",
              opacity: syncing ? 0.5 : 1,
              transition: "color 120ms",
              padding: 0,
            }}
            onMouseEnter={(e) => { if (!syncing) (e.currentTarget as HTMLButtonElement).style.color = "var(--cg-brass)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = syncError ? "var(--cg-red, #e55)" : "var(--cg-fg-4)"; }}
          >
            {syncing ? "…" : "↑ ENS"}
          </button>
        ) : null}
        {matchCount ? (
          <span
            title="Matches played"
            style={{
              borderRadius: "var(--cg-radius-sm)",
              background: "var(--cg-bg-3)",
              border: "1px solid var(--cg-line-2)",
              padding: "1px 6px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--cg-fg-3)",
            }}
          >
            {matchCount}M
          </span>
        ) : null}
        <button
          title="Claim a new name"
          onClick={() => setRenaming(true)}
          style={{ fontSize: 12, color: "var(--cg-fg-4)", background: "none", border: "none", cursor: "pointer", transition: "color 120ms" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--cg-fg-2)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--cg-fg-4)"; }}
        >
          ✎
        </button>
      </span>
    );
  }

  return <ClaimForm address={address} />;
}
