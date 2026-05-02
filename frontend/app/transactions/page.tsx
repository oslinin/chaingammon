// Transactions page — ledger of all billable events.
//
// Shows one row per charge:
//   - Coach hint via 0G Compute (Qwen 2.5 7B Instruct)
//   - On-chain game settlement via KeeperHub + 0G Chain
//   - ENS subname registered via selfMintSubname (gas)
//   - Agent iNFT minted via mintAgent (gas)
//   - Agent wallet funded (native token transfer)
//   - KeeperHub workflow triggered or automation run
//   - 0G Storage blob upload (agent weights, match archive)
//   - 0G Compute session call (inference, training step)
//
// The table is populated from localStorage (written whenever a billable
// event completes). The empty state is shown when no entries exist.
//
// SSR note: `getTransactions()` returns [] on the server, so the empty-state
// card is always the server-rendered HTML. The client replaces it after
// hydration if localStorage contains entries.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getTransactions, type TransactionEntry } from "../transactions";

const TYPE_LABELS: Record<TransactionEntry["type"], string> = {
  coach_hint: "Coach hint",
  game_settlement: "Settlement",
  ens_subname: "ENS claim",
  agent_mint: "Agent mint",
  agent_funding: "Agent funding",
  keeperhub_action: "KeeperHub",
  og_storage: "0G Storage",
  og_compute: "0G Compute",
};

const TYPE_CLASSES: Record<TransactionEntry["type"], string> = {
  coach_hint:
    "inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  game_settlement:
    "inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  ens_subname:
    "inline-flex rounded-full bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  agent_mint:
    "inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  agent_funding:
    "inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  keeperhub_action:
    "inline-flex rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  og_storage:
    "inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
  og_compute:
    "inline-flex rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
};

/** Renders a colour-coded badge for the transaction type. */
function TypeBadge({ type }: { type: TransactionEntry["type"] }) {
  return (
    <span className={TYPE_CLASSES[type] ?? TYPE_CLASSES.game_settlement}>
      {TYPE_LABELS[type] ?? type}
    </span>
  );
}

export default function TransactionsPage() {
  // SSR-safe: load from localStorage only after hydration.
  const [entries, setEntries] = useState<TransactionEntry[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setEntries(getTransactions());
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
          Transactions
        </h1>
        {/* Right spacer keeps the title visually centred. */}
        <div className="w-20" />
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          One row per billable event: on-chain gas (ENS, agent mint, settlement),
          KeeperHub workflow runs, 0G Storage uploads, and 0G Compute session
          calls.
        </p>

        {isEmpty ? (
          <div
            data-testid="transactions-empty"
            className="rounded-lg border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950"
          >
            <p className="text-sm text-zinc-400 dark:text-zinc-500">
              No transactions yet. Events appear here after registering an ENS
              subname, minting an agent, settling a game, triggering a KeeperHub
              workflow, uploading to 0G Storage, or using 0G Compute.
            </p>
          </div>
        ) : (
          <div
            data-testid="transactions-table"
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
