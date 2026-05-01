// Phase 36: /log/[matchId] — 0G Storage log viewer for the current match.
//
// Architecture:
//   - matchId is read from the URL segment via useParams (SSR-safe mounted
//     pattern to avoid hydration mismatches in the static export).
//   - The page reads `currentMatchArchiveUri` from localStorage (set by the
//     match flow when the keeper writes the archive after settlement). If the
//     key is present, the game record is fetched from the FastAPI server's
//     /game-records/{rootHash} endpoint and rendered as a chronological feed.
//   - If no archive URI is stored (match still in progress or pre-settlement)
//     the page renders an empty/pending state explaining what will appear.
//   - The sentinel matchId "no-match" triggers the "no active match" state.
//
// TODO(phase-37): Add drand fields (round, randomness, signature) to each
// move entry once the KeeperHub VRF workflow is active. The "Verify" button
// for each entry will then call the drand verification API for roll entries
// and ECDSA-recover for move entries.
//
// Data source: live 0G Storage data via server/app/main.py `/game-records/`.
// Static export: generateStaticParams pre-builds placeholder shells;
// arbitrary matchIds work in dev mode.
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

// FastAPI server URL — distinct from the local gnubg service (port 8001).
const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

// Sentinel value written to the URL when no match is active in localStorage.
const NO_MATCH_SENTINEL = "no-match";

// Shape of a move state returned by /game-records/{rootHash}.states[].
interface MoveState {
  turn: number;
  dice: number[];
  move: string;
  board: number[];
  bar: number[];
  off: number[];
}

// Pre-build static shells for the placeholder and no-match sentinels.
// In dev mode, Next.js serves any matchId dynamically.
export function generateStaticParams() {
  return [{ matchId: "placeholder" }, { matchId: NO_MATCH_SENTINEL }];
}

export default function LogPage() {
  const params = useParams();

  // SSR-safe: useParams() is available but matchId must be read after mount
  // to prevent hydration mismatches in the static export (the HTML shell is
  // built for the placeholder param, not the runtime matchId from localStorage).
  const [mounted, setMounted] = useState(false);
  const [archiveUri, setArchiveUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [moves, setMoves] = useState<MoveState[]>([]);

  useEffect(() => {
    setMounted(true);
    const uri = window.localStorage.getItem("currentMatchArchiveUri");
    setArchiveUri(uri);
  }, []);

  const matchId = mounted ? (params?.matchId as string) : null;
  const isNoMatch = matchId === NO_MATCH_SENTINEL || matchId === "placeholder";

  // Fetch game record from 0G Storage via the server when archive URI is available.
  useEffect(() => {
    if (!archiveUri || isNoMatch) return;
    // Format: "0g://<rootHash>" — strip the scheme prefix before the request.
    const rootHash = archiveUri.startsWith("0g://")
      ? archiveUri.slice(5)
      : archiveUri;
    setLoading(true);
    setFetchError(null);
    fetch(`${SERVER}/game-records/${rootHash}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        return res.json() as Promise<{ record: unknown; states: MoveState[] }>;
      })
      .then((data) => setMoves(data.states ?? []))
      .catch((e: unknown) => setFetchError(String(e)))
      .finally(() => setLoading(false));
  }, [archiveUri, isNoMatch]);

  const hasData = moves.length > 0;
  const isEmpty = !archiveUri && mounted && !isNoMatch;

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
          0G Storage log
        </h1>
        <div className="w-20" />
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
        {/* Match identifier */}
        {mounted && matchId && !isNoMatch && (
          <p className="font-mono text-xs text-zinc-400 dark:text-zinc-600">
            Match: {matchId}
          </p>
        )}

        {/* No active match sentinel */}
        {mounted && isNoMatch && (
          <div
            data-testid="log-no-match"
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

        {/* Fetch error */}
        {fetchError && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
            Could not fetch log from 0G Storage: {fetchError}
          </p>
        )}

        {/* Chronological feed */}
        {!isNoMatch && (
          <div data-testid="log-feed" className="flex flex-col gap-3">
            {loading && (
              <p className="animate-pulse text-sm text-zinc-500 dark:text-zinc-400">
                Fetching log from 0G Storage…
              </p>
            )}

            {/* Empty / pending state — no archive yet */}
            {isEmpty && !loading && (
              <div
                data-testid="log-empty"
                className="rounded-lg border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950"
              >
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  No archive yet
                </p>
                <p className="mt-1 text-sm text-zinc-400 dark:text-zinc-500">
                  Match in progress — 0G Storage log entries appear here after
                  the KeeperHub workflow completes settlement.
                </p>
              </div>
            )}

            {/* Move entries */}
            {hasData &&
              moves.map((move, i) => (
                <MoveRow key={i} move={move} index={i} />
              ))}
          </div>
        )}
      </main>
    </div>
  );
}

/** Renders one move entry in the chronological feed. */
function MoveRow({ move, index }: { move: MoveState; index: number }) {
  const sideLabel = move.turn === 0 ? "Human" : "Agent";
  return (
    <div
      data-testid={`log-entry-${index}`}
      className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              move.turn === 0
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {sideLabel}
          </span>
          <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
            Move {index + 1}
          </span>
        </div>
        {/* Verify affordance — active once drand VRF is wired in Phase 37. */}
        <button
          type="button"
          disabled
          title="Verification requires drand VRF integration (Phase 37)"
          className="rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-300 dark:border-zinc-700 dark:text-zinc-600"
        >
          Verify
        </button>
      </div>
      <div className="mt-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
        Dice {move.dice.join(",")} · {move.move || "—"}
      </div>
    </div>
  );
}
