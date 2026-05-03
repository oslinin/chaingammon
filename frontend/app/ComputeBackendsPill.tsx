// Phase F: global compute-backends pill.
//
// Mounted once in layout.tsx so the three operations × two backends
// matrix is visible on every page. Click any [Local|0G] segment to
// flip that operation; state persists via ComputeBackendsContext.
//
// Availability:
//   coach     — 0G is the canonical backend (Qwen 2.5 7B via 0G Compute);
//               local (flan-t5 fallback) is greyed out to direct users to 0G.
//   inference — always runs locally (browser-side value-net); both backends
//               are disabled to show this is not a user-configurable option.
//   training  — always runs locally (TD(λ) self-play loop); same as inference.
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
  // Optional: Force a specific value for display, ignoring the context/local storage.
  forcedValue?: Backend;
  // Tooltip text shown when an unavailable backend is hovered.
  unavailableTooltip?: Record<Backend, string>;
}

const OPS: readonly OpRow[] = [
  {
    key: "coach",
    label: "Coach",
    // Coach is fixed to 0G Compute (Qwen 2.5 7B). Local fallback removed.
    // Both are disabled to show this is no longer user-configurable.
    available: { local: false, "0g": false },
    forcedValue: "0g",
    unavailableTooltip: {
      local: "Local flan-t5 fallback is removed. Coach only runs on 0G Compute.",
      "0g": "Coach is fixed to 0G Compute (Qwen 2.5 7B).",
    },
  },
  {
    key: "inference",
    label: "Inference",
    // Inference runs as a browser-side value-net forward pass (no remote backend).
    // Both segments are disabled to reflect that this is not user-configurable.
    available: { local: false, "0g": false },
    forcedValue: "local",
    unavailableTooltip: {
      local: "Inference runs locally in the browser (value-net forward pass).",
      "0g": "Inference runs locally in the browser (value-net forward pass).",
    },
  },
  {
    key: "training",
    label: "Training",
    // Training (TD(λ) self-play) runs locally. Both segments are disabled.
    available: { local: false, "0g": false },
    forcedValue: "local",
    unavailableTooltip: {
      local: "Training runs locally (TD(λ) self-play loop).",
      "0g": "Training runs locally (TD(λ) self-play loop).",
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
          value={op.forcedValue ?? backends[op.key]}
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
              title={tooltip || undefined}
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
