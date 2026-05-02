// Phase 36: /ens/[matchId] — ENS text record viewer for the current match.
//
// Architecture:
//   - matchId is read from the URL segment via useParams (SSR-safe mounted pattern).
//   - The connected player's ENS label is read from localStorage ("ensLabel",
//     set by the profile page when the player claims a subname).
//   - Text records are fetched live from the FastAPI server's /ens-records/{label}
//     endpoint, which reads directly from the PlayerSubnameRegistrar contract.
//   - A "before ELO" snapshot is read from localStorage ("matchStartElo") set
//     at game start in match/page.tsx so the before/after comparison renders.
//   - Pre-settlement: shows a pending banner noting the keeper has not run yet.
//   - The sentinel matchId "no-match" renders the "no active match" state.
//
// Five text record keys are surfaced: elo, match_count, last_match_id,
// style_uri, archive_uri. KeeperHub writes elo, last_match_id, and archive_uri
// at settlement — these are highlighted with a "keeper" badge.
//
// Data source: live on-chain reads via server/app/main.py `/ens-records/`.
// Static export: generateStaticParams pre-builds placeholder shells.
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";
const NO_MATCH_SENTINEL = "no-match";

// Text record keys the PlayerSubnameRegistrar stores per player.
const TEXT_KEYS = ["elo", "match_count", "last_match_id", "style_uri", "archive_uri"] as const;
type TextKey = (typeof TEXT_KEYS)[number];

// Keys that the KeeperHub workflow writes at settlement — highlighted in the UI.
const KEEPER_WRITTEN_KEYS: readonly TextKey[] = ["elo", "last_match_id", "archive_uri"];

// Shape returned by GET /ens-records/{label}.
interface EnsRecordsResponse {
  label: string;
  records: Record<string, string>;
}

export default function EnsClient() {
  const params = useParams();
  const [mounted, setMounted] = useState(false);
  const [ensLabel, setEnsLabel] = useState<string | null>(null);
  const [matchStartElo, setMatchStartElo] = useState<string | null>(null);
  const [records, setRecords] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    setEnsLabel(window.localStorage.getItem("ensLabel"));
    setMatchStartElo(window.localStorage.getItem("matchStartElo"));
  }, []);

  const matchId = mounted ? (params?.matchId as string) : null;
  const isNoMatch = matchId === NO_MATCH_SENTINEL || matchId === "placeholder";

  // Fetch live text records from the server once the player's ENS label is known.
  useEffect(() => {
    if (!ensLabel || isNoMatch) return;
    setLoading(true);
    setFetchError(null);
    fetch(`${SERVER}/ens-records/${encodeURIComponent(ensLabel)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        return res.json() as Promise<EnsRecordsResponse>;
      })
      .then((data) => setRecords(data.records))
      .catch((e: unknown) => setFetchError(String(e)))
      .finally(() => setLoading(false));
  }, [ensLabel, isNoMatch]);

  // Settlement has run if the on-chain elo differs from the pre-match snapshot.
  const currentElo = records?.["elo"] ?? "";
  const settled = !!currentElo && matchStartElo !== null && currentElo !== matchStartElo;

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
          ENS updates
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
            data-testid="ens-no-match"
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

        {!isNoMatch && (
          <div data-testid="ens-records" className="flex flex-col gap-4">
            {/* ENS label header */}
            <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Player subname
              </p>
              <p className="mt-1 font-mono text-sm text-zinc-900 dark:text-zinc-50">
                {mounted && ensLabel
                  ? `${ensLabel}.chaingammon.eth`
                  : "No ENS label — claim one from your profile"}
              </p>
            </div>

            {/* Pre-settlement pending banner */}
            {!settled && mounted && (
              <div
                data-testid="ens-pending"
                className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-700/40 dark:bg-amber-900/10"
              >
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Pending — keeper has not run settlement yet
                </p>
                <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-500">
                  Text records update after the KeeperHub workflow completes (
                  <Link
                    href={`/keeper/${matchId ?? "no-match"}`}
                    className="underline"
                  >
                    watch progress
                  </Link>
                  ).
                </p>
              </div>
            )}

            {/* Fetch error */}
            {fetchError && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                Could not fetch ENS records: {fetchError}
              </p>
            )}

            {/* Loading */}
            {loading && (
              <p className="animate-pulse text-sm text-zinc-500 dark:text-zinc-400">
                Reading from chain…
              </p>
            )}

            {/* Text records table — shown when an ENS label is available */}
            {mounted && ensLabel && (
              <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                <table className="w-full text-sm">
                  <thead className="border-b border-zinc-200 dark:border-zinc-800">
                    <tr className="text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                      <th className="px-4 py-3">Key</th>
                      <th className="px-4 py-3">Before match</th>
                      <th className="px-4 py-3">Current (on-chain)</th>
                      <th className="px-4 py-3">Keeper</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
                    {TEXT_KEYS.map((key) => {
                      const current = loading ? "…" : (records?.[key] ?? "—");
                      const before = key === "elo" && matchStartElo ? matchStartElo : "—";
                      const changed = key === "elo" && matchStartElo && records?.["elo"] && records["elo"] !== matchStartElo;
                      const keeperWritten = KEEPER_WRITTEN_KEYS.includes(key);
                      return (
                        <tr key={key} data-testid={`ens-row-${key}`}>
                          <td className="px-4 py-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                            {key}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                            {before}
                          </td>
                          <td
                            className={`px-4 py-3 font-mono text-xs ${
                              changed
                                ? "font-semibold text-green-700 dark:text-green-400"
                                : "text-zinc-700 dark:text-zinc-300"
                            }`}
                          >
                            {current}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {keeperWritten && (
                              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                                ✓
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
