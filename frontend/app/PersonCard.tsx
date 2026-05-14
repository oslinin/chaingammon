"use client";

import Link from "next/link";

export interface MatchSummary {
  matches: number;
  wins: number;
  losses: number;
}

export interface PersonCardProps {
  label: string;
  nameHref?: string; // ENS app link for the label
  elo: bigint | string | undefined;
  balance?: string; // e.g. "0.0432 ETH"; undefined = loading, "" = no data
  matchSummary: MatchSummary | null | undefined; // undefined = loading, null = no data
  infoHref?: string;
  infoLabel?: string;
  playHref?: string;
  extraLines?: string[]; // e.g. ["6 games trained"] for agents
}

export function PersonCard({
  label,
  nameHref,
  elo,
  balance,
  matchSummary,
  infoHref,
  infoLabel,
  playHref,
  extraLines,
}: PersonCardProps) {
  const eloDisplay = elo !== undefined ? String(elo) : undefined;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-50 break-all">
          {nameHref ? (
            <a href={nameHref} target="_blank" rel="noreferrer" className="hover:underline underline-offset-2">
              {label}
            </a>
          ) : label}
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          {infoHref && (
            <a
              href={infoHref}
              target="_blank"
              rel="noreferrer"
              title="Open info in a new tab"
              className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
            >
              Info ↗
            </a>
          )}
          {infoLabel && (
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {infoLabel}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            ELO
          </span>
          <span className="font-mono text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            {eloDisplay ?? "—"}
          </span>
        </div>
        {balance !== "" && (
          <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
            {balance ?? "…"}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-0.5 text-xs font-mono">
        {matchSummary === undefined ? (
          <p className="text-zinc-400 dark:text-zinc-500">Reading chain…</p>
        ) : matchSummary === null ? null : (
          <p className="text-zinc-700 dark:text-zinc-300">
            {matchSummary.matches} played · {matchSummary.wins} won ·{" "}
            {matchSummary.losses} lost
          </p>
        )}
        {extraLines?.map((line) => (
          <p key={line} className="text-zinc-500 dark:text-zinc-400">
            {line}
          </p>
        ))}
      </div>

      {playHref && (
        <Link
          href={playHref}
          data-testid="person-card-play-button"
          className="mt-1 rounded-md bg-indigo-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        >
          Play
        </Link>
      )}
    </div>
  );
}
