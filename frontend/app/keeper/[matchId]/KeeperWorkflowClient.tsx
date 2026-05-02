// Phase 37: /keeper/[matchId] client subtree — KeeperHub workflow steps for the
// current match. Split out from page.tsx so the server-side page can export
// generateStaticParams (Next 16 forbids "use client" + generateStaticParams in
// the same file).
//
// Architecture:
//   - matchId is read from the URL segment via useParams (SSR-safe mounted pattern).
//   - Calls GET /keeper-workflow/{matchId} on the FastAPI server. The
//     endpoint reads the persisted workflow JSON from disk; if no run
//     has happened the response is the canonical 8-step "all pending"
//     shape so the UI always has something to render.
//   - Each of the eight workflow steps is rendered as a row with status
//     badge, duration, retry count, and audit-anchor link where applicable.
//   - Failed steps surface the error/log field — this page is the primary
//     debugging surface when keeper settlement breaks.
//   - The sentinel matchId "no-match" renders the "no active match" state.
//   - The "Run workflow" button POSTs /keeper-workflow/{matchId}/run to
//     trigger a fresh run; the page polls every 1.5s while a run is
//     in progress so judges see live mid-run progress.
//
// Data source: real Phase 37 orchestrator at server/app/keeper_workflow.py.
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";
const NO_MATCH_SENTINEL = "no-match";

// Status values for workflow steps and the overall run.
type StepStatus = "pending" | "running" | "ok" | "failed";

// Shape of a single KeeperHub workflow step — mirrors the server's response.
interface WorkflowStep {
  id: string;
  name: string;
  status: StepStatus;
  duration_ms: number | null;
  retry_count: number;
  tx_hash: string | null;
  error: string | null;
  detail: string | null;
}

// Top-level response shape from /keeper-workflow/{matchId}.
interface WorkflowRun {
  matchId: string;
  status: StepStatus;
  steps: WorkflowStep[];
}

export default function KeeperWorkflowClient() {
  const params = useParams();
  const [mounted, setMounted] = useState(false);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const matchId = mounted ? (params?.matchId as string) : null;
  const isNoMatch = matchId === NO_MATCH_SENTINEL || matchId === "placeholder";

  // Initial fetch + polling while running. Phase 37: polls /keeper-workflow/{id}
  // every 1.5s as long as the workflow is "running"; stops on terminal state
  // (ok / failed) so finished runs don't waste round-trips.
  useEffect(() => {
    if (!matchId || isNoMatch) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async () => {
      try {
        const res = await fetch(
          `${SERVER}/keeper-workflow/${encodeURIComponent(matchId)}`,
        );
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        const data = (await res.json()) as WorkflowRun;
        if (cancelled) return;
        setRun(data);
        setFetchError(null);
        if (data.status === "running") {
          pollTimer = setTimeout(fetchOnce, 1500);
        }
      } catch (e: unknown) {
        if (!cancelled) setFetchError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    fetchOnce();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [matchId, isNoMatch]);

  const [running, setRunning] = useState(false);
  const triggerRun = async () => {
    if (!matchId || isNoMatch || running) return;
    setRunning(true);
    setFetchError(null);
    try {
      const res = await fetch(
        `${SERVER}/keeper-workflow/${encodeURIComponent(matchId)}/run`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = (await res.json()) as WorkflowRun;
      setRun(data);
    } catch (e: unknown) {
      setFetchError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          ← Home
        </Link>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          KeeperHub steps
        </h1>
        <div className="w-20" />
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
        {mounted && matchId && !isNoMatch && (
          <p className="font-mono text-xs text-zinc-400 dark:text-zinc-600">
            Match: {matchId}
          </p>
        )}

        {/* No active match sentinel */}
        {mounted && isNoMatch && (
          <div
            data-testid="keeper-no-match"
            className="rounded-lg border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950"
          >
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              No active match
            </p>
            <p className="mt-1 text-sm text-zinc-400 dark:text-zinc-500">
              Start one from{" "}
              <Link
                href="/match?agentId=1"
                className="text-indigo-600 underline dark:text-indigo-400"
              >
                Play with agent
              </Link>
              .
            </p>
          </div>
        )}

        {/* Run button — Phase 37 trigger */}
        {mounted && !isNoMatch && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={triggerRun}
              disabled={running || run?.status === "running"}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "Triggering…" : run?.status === "running"
                ? "Workflow running…"
                : "Run workflow"}
            </button>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Triggers the 8-step orchestrator. Polls every 1.5 s while running.
            </span>
          </div>
        )}

        {/* Fetch error */}
        {fetchError && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
            Could not reach server: {fetchError}
          </p>
        )}

        {/* Loading state */}
        {loading && (
          <p className="animate-pulse text-sm text-zinc-500 dark:text-zinc-400">
            Fetching workflow status…
          </p>
        )}

        {/* Step list */}
        {!isNoMatch && (
          <div data-testid="keeper-steps" className="flex flex-col gap-2">
            {run && (
              <>
                {/* Overall run status */}
                <div className="mb-2 flex items-center gap-2">
                  <StatusBadge status={run.status} />
                  <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                    Workflow{" "}
                    {run.status === "ok"
                      ? "complete"
                      : run.status === "failed"
                      ? "failed"
                      : run.status === "running"
                      ? "in progress"
                      : "pending"}
                  </span>
                </div>

                {run.steps.map((step, i) => (
                  <StepRow key={step.id} step={step} index={i} explorerUrl="https://chainscan-galileo.0g.ai" />
                ))}
              </>
            )}

            {/* Empty state when server is unreachable but no error yet */}
            {!run && !loading && !fetchError && mounted && !isNoMatch && (
              <div className="rounded-lg border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950">
                <p className="text-sm text-zinc-400 dark:text-zinc-500">
                  Waiting for server response…
                </p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

/** Colour-coded status badge matching the four workflow step states. */
function StatusBadge({ status }: { status: StepStatus }) {
  const classes: Record<StepStatus, string> = {
    ok: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    running: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    pending: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[status]}`}
    >
      {status}
    </span>
  );
}

/** One workflow step rendered as a card row. */
function StepRow({
  step,
  index,
  explorerUrl,
}: {
  step: WorkflowStep;
  index: number;
  explorerUrl: string;
}) {
  return (
    <div
      data-testid={`keeper-step-${step.id}`}
      className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex flex-wrap items-start gap-2">
        {/* Step number */}
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {index + 1}
        </span>

        {/* Step name + status */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {step.name}
            </span>
            <StatusBadge status={step.status} />
          </div>

          {/* Detail text */}
          {step.detail && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {step.detail}
            </p>
          )}

          {/* Error — visible only on failed steps */}
          {step.error && (
            <p className="rounded bg-red-50 px-2 py-1 font-mono text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
              {step.error}
            </p>
          )}

          {/* Metadata row: duration, retries, tx link */}
          <div className="flex flex-wrap gap-3 text-xs text-zinc-400 dark:text-zinc-600">
            {step.duration_ms !== null && (
              <span>{(step.duration_ms / 1000).toFixed(2)}s</span>
            )}
            {step.retry_count > 0 && (
              <span>{step.retry_count} retries</span>
            )}
            {step.tx_hash && (
              <a
                href={`${explorerUrl}/tx/${step.tx_hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-500 underline hover:text-indigo-400 dark:text-indigo-400"
              >
                tx ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
