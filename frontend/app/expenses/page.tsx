// Phase 30: Expenses page — ledger of gas and 0G token–spending events.
//
// Shows one row per charge:
//   - Coach hint via 0G Compute (Qwen 2.5 7B Instruct)
//   - On-chain game settlement via KeeperHub + 0G Chain
//   - ENS subname registered via selfMintSubname (gas)
//   - Agent iNFT minted via mintAgent (gas)
//
// The table is populated from localStorage (written whenever an on-chain or
// paid-compute event completes). The empty state is shown when no entries
// exist.
//
// SSR note: `getExpenses()` returns [] on the server, so the empty-state card
// is always the server-rendered HTML. The client replaces it after hydration if
// localStorage contains entries.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getExpenses, type ExpenseEntry } from "../expenses";

const TYPE_LABELS: Record<ExpenseEntry["type"], string> = {
  coach_hint: "Coach hint",
  game_settlement: "Settlement",
  ens_subname: "ENS claim",
  agent_mint: "Agent mint",
};

const TYPE_CLASSES: Record<ExpenseEntry["type"], string> = {
  coach_hint:
    "inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  game_settlement:
    "inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  ens_subname:
    "inline-flex rounded-full bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  agent_mint:
    "inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
};

/** Renders a colour-coded badge for the expense type. */
function TypeBadge({ type }: { type: ExpenseEntry["type"] }) {
  return (
    <span className={TYPE_CLASSES[type] ?? TYPE_CLASSES.game_settlement}>
      {TYPE_LABELS[type] ?? type}
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
          One row per gas or 0G token–spending event: ENS subname registration,
          agent minting, game settlement, and paid coach hints (0G Compute ·
          Qwen 2.5 7B).
        </p>

        {isEmpty ? (
          <div
            data-testid="expenses-empty"
            className="rounded-lg border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950"
          >
            <p className="text-sm text-zinc-400 dark:text-zinc-500">
              No expenses yet. Gas charges appear here after registering an ENS
              subname, minting an agent, settling a game, or using the paid
              coach.
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
