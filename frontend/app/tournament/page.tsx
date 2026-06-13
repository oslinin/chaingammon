"use client";

// Tournament page — runs a challenge-style agent tournament on 0G Compute,
// funded by the deployer key, with real MatchEscrow stakes and live ELO
// updates pushed to ENS after every match.
//
// Layout:
//   1. Header + description
//   2. Agent pool picker (checkbox list from AgentRegistry)
//   3. Rounds slider (1 – 100)
//   4. Start / Abort buttons
//   5. Status panel

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { useActiveChain, useActiveChainId } from "../chains";
import { AgentRegistryABI, useChainContracts } from "../contracts";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

interface AgentRow {
  agent_id: number;
  label: string;
  match_count: number;
  tier: number;
}

interface TournamentStatusResponse {
  running: boolean;
  current_epoch: number;
  total_epochs: number;
  completed_games: number;
  total_games: number;
  per_agent: Record<string, { games: number; wins: number; losses: number }>;
  ended: "done" | "aborted" | null;
}

export default function TournamentPage() {
  const chainId = useActiveChainId();
  const activeChain = useActiveChain();
  const { agentRegistry } = useChainContracts();

  // ── Agent list from chain ─────────────────────────────────────────────────

  const { data: activeAgentCountRaw, isLoading: countLoading } = useReadContract({
    address: agentRegistry,
    abi: AgentRegistryABI,
    functionName: "activeAgentCount",
    chainId,
    query: { enabled: !!activeChain },
  });
  const agentCount =
    activeAgentCountRaw !== undefined ? Number(activeAgentCountRaw) : 0;

  const agentIndexCalls = Array.from({ length: agentCount }, (_, i) => ({
    address: agentRegistry,
    abi: AgentRegistryABI,
    functionName: "activeAgentAt" as const,
    args: [BigInt(i)] as [bigint],
    chainId,
  }));
  const { data: agentIndexResults } = useReadContracts({
    contracts: agentIndexCalls,
    query: { enabled: !!activeChain && agentCount > 0 },
  });
  const onChainAgentIds = (agentIndexResults ?? [])
    .map((r) => r?.result as bigint | undefined)
    .filter((v): v is bigint => v !== undefined)
    .map((v) => Number(v));

  const agentDetailCalls = onChainAgentIds.flatMap((id) => {
    const args = [BigInt(id)] as [bigint];
    return [
      { address: agentRegistry, abi: AgentRegistryABI, functionName: "matchCount" as const, args, chainId },
      { address: agentRegistry, abi: AgentRegistryABI, functionName: "tier" as const, args, chainId },
      { address: agentRegistry, abi: AgentRegistryABI, functionName: "agentMetadata" as const, args, chainId },
    ];
  });
  const { data: agentDetailResults, isLoading: detailsLoading } = useReadContracts({
    contracts: agentDetailCalls,
    query: { enabled: onChainAgentIds.length > 0 },
  });

  const agents: AgentRow[] = onChainAgentIds.map((agent_id, i) => {
    const base = i * 3;
    const matchCountRaw = agentDetailResults?.[base]?.result as number | bigint | undefined;
    const tierRaw = agentDetailResults?.[base + 1]?.result as number | undefined;
    const metaRaw = (agentDetailResults?.[base + 2]?.result as string | undefined) ?? "";
    let label = metaRaw;
    if (metaRaw.startsWith("{")) {
      try { label = JSON.parse(metaRaw).label ?? metaRaw; } catch { /* plain string */ }
    }
    return {
      agent_id,
      label: label || `Agent #${agent_id}`,
      match_count: typeof matchCountRaw === "bigint" ? Number(matchCountRaw) : matchCountRaw ?? 0,
      tier: tierRaw ?? 0,
    };
  });

  const agentsLoading = countLoading || (agentCount > 0 && detailsLoading);

  // ── Pool selection ────────────────────────────────────────────────────────

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  useEffect(() => {
    if (!agentsLoading && agents.length >= 2 && selectedIds.length === 0) {
      setSelectedIds(agents.map((a) => a.agent_id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsLoading, agents.length]);

  const toggleAgent = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // ── Rounds slider ─────────────────────────────────────────────────────────

  const [rounds, setRounds] = useState(10);

  // ── API mutations ─────────────────────────────────────────────────────────

  const queryClient = useQueryClient();
  const [polling, setPolling] = useState(false);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const startMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${SERVER}/training/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epochs: rounds,
          agent_ids: selectedIds,
          trainer_mode: "tournament",
          use_0g_inference: true,
          upload_to_0g: true,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(err.detail ?? r.statusText);
      }
      return r.json();
    },
    onSuccess: () => {
      setPhase("running");
      setPolling(true);
      queryClient.invalidateQueries({ queryKey: ["tournament-status"] });
    },
    onError: (e: Error) => {
      setPhase("error");
      setErrorMsg(e.message);
    },
  });

  const abortMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${SERVER}/training/abort`, { method: "POST" });
      if (!r.ok) throw new Error(`abort → ${r.status}`);
    },
    onSuccess: () => {
      setPolling(false);
      setPhase("idle");
      queryClient.invalidateQueries({ queryKey: ["tournament-status"] });
    },
  });

  const { data: status } = useQuery<TournamentStatusResponse>({
    queryKey: ["tournament-status"],
    enabled: polling,
    refetchInterval: polling ? 2000 : false,
    queryFn: async () => {
      const r = await fetch(`${SERVER}/training/status`);
      if (!r.ok) throw new Error(`status → ${r.status}`);
      return r.json();
    },
  });

  useEffect(() => {
    if (!status) return;
    if (status.ended === "done") {
      setPhase("done");
      setPolling(false);
    } else if (status.ended === "aborted") {
      setPhase("idle");
      setPolling(false);
    }
  }, [status?.ended]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const canStart = selectedIds.length >= 2 && phase === "idle";
  const progress =
    status && status.total_games > 0
      ? Math.round((status.completed_games / status.total_games) * 100)
      : 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="max-w-2xl mx-auto px-4 py-10 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-1">Tournament</h1>
        <p className="text-sm text-gray-500">
          Challenge-style agent tournament on 0G Compute — real MatchEscrow stakes, live ELO
          updates to ENS after every match, funded by the deployer contract.
        </p>
      </div>

      {/* Agent pool picker */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          Agent pool
        </h2>
        {agentsLoading ? (
          <p className="text-sm text-gray-500">Loading agents…</p>
        ) : agents.length === 0 ? (
          <p className="text-sm text-gray-500">No registered agents on this chain.</p>
        ) : (
          <div className="space-y-1">
            {agents.map((a) => (
              <label
                key={a.agent_id}
                className="flex items-center gap-3 py-2 px-3 rounded-lg cursor-pointer hover:bg-white/5 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(a.agent_id)}
                  onChange={() => toggleAgent(a.agent_id)}
                  disabled={phase === "running"}
                  className="w-4 h-4 accent-amber-400"
                />
                <span className="flex-1 text-sm font-medium">{a.label}</span>
                <span className="text-xs text-gray-500">
                  tier {a.tier} · {a.match_count} matches
                </span>
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-500">{selectedIds.length} / {agents.length} selected · minimum 2</p>
      </section>

      {/* Rounds slider */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          Rounds — <span className="text-white font-mono">{rounds}</span>
        </h2>
        <input
          type="range"
          min={1}
          max={100}
          value={rounds}
          onChange={(e) => setRounds(Number(e.target.value))}
          disabled={phase === "running"}
          className="w-full accent-amber-400"
        />
        <div className="flex justify-between text-xs text-gray-500">
          <span>1</span>
          <span>50</span>
          <span>100</span>
        </div>
      </section>

      {/* Action buttons */}
      <div className="flex gap-3">
        <button
          onClick={() => startMutation.mutate()}
          disabled={!canStart || startMutation.isPending}
          className="px-5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold text-sm transition-colors"
        >
          {startMutation.isPending ? "Starting…" : "Start Tournament"}
        </button>
        {phase === "running" && (
          <button
            onClick={() => abortMutation.mutate()}
            disabled={abortMutation.isPending}
            className="px-5 py-2 rounded-lg border border-red-600 text-red-400 hover:bg-red-900/20 disabled:opacity-40 text-sm transition-colors"
          >
            Abort
          </button>
        )}
      </div>

      {/* Error */}
      {phase === "error" && errorMsg && (
        <div className="text-sm text-red-400 bg-red-900/20 rounded-lg px-4 py-3">
          {errorMsg}
        </div>
      )}

      {/* Status panel */}
      {(phase === "running" || phase === "done") && status && (
        <section className="space-y-4">
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-gray-400">
              <span>
                Round {status.current_epoch} / {status.total_epochs}
              </span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-amber-500 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {phase === "done" && (
            <p className="text-sm text-green-400 font-medium">
              Tournament complete — ELO updated on-chain.
            </p>
          )}

          {/* Per-agent results */}
          {Object.keys(status.per_agent).length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 text-left border-b border-white/10">
                  <th className="pb-2">Agent</th>
                  <th className="pb-2 text-right">W</th>
                  <th className="pb-2 text-right">L</th>
                  <th className="pb-2 text-right">Win %</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(status.per_agent)
                  .sort(([, a], [, b]) => b.wins - a.wins)
                  .map(([idStr, s]) => {
                    const agent = agents.find((a) => String(a.agent_id) === idStr);
                    const winPct =
                      s.games > 0 ? Math.round((s.wins / s.games) * 100) : 0;
                    return (
                      <tr key={idStr} className="border-b border-white/5">
                        <td className="py-1.5">{agent?.label ?? `Agent #${idStr}`}</td>
                        <td className="py-1.5 text-right text-green-400">{s.wins}</td>
                        <td className="py-1.5 text-right text-red-400">{s.losses}</td>
                        <td className="py-1.5 text-right">{winPct}%</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
