// Side A / Side B picker + match config + adaptive Start.
//
// Multi-select per side: a single subname per side is the common case;
// adding more makes the side a team (ensemble for agents, "human +
// teammate-coach" when one is human — see plan's cooperation note).
//
// Adaptive Start:
//   * All selected subnames have agent_id → "Auto-play match" → /play/auto
//   * At least one selected subname is a human (no agent_id) → "Open
//     match" → /match
//   * Either side empty → button disabled
//
// Mode (single | career) records into localStorage as currentMatchMode
// so a future on-chain `mode: uint8` field has a place to read from.
// Length defaults to 5; valid odd values 1/3/5/7/.../25 align with
// MatchEscrow.MAX_MATCH_LENGTH (Commit 6).
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { encodePacked, keccak256, toBytes } from "viem";
import { useReadContract, useReadContracts } from "wagmi";

import { useActiveChainId } from "../../chains";
import {
  PlayerSubnameRegistrarABI,
  useChainContracts,
} from "../../contracts";
import { useAllChaingammonSubnames, type SubnameEntry } from "../../useAllChaingammonSubnames";

interface RosterRow extends SubnameEntry {
  elo: number;
  agentId: string | undefined;
  kind: string;
}

const MATCH_LENGTHS = [1, 3, 5, 7];

function tierLabel(agentTier?: number): string | null {
  if (agentTier === undefined) return null;
  return ["Beginner", "Intermediate", "Advanced", "World-Class"][agentTier] ?? null;
}

export function PlayNewPicker() {
  const router = useRouter();
  const chainId = useActiveChainId();
  const { playerSubnameRegistrar } = useChainContracts();
  const { entries, isLoading: rosterLoading } = useAllChaingammonSubnames();

  const [sideA, setSideA] = useState<Set<`0x${string}`>>(new Set());
  const [sideB, setSideB] = useState<Set<`0x${string}`>>(new Set());
  const [matchLength, setMatchLength] = useState<number>(5);
  const [mode, setMode] = useState<"single" | "career">("single");

  // Read all profile fields in batch — eloOf, agent_id text, kind text.
  const profileReads = useMemo(() => {
    if (!playerSubnameRegistrar) return [];
    return entries.flatMap((e) => [
      {
        address: playerSubnameRegistrar,
        abi: PlayerSubnameRegistrarABI as unknown as readonly unknown[],
        functionName: "eloOf",
        args: [e.node],
        chainId,
      },
      {
        address: playerSubnameRegistrar,
        abi: PlayerSubnameRegistrarABI as unknown as readonly unknown[],
        functionName: "text",
        args: [e.node, "agent_id"],
        chainId,
      },
      {
        address: playerSubnameRegistrar,
        abi: PlayerSubnameRegistrarABI as unknown as readonly unknown[],
        functionName: "text",
        args: [e.node, "kind"],
        chainId,
      },
    ]);
  }, [entries, playerSubnameRegistrar, chainId]);

  const { data: profileResults, isLoading: profileLoading } = useReadContracts({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: profileReads as any,
    query: { enabled: profileReads.length > 0 },
  });

  const rows: RosterRow[] = useMemo(() => {
    if (!profileResults) {
      return entries.map((e) => ({ ...e, elo: 1500, agentId: undefined, kind: "" }));
    }
    return entries.map((e, i) => {
      const eloRaw = profileResults[i * 3]?.result;
      const agentIdRaw = profileResults[i * 3 + 1]?.result;
      const kindRaw = profileResults[i * 3 + 2]?.result;
      return {
        ...e,
        elo: typeof eloRaw === "bigint" ? Number(eloRaw) : 1500,
        agentId: typeof agentIdRaw === "string" && agentIdRaw !== "" ? agentIdRaw : undefined,
        kind: typeof kindRaw === "string" ? kindRaw : "",
      };
    });
  }, [entries, profileResults]);

  // Persist mode for downstream routes (Commit 5 reads it for /play/auto).
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("currentMatchMode", mode);
    }
  }, [mode]);

  const toggle = (
    side: Set<`0x${string}`>,
    setSide: (s: Set<`0x${string}`>) => void,
    node: `0x${string}`,
  ) => {
    const next = new Set(side);
    if (next.has(node)) next.delete(node);
    else next.add(node);
    setSide(next);
  };

  const selectedA = rows.filter((r) => sideA.has(r.node));
  const selectedB = rows.filter((r) => sideB.has(r.node));

  // Auto-play requires every selected subname to be an agent.
  const allAgents =
    selectedA.length > 0 &&
    selectedB.length > 0 &&
    selectedA.every((r) => r.agentId) &&
    selectedB.every((r) => r.agentId);

  const eitherSideEmpty = selectedA.length === 0 || selectedB.length === 0;

  let buttonLabel: string;
  let buttonDisabled = false;
  if (eitherSideEmpty) {
    buttonLabel = "Pick a player on each side";
    buttonDisabled = true;
  } else if (allAgents) {
    buttonLabel = "Auto-play match";
  } else {
    buttonLabel = "Open match";
  }

  const start = () => {
    if (eitherSideEmpty) return;
    const labelsA = selectedA.map((r) => r.label).join(",");
    const labelsB = selectedB.map((r) => r.label).join(",");
    if (allAgents) {
      router.push(
        `/play/auto?subnameA=${encodeURIComponent(labelsA)}&subnameB=${encodeURIComponent(
          labelsB,
        )}&matchLength=${matchLength}&mode=${mode}`,
      );
    } else {
      // Open match: pass through to existing /match flow. Use the first
      // selected agent on the opposing side as the legacy `agentId` when
      // available so the existing route still works.
      const opposingAgent =
        selectedA.find((r) => r.agentId)?.agentId ??
        selectedB.find((r) => r.agentId)?.agentId;
      const params = new URLSearchParams({
        subnameA: labelsA,
        subnameB: labelsB,
        matchLength: String(matchLength),
        mode,
      });
      if (opposingAgent) params.set("agentId", opposingAgent);
      router.push(`/match?${params.toString()}`);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SidePicker
          title="Side A"
          rows={rows}
          selected={sideA}
          onToggle={(node) => toggle(sideA, setSideA, node)}
          loading={rosterLoading || profileLoading}
        />
        <SidePicker
          title="Side B"
          rows={rows}
          selected={sideB}
          onToggle={(node) => toggle(sideB, setSideB, node)}
          loading={rosterLoading || profileLoading}
        />
      </div>

      <div
        data-testid="match-config"
        className="flex flex-col gap-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Match length:</span>
          {MATCH_LENGTHS.map((n) => (
            <button
              key={n}
              type="button"
              data-testid={`length-${n}`}
              onClick={() => setMatchLength(n)}
              className={
                matchLength === n
                  ? "rounded bg-indigo-600 px-3 py-1 text-sm font-semibold text-white"
                  : "rounded border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              }
            >
              {n}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Mode:</span>
          {(["single", "career"] as const).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`mode-${m}`}
              onClick={() => setMode(m)}
              className={
                mode === m
                  ? "rounded bg-indigo-600 px-3 py-1 text-sm font-semibold text-white"
                  : "rounded border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              }
            >
              {m === "single" ? "Single game" : "Career"}
            </button>
          ))}
        </div>
        {mode === "career" ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Career mode (zero context features in v1 — same play as single-game).
          </p>
        ) : null}
      </div>

      <button
        type="button"
        data-testid="start-button"
        onClick={start}
        disabled={buttonDisabled}
        className="self-start rounded-md bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {buttonLabel}
      </button>
    </div>
  );
}

function SidePicker({
  title,
  rows,
  selected,
  onToggle,
  loading,
}: {
  title: string;
  rows: RosterRow[];
  selected: Set<`0x${string}`>;
  onToggle: (node: `0x${string}`) => void;
  loading: boolean;
}) {
  return (
    <section
      data-testid={`side-${title.toLowerCase().replace(" ", "-")}`}
      className="flex flex-col gap-2 rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      {loading ? (
        <p className="text-xs text-zinc-500">Loading roster…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No subnames minted on this chain yet. Mint an agent or claim a name first.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.node}>
              <label className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <input
                  type="checkbox"
                  data-testid={`pick-${title.toLowerCase()}-${r.label}`}
                  checked={selected.has(r.node)}
                  onChange={() => onToggle(r.node)}
                />
                <span className="font-mono">
                  {r.label}.backgammon.eth · ELO {r.elo}
                  {r.agentId ? (
                    <span className="ml-2 text-zinc-500">agent #{r.agentId}</span>
                  ) : (
                    <span className="ml-2 text-zinc-500">human</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
