// Round-robin training page.
//
// Layout (top to bottom):
//   1. Title + subtitle
//   2. Compute-backends summary
//   3. Agent selector (checkbox list of all on-chain agents)
//   4. Logarithmic epoch slider with snap-tick marks
//   5. Cost estimate row (visible when Inference=0G)
//   6. Play button
//   7. Status panel: progress bar + per-agent stats
//
// State machine (browser-only — no HTTP servers we operate):
//   idle      → click Play → submitTrainingJob() to 0G Compute provider
//   running   → progress updates from broker SDK
//   done      → per-agent stats panel; updated ONNX bytes in IndexedDB
//   error     → red error row; user can retry
//
// All training is dispatched directly to a backgammon-train-v1 provider on
// the 0G serving network via the user's MetaMask wallet. The previous
// FastAPI POST /training/start path is gone.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useReadContract, useReadContracts, useWalletClient } from "wagmi";

import { useComputeBackends } from "../ComputeBackendsContext";
import { useActiveChain, useActiveChainId } from "../chains";
import { AgentRegistryABI, useChainContracts } from "../contracts";
import {
  OgTrainingUnavailable,
  submitTrainingJob,
  type TrainingJobResult,
} from "../../lib/og_training";

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

// Local UI state machine. No server polling.
type TrainingPhase = "idle" | "loading_weights" | "running" | "done" | "error";

interface TrainingState {
  phase: TrainingPhase;
  step?: string;           // progress sub-step label from broker
  errorMessage?: string;
  errorUnavailable?: boolean; // true when no provider is registered
  startedAt?: number;
  finishedAt?: number;
  result?: TrainingJobResult;
  agentIds: number[];
  epochs: number;
}

const PER_INFERENCE_OG = 1e-5;
const MEAN_PLIES_PER_GAME = 60;

export default function TrainingPage() {
  const { backends, hydrated } = useComputeBackends();
  const use0gInference = hydrated && backends.inference === "0g";

  // Agent list: read straight from AgentRegistry on the wallet's chain
  // (same shape as the legacy /agents server endpoint) so this page
  // works in the static Pages build with no FastAPI backend.
  const chainId = useActiveChainId();
  const activeChain = useActiveChain();
  const { agentRegistry } = useChainContracts();

  const { data: activeAgentCountRaw, isLoading: agentCountLoading, error: agentCountError } =
    useReadContract({
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
      { address: agentRegistry, abi: AgentRegistryABI, functionName: "dataHashes" as const, args, chainId },
      { address: agentRegistry, abi: AgentRegistryABI, functionName: "matchCount" as const, args, chainId },
      { address: agentRegistry, abi: AgentRegistryABI, functionName: "tier" as const, args, chainId },
    ];
  });
  const { data: agentDetailResults, isLoading: agentDetailsLoading } = useReadContracts({
    contracts: agentDetailCalls,
    query: { enabled: onChainAgentIds.length > 0 },
  });

  const agents: AgentRow[] = onChainAgentIds.map((agent_id, i) => {
    const base = i * 3;
    const hashes = agentDetailResults?.[base]?.result as
      | readonly [`0x${string}`, `0x${string}`]
      | undefined;
    const matchCountRaw = agentDetailResults?.[base + 1]?.result as
      | number
      | bigint
      | undefined;
    const tierRaw = agentDetailResults?.[base + 2]?.result as number | undefined;
    return {
      agent_id,
      weights_hash: hashes?.[1] ?? "",
      match_count:
        typeof matchCountRaw === "bigint" ? Number(matchCountRaw) : matchCountRaw ?? 0,
      tier: tierRaw ?? 0,
    };
  });

  const agentsLoading = agentCountLoading || (agentCount > 0 && agentDetailsLoading);
  const agentsError = agentCountError;
  const agentsLoaded = !agentsLoading && !agentsError;

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  // First time we load, pre-select all.
  useEffect(() => {
    if (agentsLoaded && agents.length > 0 && selectedIds.length === 0) {
      setSelectedIds(agents.map((a) => a.agent_id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsLoaded, agents.length]);

  // Slider position + derived epochs.
  const [sliderPos, setSliderPos] = useState(0); // 1 epoch default
  const epochs = useMemo(
    () => positionToEpochs(sliderPos, use0gInference),
    [sliderPos, use0gInference]
  );

  // Games per epoch (UI affordance — also computed server-side).
  const n = selectedIds.length;
  const gamesPerEpoch = (n * (n - 1)) / 2;

  // Client-side cost estimate — no server call. Same arithmetic the
  // FastAPI /training/estimate endpoint used to do.
  const estimate = useMemo(() => {
    if (selectedIds.length < 2) return null;
    const games = epochs * gamesPerEpoch;
    const totalInferences = games * MEAN_PLIES_PER_GAME;
    return {
      games,
      totalInferences,
      gasOg: use0gInference ? totalInferences * PER_INFERENCE_OG : 0,
      perInferenceOg: use0gInference ? PER_INFERENCE_OG : 0,
    };
  }, [epochs, gamesPerEpoch, selectedIds.length, use0gInference]);

  const { data: walletClient } = useWalletClient();

  const [training, setTraining] = useState<TrainingState>({
    phase: "idle",
    agentIds: [],
    epochs: 0,
  });
  const [modalOpen, setModalOpen] = useState(false);
  const openedAtRef = useRef<number | null>(null);

  const isRunning = training.phase === "loading_weights" || training.phase === "running";

  const handlePlay = async () => {
    if (!walletClient) {
      setTraining((s) => ({
        ...s,
        phase: "error",
        errorMessage: "Connect your wallet first — training pays for 0G Compute from your MetaMask account.",
      }));
      return;
    }

    const now = Date.now();
    openedAtRef.current = now;
    setModalOpen(true);
    setTraining({
      phase: "loading_weights",
      step: "Fetching current agent weights",
      agentIds: selectedIds,
      epochs,
      startedAt: now,
    });

    // For each selected agent, fetch its current ONNX weights. The base
    // `/backgammon_net.onnx` is the shared starting point until per-agent
    // weights are uploaded to 0G Storage (deferred — see plan).
    let weightsByAgentId: Record<number, Uint8Array>;
    try {
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
      const buf = (await fetch(`${basePath}/backgammon_net.onnx`).then((r) =>
        r.arrayBuffer(),
      )) as ArrayBuffer;
      const baseBytes = new Uint8Array(buf);
      weightsByAgentId = Object.fromEntries(
        selectedIds.map((id) => [id, baseBytes.slice()]),
      );
    } catch (e) {
      setTraining((s) => ({
        ...s,
        phase: "error",
        errorMessage: `Could not load base ONNX weights: ${(e as Error).message}`,
      }));
      return;
    }

    try {
      setTraining((s) => ({ ...s, phase: "running", step: "Connecting to 0G Compute" }));
      const result = await submitTrainingJob({
        agentIds: selectedIds,
        epochs,
        weightsByAgentId,
        walletClient,
        onProgress: (evt) => setTraining((s) => ({ ...s, step: evt.detail ?? evt.step })),
      });
      setTraining({
        phase: "done",
        agentIds: selectedIds,
        epochs,
        startedAt: now,
        finishedAt: Date.now(),
        result,
      });
    } catch (e) {
      if (e instanceof OgTrainingUnavailable) {
        setTraining((s) => ({
          ...s,
          phase: "error",
          errorMessage: e.message,
          errorUnavailable: true,
        }));
      } else {
        setTraining((s) => ({
          ...s,
          phase: "error",
          errorMessage: (e as Error).message,
        }));
      }
    }
  };

  const canPlay = selectedIds.length >= 2 && !isRunning;

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

      <div
        className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-700/50 dark:bg-emerald-900/10 dark:text-emerald-200"
      >
        <strong>Training runs on 0G Compute.</strong> Play submits a round-robin
        job to a <code className="font-mono">backgammon-train-v1</code> provider
        on the 0G serving network. Your MetaMask wallet pays for the compute
        directly — no FastAPI server, no API route, no operator key in the
        trust path.
      </div>

      <AgentSelector
        agents={agents}
        loading={agentsLoading}
        error={agentsError ?? null}
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

      {use0gInference && estimate && (
        <GasEstimate
          games={estimate.games}
          totalInferences={estimate.totalInferences}
          gasOg={estimate.gasOg}
        />
      )}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={!canPlay}
          onClick={() => void handlePlay()}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isRunning ? "Running…" : "Play"}
        </button>
        {training.phase === "error" && (
          <span
            className={`self-center text-xs ${
              training.errorUnavailable ? "text-amber-700 dark:text-amber-400" : "text-red-600"
            }`}
          >
            {training.errorMessage}
          </span>
        )}
      </div>

      <StatusPanel training={training} />

      <TrainingProgressModal
        key={openedAtRef.current ?? 0}
        open={modalOpen}
        training={training}
        agentCount={selectedIds.length}
        onClose={() => setModalOpen(false)}
      />
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
  games,
  totalInferences,
  gasOg,
}: {
  games: number;
  totalInferences: number;
  gasOg: number;
}) {
  return (
    <section className="rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-700 dark:bg-emerald-950/30">
      <div className="grid grid-cols-3 gap-3 font-mono text-xs">
        <Stat label="Games" value={games.toLocaleString()} />
        <Stat label="Inferences" value={totalInferences.toLocaleString()} />
        <Stat label="Est. cost" value={`~${gasOg.toFixed(6)} OG`} accent />
      </div>
      <p className="mt-2 text-[10px] text-emerald-800 dark:text-emerald-300">
        Paid from your wallet at the provider&apos;s per-inference rate.
      </p>
    </section>
  );
}

function StatusPanel({ training }: { training: TrainingState }) {
  if (training.phase === "idle") return null;
  const stats = training.result?.statsByAgentId;
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Status
        </h2>
        <StatusBadge training={training} />
      </div>

      {training.step && training.phase !== "done" && (
        <p className="mb-3 text-xs text-zinc-500">{training.step}</p>
      )}

      {training.phase === "done" && training.result && (
        <p className="mb-3 text-xs text-zinc-500">
          {training.result.totalGames.toLocaleString()} games · provider{" "}
          <span className="font-mono">
            {training.result.providerAddress.slice(0, 8)}…
            {training.result.providerAddress.slice(-6)}
          </span>
        </p>
      )}

      {stats && Object.keys(stats).length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th className="py-1 text-left font-mono uppercase text-zinc-500">Agent</th>
              <th className="text-right font-mono uppercase text-zinc-500">Games</th>
              <th className="text-right font-mono uppercase text-zinc-500">Wins</th>
              <th className="text-right font-mono uppercase text-zinc-500">Win rate</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(stats).map(([aid, s]) => {
              const wr = s.games > 0 ? (s.wins / s.games) * 100 : 0;
              return (
                <tr key={aid} className="border-b border-zinc-100 dark:border-zinc-800">
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

function StatusBadge({ training }: { training: TrainingState }) {
  if (training.phase === "running" || training.phase === "loading_weights") {
    return (
      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-mono text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        running · 0G compute
      </span>
    );
  }
  if (training.phase === "done") {
    return (
      <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-mono text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        done
      </span>
    );
  }
  if (training.phase === "error") {
    return (
      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-mono text-amber-800 dark:bg-amber-950 dark:text-amber-300">
        {training.errorUnavailable ? "no provider" : "error"}
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

function TrainingProgressModal({
  open,
  training,
  agentCount,
  onClose,
}: {
  open: boolean;
  training: TrainingState;
  agentCount: number;
  onClose: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [open]);

  // Step completion predicates derived from the local TrainingState.
  //   s1: loading agent weights done (phase moved past loading_weights)
  //   s2: provider call started (phase === running)
  //   s3: provider call returned (phase === done)
  const s1done =
    training.phase === "running" ||
    training.phase === "done" ||
    training.phase === "error";
  const s2done = training.phase === "done" || training.phase === "error";
  const s3done = training.phase === "done";

  const t = useRef<(number | null)[]>([null, null, null, null]);
  useEffect(() => {
    if (!open) return;
    if (t.current[0] === null) t.current[0] = training.startedAt ?? Date.now();
    if (s1done && t.current[1] === null) t.current[1] = Date.now();
    if (s2done && t.current[2] === null) t.current[2] = Date.now();
    if (s3done && t.current[3] === null) t.current[3] = training.finishedAt ?? Date.now();
  }, [open, training.startedAt, training.finishedAt, s1done, s2done, s3done]);

  if (!open) return null;

  const fmtElapsed = (startMs: number | null, endMs: number | null) => {
    if (startMs === null) return null;
    const s = Math.floor(((endMs ?? now) - startMs) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  const steps = [
    {
      label: `Load ONNX weights (${agentCount} agent${agentCount === 1 ? "" : "s"})`,
      active: t.current[0] !== null && !s1done,
      done: s1done,
      time: fmtElapsed(t.current[0], s1done ? t.current[1] : null),
    },
    {
      label: "Submit to 0G Compute provider",
      active: s1done && !s2done,
      done: s2done,
      time: fmtElapsed(t.current[1], s2done ? t.current[2] : null),
    },
    {
      label: "Provider runs round-robin training",
      active: s2done && !s3done,
      done: s3done,
      time: fmtElapsed(t.current[2], s3done ? t.current[3] : null),
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="relative w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          ✕
        </button>
        <h2 className="mb-5 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Training progress
        </h2>
        <ol className="flex flex-col gap-4">
          {steps.map((step, i) => (
            <li key={i} className="flex items-center gap-3">
              <StepIcon done={step.done} active={step.active} />
              <span
                className={[
                  "flex-1 text-sm",
                  step.done || step.active
                    ? "text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-400 dark:text-zinc-600",
                ].join(" ")}
              >
                {step.label}
              </span>
              {step.time && (
                <span className="font-mono text-xs text-zinc-400">
                  {step.time}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function StepIcon({ done, active }: { done: boolean; active: boolean }) {
  if (done) {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
        <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
          <polyline
            points="2,6 5,9 10,3"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (active) {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <svg
          className="h-5 w-5 animate-spin text-emerald-600"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      </span>
    );
  }
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-zinc-300 dark:border-zinc-600" />
  );
}

