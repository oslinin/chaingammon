// Phase F: round-robin training page.
//
// Layout (top to bottom):
//   1. Title + subtitle
//   2. Compute-backends summary (read from ComputeBackendsContext;
//      the global pill in layout.tsx is the source of truth)
//   3. Agent selector (checkbox list of all on-chain agents)
//   4. Logarithmic epoch slider with snap-tick marks
//   5. Gas estimate row (visible when Inference=0G)
//   6. Play / Abort buttons
//   7. Status panel: progress bar + per-agent stats + last-update ts
//
// State machine:
//   idle      → click Play → POST /training/start → polling=true
//   running   → poll /training/status every 2s → on running:false → polling=false
//   ended     → status panel shows ended state until the user clicks Play again
//   abort     → POST /training/abort → polling=false
//
// All backend calls hit NEXT_PUBLIC_COACH_URL (FastAPI), same env the
// match page already uses.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useComputeBackends } from "../ComputeBackendsContext";

const SERVER = process.env.NEXT_PUBLIC_COACH_URL ?? "http://localhost:8002";

// Logarithmic slider helpers. Slider position p ∈ [0, 100] maps to
// epochs ∈ [1, MAX] via 10**(p/100 * log10(MAX)). Round to a snap
// point so the displayed value isn't a noisy decimal — closest of
// 1,10,100,1k,10k,100k (+1M, 10M when 0G inference is enabled).
const SNAP_LOCAL = [1, 10, 100, 1_000, 10_000, 100_000];
const SNAP_0G = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000];

function maxEpochs(use0g: boolean): number {
  return use0g ? 10_000_000 : 100_000;
}

function snapPoints(use0g: boolean): number[] {
  return use0g ? SNAP_0G : SNAP_LOCAL;
}

function positionToEpochs(p: number, use0g: boolean): number {
  // Position is 0..100. Map to log scale.
  const max = maxEpochs(use0g);
  const exact = Math.pow(10, (p / 100) * Math.log10(max));
  // Snap to the nearest power of 10 for readability.
  const snaps = snapPoints(use0g);
  let nearest = snaps[0];
  let bestDist = Infinity;
  for (const s of snaps) {
    const d = Math.abs(Math.log10(exact) - Math.log10(s));
    if (d < bestDist) {
      bestDist = d;
      nearest = s;
    }
  }
  return nearest;
}

function epochsToPosition(epochs: number, use0g: boolean): number {
  const max = maxEpochs(use0g);
  const clamped = Math.max(1, Math.min(max, epochs));
  return (Math.log10(clamped) / Math.log10(max)) * 100;
}

interface AgentRow {
  agent_id: number;
  weights_hash: string;
  match_count: number;
  tier: number;
}

interface EstimateResponse {
  games: number;
  total_inferences: number;
  gas_og: number;
  per_inference_og: number;
  available: boolean;
  note?: string;
}

interface StatusResponse {
  running: boolean;
  completed_games: number;
  total_games: number;
  current_epoch: number;
  total_epochs: number;
  agent_ids: number[];
  per_agent: Record<string, { games: number; wins: number; losses: number }>;
  use_0g_inference: boolean;
  use_0g_coaching: boolean;
  ended: "done" | "aborted" | null;
  last_update_ts: number;
  // Phase L.2: TensorBoard sidecar metadata. Frontend uses this to
  // mount the live-training iframe; null when launch failed (e.g.
  // tensorboard binary not on PATH on the operator's host).
  tensorboard_url?: string | null;
  logdir?: string | null;
}

export default function TrainingPage() {
  const { backends, hydrated } = useComputeBackends();
  const use0gInference = hydrated && backends.inference === "0g";
  const use0gCoaching = hydrated && backends.coach === "0g";

  // Agent list: all checked by default after first load.
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: async (): Promise<AgentRow[]> => {
      const r = await fetch(`${SERVER}/agents`);
      if (!r.ok) throw new Error(`/agents → ${r.status}`);
      return r.json();
    },
  });

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  // First time we load, pre-select all.
  useEffect(() => {
    if (agentsQuery.data && selectedIds.length === 0) {
      setSelectedIds(agentsQuery.data.map((a) => a.agent_id));
    }
  }, [agentsQuery.data, selectedIds.length]);

  // Slider position + derived epochs.
  const [sliderPos, setSliderPos] = useState(20); // ~10 epochs default
  const epochs = useMemo(
    () => positionToEpochs(sliderPos, use0gInference),
    [sliderPos, use0gInference]
  );

  // Games per epoch (UI affordance — also computed server-side).
  const n = selectedIds.length;
  const gamesPerEpoch = (n * (n - 1)) / 2;

  // Gas estimate — debounced via React Query staleTime.
  const estimateQuery = useQuery({
    enabled: selectedIds.length >= 2,
    queryKey: ["estimate", epochs, selectedIds.join(","), use0gInference],
    staleTime: 1500,
    queryFn: async (): Promise<EstimateResponse> => {
      const url = new URL(`${SERVER}/training/estimate`);
      url.searchParams.set("epochs", String(epochs));
      url.searchParams.set("agent_ids", selectedIds.join(","));
      url.searchParams.set("use_0g_inference", String(use0gInference));
      const r = await fetch(url.toString());
      if (!r.ok) throw new Error(`/training/estimate → ${r.status}`);
      return r.json();
    },
  });

  // Training status poll. Polling enables on Play, disables on running:false.
  const [polling, setPolling] = useState(false);
  const statusQuery = useQuery({
    queryKey: ["training-status"],
    refetchInterval: polling ? 2000 : false,
    queryFn: async (): Promise<StatusResponse> => {
      const r = await fetch(`${SERVER}/training/status`);
      if (!r.ok) throw new Error(`/training/status → ${r.status}`);
      return r.json();
    },
  });
  // When the trainer announces it's done, stop polling.
  useEffect(() => {
    if (polling && statusQuery.data && statusQuery.data.running === false) {
      setPolling(false);
    }
  }, [polling, statusQuery.data]);

  const queryClient = useQueryClient();

  const startMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${SERVER}/training/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epochs,
          agent_ids: selectedIds,
          use_0g_inference: use0gInference,
          use_0g_coaching: use0gCoaching,
        }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`/training/start → ${r.status}: ${text}`);
      }
      return r.json();
    },
    onSuccess: () => {
      setPolling(true);
      queryClient.invalidateQueries({ queryKey: ["training-status"] });
    },
  });

  const abortMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${SERVER}/training/abort`, { method: "POST" });
      if (!r.ok) throw new Error(`/training/abort → ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      setPolling(false);
      queryClient.invalidateQueries({ queryKey: ["training-status"] });
    },
  });

  const isRunning = statusQuery.data?.running ?? false;
  const canPlay =
    selectedIds.length >= 2 &&
    !isRunning &&
    !startMutation.isPending &&
    !estimateQuery.isFetching;
  const canAbort = isRunning && !abortMutation.isPending;

  return (
    <main className="flex flex-1 flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          Round-robin training
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Multi-agent self-play with TD-λ updates. Each epoch plays{" "}
          <code className="font-mono">C(N, 2)</code> games across the selected
          agents. Backends (Local vs 0G) are set in the Compute pill above —
          flip Inference to 0G to surface a gas estimate.
        </p>
      </header>

      <BackendsSummary
        coach={backends.coach}
        inference={backends.inference}
      />

      <AgentSelector
        agents={agentsQuery.data}
        loading={agentsQuery.isLoading}
        error={agentsQuery.error}
        selectedIds={selectedIds}
        onChange={setSelectedIds}
        gamesPerEpoch={gamesPerEpoch}
      />

      <EpochSlider
        sliderPos={sliderPos}
        epochs={epochs}
        use0g={use0gInference}
        onSliderChange={setSliderPos}
        onEpochInputChange={(e) =>
          setSliderPos(epochsToPosition(e, use0gInference))
        }
      />

      {use0gInference && (
        <GasEstimate
          estimate={estimateQuery.data}
          isFetching={estimateQuery.isFetching}
          error={estimateQuery.error}
        />
      )}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={!canPlay}
          onClick={() => startMutation.mutate()}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {startMutation.isPending ? "Starting…" : "Play"}
        </button>
        <button
          type="button"
          disabled={!canAbort}
          onClick={() => abortMutation.mutate()}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-800"
        >
          {abortMutation.isPending ? "Aborting…" : "Abort"}
        </button>
        {startMutation.error && (
          <span className="self-center text-xs text-red-600">
            {(startMutation.error as Error).message}
          </span>
        )}
      </div>

      <StatusPanel status={statusQuery.data} />

      <TensorBoardPanel status={statusQuery.data} agentIds={selectedIds} />
    </main>
  );
}

// ─── sub-components ────────────────────────────────────────────────────────

function BackendsSummary({
  coach,
  inference,
}: {
  coach: string;
  inference: string;
}) {
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      <Chip label="Coach" value={coach} />
      <Chip label="Inference" value={inference} />
      <Chip label="Training" value="local (control loop)" disabled />
    </div>
  );
}

function Chip({
  label,
  value,
  disabled,
}: {
  label: string;
  value: string;
  disabled?: boolean;
}) {
  return (
    <span
      className={[
        "rounded-md border px-2 py-1 font-mono",
        disabled
          ? "border-zinc-200 text-zinc-400 dark:border-zinc-800 dark:text-zinc-600"
          : value === "0g"
          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : "border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300",
      ].join(" ")}
    >
      {label}: {value === "0g" ? "0G" : value}
    </span>
  );
}

function AgentSelector({
  agents,
  loading,
  error,
  selectedIds,
  onChange,
  gamesPerEpoch,
}: {
  agents: AgentRow[] | undefined;
  loading: boolean;
  error: unknown;
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  gamesPerEpoch: number;
}) {
  if (loading)
    return <p className="text-sm text-zinc-500">Loading agents…</p>;
  if (error)
    return (
      <p className="text-sm text-red-600">
        Could not load agents: {(error as Error).message}
      </p>
    );
  if (!agents || agents.length === 0)
    return <p className="text-sm text-zinc-500">No agents on chain.</p>;

  const toggle = (id: number) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id].sort((a, b) => a - b));
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Agents — {selectedIds.length} selected, {gamesPerEpoch} games per epoch
      </h2>
      <div className="flex flex-wrap gap-2">
        {agents.map((a) => {
          const active = selectedIds.includes(a.agent_id);
          return (
            <button
              key={a.agent_id}
              type="button"
              onClick={() => toggle(a.agent_id)}
              className={[
                "rounded-md border px-3 py-1.5 text-xs",
                active
                  ? "border-emerald-600 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
                  : "border-zinc-300 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
              ].join(" ")}
            >
              <span className="font-mono">#{a.agent_id}</span>
              <span className="ml-1 text-zinc-500">({a.match_count})</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function EpochSlider({
  sliderPos,
  epochs,
  use0g,
  onSliderChange,
  onEpochInputChange,
}: {
  sliderPos: number;
  epochs: number;
  use0g: boolean;
  onSliderChange: (p: number) => void;
  onEpochInputChange: (e: number) => void;
}) {
  const snaps = snapPoints(use0g);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Epochs
      </h2>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={sliderPos}
          onChange={(e) => onSliderChange(Number(e.target.value))}
          className="flex-1"
          aria-label="Epoch slider (logarithmic)"
        />
        <input
          type="number"
          min={1}
          max={maxEpochs(use0g)}
          value={epochs}
          onChange={(e) => onEpochInputChange(Number(e.target.value))}
          className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-right font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      <div className="flex justify-between font-mono text-xs text-zinc-400">
        {snaps.map((s) => (
          <span key={s}>{formatBig(s)}</span>
        ))}
      </div>
    </section>
  );
}

function GasEstimate({
  estimate,
  isFetching,
  error,
}: {
  estimate: EstimateResponse | undefined;
  isFetching: boolean;
  error: unknown;
}) {
  if (error)
    return (
      <p className="text-sm text-red-600">
        Estimate failed: {(error as Error).message}
      </p>
    );
  if (!estimate) return <p className="text-sm text-zinc-500">Estimating…</p>;

  return (
    <section
      className={[
        "rounded-md border p-3",
        estimate.available
          ? "border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/30"
          : "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30",
      ].join(" ")}
    >
      <div className="grid grid-cols-3 gap-3 font-mono text-xs">
        <Stat label="Games" value={estimate.games.toLocaleString()} />
        <Stat
          label="Inferences"
          value={estimate.total_inferences.toLocaleString()}
        />
        <Stat
          label="Gas"
          value={`~${estimate.gas_og.toFixed(6)} OG`}
          accent={estimate.available}
        />
      </div>
      {!estimate.available && estimate.note && (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
          {estimate.note}
        </p>
      )}
      {isFetching && (
        <p className="mt-1 text-[10px] text-zinc-500">refreshing…</p>
      )}
    </section>
  );
}

function StatusPanel({ status }: { status: StatusResponse | undefined }) {
  if (!status) return null;
  const pct =
    status.total_games > 0
      ? Math.round((status.completed_games / status.total_games) * 100)
      : 0;
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Status
        </h2>
        <StatusBadge status={status} />
      </div>

      <div className="mb-3 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full bg-emerald-600 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mb-3 text-xs text-zinc-500">
        {status.completed_games} / {status.total_games} games · epoch{" "}
        {status.current_epoch} / {status.total_epochs}
      </p>

      {Object.keys(status.per_agent).length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th className="py-1 text-left font-mono uppercase text-zinc-500">
                Agent
              </th>
              <th className="text-right font-mono uppercase text-zinc-500">
                Games
              </th>
              <th className="text-right font-mono uppercase text-zinc-500">
                Wins
              </th>
              <th className="text-right font-mono uppercase text-zinc-500">
                Win rate
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(status.per_agent).map(([aid, s]) => {
              const wr = s.games > 0 ? (s.wins / s.games) * 100 : 0;
              return (
                <tr
                  key={aid}
                  className="border-b border-zinc-100 dark:border-zinc-800"
                >
                  <td className="py-1 font-mono">#{aid}</td>
                  <td className="text-right font-mono">{s.games}</td>
                  <td className="text-right font-mono">{s.wins}</td>
                  <td className="text-right font-mono">{wr.toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: StatusResponse }) {
  if (status.running) {
    return (
      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-mono text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        running{status.use_0g_inference ? " · 0G inference" : ""}
      </span>
    );
  }
  if (status.ended === "done") {
    return (
      <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-mono text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        done
      </span>
    );
  }
  if (status.ended === "aborted") {
    return (
      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-mono text-amber-800 dark:bg-amber-950 dark:text-amber-300">
        aborted
      </span>
    );
  }
  return (
    <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-mono text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      idle
    </span>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span
        className={
          accent
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-zinc-900 dark:text-zinc-100"
        }
      >
        {value}
      </span>
    </div>
  );
}

function formatBig(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}k`;
  return String(n);
}

// Phase L.3: TensorBoard panel — embeds the live tb dashboard so a
// judge can watch the network learn (TD error, weight L2 per agent,
// rolling win-rate per agent) while the trainer runs.
//
// Per-agent picker uses TensorBoard 2.x's #scalars URL params:
//   #scalars&tagFilter=agent_<id>&_smoothingWeight=0
// which restricts the visible scalar tags to those mentioning the
// selected agent (Phase L.1 logs them under win_rate/agent_<id>,
// weights/core_l2_agent_<id>, weights/extras_l2_agent_<id>, plus the
// pair-level win/agent_a_vs_b — those show under either agent's filter).
//
// When tensorboard_url is null (sidecar didn't launch — binary
// missing on PATH, port in use, etc.) the panel renders a clear
// placeholder rather than an iframe pointing nowhere.
function TensorBoardPanel({
  status,
  agentIds,
}: {
  status: StatusResponse | undefined;
  agentIds: number[];
}) {
  const [pickedAgent, setPickedAgent] = useState<number | "all">("all");

  if (!status) return null;

  const url = status.tensorboard_url;
  if (!url) {
    return (
      <section className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
        <strong>TensorBoard unavailable.</strong> The training service
        couldn&apos;t spawn the <code>tensorboard</code> sidecar — likely the
        binary isn&apos;t on PATH in the agent venv. Run{" "}
        <code>uv pip install tensorboard</code> in <code>agent/</code> to
        enable live charts here.
      </section>
    );
  }

  const tagFilter =
    pickedAgent === "all" ? "" : `agent_${pickedAgent}`;
  const iframeSrc = tagFilter
    ? `${url}/#scalars&tagFilter=${encodeURIComponent(tagFilter)}`
    : `${url}/#scalars`;

  // Pool the available agents from both the status report (canonical
  // set the trainer started with) and the page's selection (so the
  // picker is responsive even before status arrives).
  const allAgents = Array.from(
    new Set([...(status.agent_ids ?? []), ...agentIds]),
  ).sort((a, b) => a - b);

  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          TensorBoard
        </h2>
        <div className="flex items-center gap-2">
          <label
            htmlFor="tb-agent-picker"
            className="text-xs text-zinc-600 dark:text-zinc-400"
          >
            Filter:
          </label>
          <select
            id="tb-agent-picker"
            value={String(pickedAgent)}
            onChange={(e) => {
              const v = e.target.value;
              setPickedAgent(v === "all" ? "all" : Number(v));
            }}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-mono dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="all">all agents</option>
            {allAgents.map((a) => (
              <option key={a} value={a}>
                agent {a}
              </option>
            ))}
          </select>
          <a
            href={iframeSrc}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            title="Open TensorBoard in a new tab"
          >
            ↗
          </a>
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        Live scalars from the trainer:{" "}
        <code className="font-mono">train/td_error</code>,{" "}
        <code className="font-mono">match/plies</code>,{" "}
        <code className="font-mono">win_rate/agent_*</code>,{" "}
        <code className="font-mono">weights/core_l2_agent_*</code>.
        {pickedAgent !== "all" && (
          <> Filtered to agent {pickedAgent}.</>
        )}
      </p>

      <iframe
        key={iframeSrc /* re-mount when filter changes */}
        src={iframeSrc}
        title="TensorBoard"
        className="h-[600px] w-full rounded border border-zinc-200 dark:border-zinc-800"
      />

      {status.logdir && (
        <p className="font-mono text-[10px] text-zinc-400">
          logdir: {status.logdir}
        </p>
      )}
    </section>
  );
}
