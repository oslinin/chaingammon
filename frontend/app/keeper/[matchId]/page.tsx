// Phase 36: /keeper/[matchId] — KeeperHub workflow steps for the current match.
//
// Architecture:
//   - matchId is read from the URL segment via useParams (SSR-safe mounted pattern).
//   - Calls GET /keeper-workflow/{matchId} on the FastAPI server
//     (server/app/main.py) which currently returns a deterministic mock keyed
//     by matchId. The shape is the real KeeperHub API contract so the page
//     needs no changes when Phase 37 replaces the mock with live data.
//   - Each of the eight workflow steps is rendered as a row with status badge,
//     duration, retry count, and tx hash link where applicable.
//   - Failed steps surface the error/log field — this page is the primary
//     debugging surface when keeper settlement breaks.
//   - The sentinel matchId "no-match" renders the "no active match" state.
//
// TODO(phase-37): Remove the mock from server/app/main.py and replace the
// /keeper-workflow/{matchId} implementation with `kh run status --json` output
// piped through the FastAPI server once the KeeperHub workflow is wired.
//
// Data source: deterministic mock from server/app/main.py (Phase 36).
// Static export: generateStaticParams pre-builds placeholder shells.
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

export function generateStaticParams() {
  return [{ matchId: "placeholder" }, { matchId: NO_MATCH_SENTINEL }];
}

export default function KeeperPage() {
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

  useEffect(() => {
    if (!matchId || isNoMatch) return;
    setLoading(true);
    setFetchError(null);
    fetch(`${SERVER}/keeper-workflow/${encodeURIComponent(matchId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        return res.json() as Promise<WorkflowRun>;
      })
      .then((data) => setRun(data))
      .catch((e: unknown) => setFetchError(String(e)))
      .finally(() => setLoading(false));
  }, [matchId, isNoMatch]);

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

        {/* Mock notice */}
        {mounted && !isNoMatch && (
          <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-2 dark:border-indigo-900/40 dark:bg-indigo-900/10">
            <p className="text-xs text-indigo-600 dark:text-indigo-400">
              <span className="font-semibold">Mock data (Phase 36)</span> — KeeperHub
              workflow integration lands in Phase 37. This view shows the real
              API shape with deterministic placeholder values keyed by matchId.
            </p>
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
