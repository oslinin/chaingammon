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
// All backend calls hit NEXT_PUBLIC_SERVER_URL (FastAPI on port 8000),
// where /agents and /training/* are served (server/app/main.py). The
// coach service on 8002 only exposes /hint and /chat.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { useComputeBackends } from "../ComputeBackendsContext";
import { useActiveChain } from "../chains";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

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

  if (exact <= 10) return Math.round(exact);

  // Round to 2 significant digits for a "nice" feel that allows selecting
  // values like 15, 250, or 1.2M rather than just powers of 10.
  const power = Math.floor(Math.log10(exact));
  const magnitude = Math.pow(10, power - 1);
  const rounded = Math.round(exact / magnitude) * magnitude;
  return Math.min(max, rounded);
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

interface CheckpointEntry {
  agent_id: number;
  path: string | null;
  root_hash: string | null;
  address: string | null;
  error: string | null;
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
  upload_to_0g: boolean;
  ended: "done" | "aborted" | null;
  last_update_ts: number;
  // Per-agent checkpoint save/upload results. Populated after training
  // completes; root_hash is the 0G Storage Merkle root when uploaded.
  checkpoints?: CheckpointEntry[];
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
  const [sliderPos, setSliderPos] = useState(0); // 1 epoch default
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

  // Training status poll. Polling enables on Play, disables once we
  // see a `running:false` status whose `last_update_ts` is >= the
  // Play click. The timestamp guard kills the race where the very
  // first refetch (kicked off by `invalidateQueries` in onSuccess)
  // returns the PRIOR run's terminal state before the trainer
  // subprocess has flipped `running:true` — without it, polling
  // would stop on stale data and the UI would freeze on "running 0/0"
  // or the prior "done" until the user manually reloaded.
  const [polling, setPolling] = useState(false);
  const playedAtRef = useRef<number | null>(null);
  const statusQuery = useQuery({
    queryKey: ["training-status"],
    refetchInterval: polling ? 1000 : false,
    queryFn: async (): Promise<StatusResponse> => {
      const r = await fetch(`${SERVER}/training/status`);
      if (!r.ok) throw new Error(`/training/status → ${r.status}`);
      return r.json();
    },
  });
  useEffect(() => {
    if (!polling || !statusQuery.data) return;
    const data = statusQuery.data;
    const playedAt = playedAtRef.current;
    if (data.running) return;
    if (playedAt !== null && data.last_update_ts < playedAt) return;
    setPolling(false);
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
          // Always upload weights to 0G so the iNFT's dataHashes[1] stays
          // current after training, regardless of whether 0G inference
          // is active.
          upload_to_0g: true,
          // Always skip encryption in the demo so the server (which
          // has no key file) can fetch the checkpoint via load_profile.
          no_encrypt: true,
        }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`/training/start → ${r.status}: ${text}`);
      }
      return r.json();
    },
    onSuccess: () => {
      // Stamp the click time (server-side seconds, matching
      // last_update_ts on /training/status). Polling won't stop
      // until a status update produced AFTER this stamp lands.
      playedAtRef.current = Date.now() / 1000;
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
        selectedIds={selectedIds}
        gamesPerEpoch={gamesPerEpoch}
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

      <CheckpointsPanel status={statusQuery.data} />
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
  selectedIds,
  gamesPerEpoch,
  onSliderChange,
  onEpochInputChange,
}: {
  sliderPos: number;
  epochs: number;
  use0g: boolean;
  selectedIds: number[];
  gamesPerEpoch: number;
  onSliderChange: (p: number) => void;
  onEpochInputChange: (e: number) => void;
}) {
  const snaps = snapPoints(use0g);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Epochs — {epochs.toLocaleString()}
        </h2>
        {selectedIds.length >= 2 && (
          <p className="text-[10px] text-zinc-400 font-mono">
            Total training games: {epochs.toLocaleString()} epochs × {gamesPerEpoch} matches/epoch = {(epochs * gamesPerEpoch).toLocaleString()} games
          </p>
        )}
      </div>
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
        {status.last_update_ts ? (
          <span className="ml-2 font-mono text-[10px] text-zinc-400">
            · updated {new Date(status.last_update_ts * 1000).toLocaleTimeString()}
          </span>
        ) : null}
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

// CheckpointsPanel — shows per-agent checkpoint save/upload results
// after the training run ends. Each entry shows the agent ID, the local
// .pt path, and the 0G Storage Merkle root (root_hash) if uploaded. An
// error field is shown instead when the upload failed (e.g. missing env
// vars) but the local save may still have succeeded.
function CheckpointsPanel({ status }: { status: StatusResponse | undefined }) {
  const active = useActiveChain();
  const explorerUrl = active?.chain.blockExplorers?.default?.url;

  const entries = status?.checkpoints;
  if (!entries || entries.length === 0) return null;

  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Checkpoints
      </h2>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th className="py-1 text-left font-mono uppercase text-zinc-500">Agent</th>
            <th className="text-left font-mono uppercase text-zinc-500">Agent wallet</th>
            <th className="text-left font-mono uppercase text-zinc-500">0G root hash</th>
            <th className="text-left font-mono uppercase text-zinc-500">Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((ck, i) => (
            <tr key={i} className="border-b border-zinc-100 dark:border-zinc-800">
              <td className="py-1 font-mono">#{ck.agent_id}</td>
              <td className="py-1 font-mono text-[10px] text-zinc-500 break-all">
                {ck.address ? (
                  explorerUrl ? (
                    <a
                      href={`${explorerUrl}/address/${ck.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
                    >
                      {ck.address.slice(0, 8)}…{ck.address.slice(-6)}
                    </a>
                  ) : (
                    <span>
                      {ck.address.slice(0, 8)}…{ck.address.slice(-6)}
                    </span>
                  )
                ) : (
                  "—"
                )}
              </td>
              <td className="py-1 font-mono text-[10px] text-zinc-500 break-all">
                {ck.root_hash ? (
                  <span className="text-emerald-700 dark:text-emerald-400">
                    {ck.root_hash.slice(0, 10)}…{ck.root_hash.slice(-8)}
                  </span>
                ) : ck.error ? (
                  <span className="text-red-600 dark:text-red-400">upload failed</span>
                ) : (
                  <span className="text-zinc-400">local only</span>
                )}
              </td>
              <td className="py-1 text-[10px]">
                {ck.error ? (
                  <span className="text-red-600 dark:text-red-400" title={ck.error}>
                    ✗ {ck.error.slice(0, 60)}{ck.error.length > 60 ? "…" : ""}
                  </span>
                ) : ck.root_hash ? (
                  <span className="text-emerald-700 dark:text-emerald-400">✓ saved to 0G</span>
                ) : (
                  <span className="text-zinc-500">✓ saved locally</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
