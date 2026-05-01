// Phase F: global compute-backends pill.
//
// Mounted once in layout.tsx so the three operations × two backends
// matrix is visible on every page. Click any [Local|0G] segment to
// flip that operation; state persists via ComputeBackendsContext.
//
// Availability:
//   coach     — both backends are wired today (chat.mjs + local fallback)
//   inference — 0G is Phase G (eval.mjs); the chip renders the toggle but
//               adds an "(coming)" tooltip and disables 0G until then
//   training  — same as inference (training-as-a-service is out of scope;
//               "training on 0G" really means inference-on-0G during a run)
//
// We render the disabled toggles regardless so the bounty story is
// complete: judges see all three operations, both backends, and the
// honest plumbing state.
"use client";

import {
  Backend,
  ComputeOperation,
  useComputeBackends,
} from "./ComputeBackendsContext";

interface OpRow {
  key: ComputeOperation;
  label: string;
  // Per-backend availability — false renders the segment as disabled.
  available: Record<Backend, boolean>;
  // Tooltip text shown when an unavailable backend is hovered.
  unavailableTooltip?: Record<Backend, string>;
}

const OPS: readonly OpRow[] = [
  {
    key: "coach",
    label: "Coach",
    available: { local: true, "0g": true },
  },
  {
    key: "inference",
    label: "Inference",
    available: { local: true, "0g": false },
    unavailableTooltip: {
      local: "",
      "0g": "Phase G: eval bridge not wired yet",
    },
  },
  {
    key: "training",
    label: "Training",
    available: { local: true, "0g": false },
    unavailableTooltip: {
      local: "",
      "0g": "Use Inference=0G during a training run for the bounty story; remote training-as-a-service is out of scope",
    },
  },
] as const;

export function ComputeBackendsPill() {
  const { backends, setBackend, hydrated } = useComputeBackends();

  return (
    <div
      role="region"
      aria-label="Compute backends"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900"
    >
      <span className="font-mono uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Compute
      </span>
      {OPS.map((op) => (
        <Row
          key={op.key}
          row={op}
          value={backends[op.key]}
          hydrated={hydrated}
          onChange={(v) => setBackend(op.key, v)}
        />
      ))}
    </div>
  );
}

function Row({
  row,
  value,
  hydrated,
  onChange,
}: {
  row: OpRow;
  value: Backend;
  hydrated: boolean;
  onChange: (v: Backend) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-zinc-700 dark:text-zinc-300">{row.label}</span>
      <div
        role="radiogroup"
        aria-label={`${row.label} backend`}
        className="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700"
      >
        {(["local", "0g"] as Backend[]).map((backend) => {
          const isActive = value === backend;
          const isAvailable = row.available[backend];
          const tooltip = row.unavailableTooltip?.[backend];
          // Suppress the active-state class until after hydration so
          // SSR matches the initial client render exactly.
          const renderActive = hydrated && isActive;
          return (
            <button
              key={backend}
              type="button"
              role="radio"
              aria-checked={renderActive}
              disabled={!isAvailable}
              title={!isAvailable && tooltip ? tooltip : undefined}
              onClick={() => isAvailable && onChange(backend)}
              className={[
                "px-2 py-0.5 font-mono uppercase tracking-wide transition-colors",
                renderActive
                  ? "bg-emerald-600 text-white"
                  : "bg-white text-zinc-700 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
                !isAvailable
                  ? "cursor-not-allowed opacity-50 hover:bg-white dark:hover:bg-zinc-900"
                  : "",
              ].join(" ")}
            >
              {backend === "0g" ? "0G" : "local"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
