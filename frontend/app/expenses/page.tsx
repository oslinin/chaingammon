// Phase 30: Expenses page — ledger of 0G token–spending events.
//
// Shows one row per charge:
//   - Coach hint via 0G Compute (Qwen 2.5 7B Instruct)
//   - On-chain game settlement via KeeperHub + 0G Chain
//
// The table is populated from localStorage (written by the match page whenever
// the paid coach serves a hint, or when a game is settled on-chain). The empty
// state is shown when no entries exist — i.e. the user has only ever used the
// free local coach and has not settled any games.
//
// SSR note: `getExpenses()` returns [] on the server, so the empty-state card
// is always the server-rendered HTML. The client replaces it after hydration if
// localStorage contains entries.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getExpenses, type ExpenseEntry } from "../expenses";

/**
 * Renders a badge for the expense type.
 * Coach hints use an amber palette; settlement charges use indigo.
 */
function TypeBadge({ type }: { type: ExpenseEntry["type"] }) {
  const isHint = type === "coach_hint";
  return (
    <span
      className={
        isHint
          ? "inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
          : "inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300"
      }
    >
      {isHint ? "Coach hint" : "Settlement"}
    </span>
  );
}

export default function ExpensesPage() {
  // SSR-safe: load from localStorage only after hydration.
  const [entries, setEntries] = useState<ExpenseEntry[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setEntries(getExpenses());
  }, []);

  const isEmpty = !mounted || entries.length === 0;

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
          Expenses
        </h1>
        {/* Right spacer keeps the title visually centred. */}
        <div className="w-20" />
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          One row per 0G token–spending event. Entries appear only when the
          paid coach (0G Compute · Qwen 2.5 7B) is active or a game is settled
          on-chain.
        </p>

        {isEmpty ? (
          <div
            data-testid="expenses-empty"
            className="rounded-lg border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950"
          >
            <p className="text-sm text-zinc-400 dark:text-zinc-500">
              No expenses yet. Enable the paid coach or settle a game to see
              charges here.
            </p>
          </div>
        ) : (
          <div
            data-testid="expenses-table"
            className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          >
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-200 dark:border-zinc-800">
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-zinc-400 dark:text-zinc-500">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <TypeBadge type={entry.type} />
                    </td>
                    <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                      {entry.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
