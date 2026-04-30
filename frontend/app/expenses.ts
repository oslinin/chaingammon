// Lightweight 0G-token expense ledger stored in localStorage.
//
// Records one entry per event that charges 0G tokens:
//   - coach_hint  — hint served by 0G Compute (Qwen 2.5 7B Instruct)
//   - game_settlement — on-chain match settlement via KeeperHub + 0G Chain
//
// The ledger is append-only and client-local; it is not synced anywhere.
// Entries are stored newest-first so the Expenses page can render them in
// insertion order without sorting.

/** A single 0G-token spending event. */
export interface ExpenseEntry {
  /** Collision-resistant id: `${Date.now()}-${random}`. */
  id: string;
  /** ISO 8601 UTC timestamp of when the charge was incurred. */
  timestamp: string;
  /** Category of the spending event. */
  type: "coach_hint" | "game_settlement";
  /** Human-readable summary shown in the Expenses ledger. */
  description: string;
}

const STORAGE_KEY = "chaingammon_expenses";

/**
 * Read all expense entries from localStorage.
 * SSR-safe: returns [] on the server where `window` is undefined.
 */
export function getExpenses(): ExpenseEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ExpenseEntry[];
  } catch {
    return [];
  }
}

/**
 * Prepend a new expense entry to the ledger and persist it.
 * Callers supply `type` and `description`; `id` and `timestamp` are
 * generated here so callers don't have to produce them.
 *
 * @returns The fully-constructed entry (including generated id + timestamp).
 */
export function recordExpense(
  entry: Omit<ExpenseEntry, "id" | "timestamp">,
): ExpenseEntry {
  const full: ExpenseEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  const current = getExpenses();
  current.unshift(full); // newest first
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  return full;
}
