// Transaction ledger stored in localStorage.
//
// Records one entry per billable event — on-chain gas, 0G Storage uploads,
// 0G Compute session calls, and KeeperHub workflow executions:
//   - coach_hint        — hint served by 0G Compute (Qwen 2.5 7B Instruct)
//   - game_settlement   — on-chain match settlement via KeeperHub + 0G Chain
//   - ens_subname       — ENS subname claimed via selfMintSubname on-chain
//   - agent_mint        — iNFT agent minted via mintAgent on-chain
//   - agent_funding     — native token transfer to an agent-managed wallet
//   - keeperhub_action  — KeeperHub workflow trigger or automation run
//   - og_storage        — 0G Storage blob upload (agent weights, match archive)
//   - og_compute        — 0G Compute session call (inference, training step)
//
// The ledger is append-only and client-local; it is not synced anywhere.
// Entries are stored newest-first so the Transactions page renders them in
// insertion order without sorting.

/** A single billable event entry. */
export interface TransactionEntry {
  /** Collision-resistant id: `${Date.now()}-${random}`. */
  id: string;
  /** ISO 8601 UTC timestamp of when the charge was incurred. */
  timestamp: string;
  /** Category of the transaction. */
  type:
    | "coach_hint"
    | "game_settlement"
    | "ens_subname"
    | "agent_mint"
    | "agent_funding"
    | "keeperhub_action"
    | "og_storage"
    | "og_compute";
  /** Human-readable summary shown in the Transactions ledger. */
  description: string;
}

const STORAGE_KEY = "chaingammon_transactions";
const LEGACY_KEY = "chaingammon_expenses";

/**
 * Read all transaction entries from localStorage.
 * SSR-safe: returns [] on the server where `window` is undefined.
 * Migrates legacy "chaingammon_expenses" key on first read.
 */
export function getTransactions(): TransactionEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as TransactionEntry[];

    // One-time migration from the old key.
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const entries = JSON.parse(legacy) as TransactionEntry[];
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      window.localStorage.removeItem(LEGACY_KEY);
      return entries;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Prepend a new transaction entry to the ledger and persist it.
 * Callers supply `type` and `description`; `id` and `timestamp` are
 * generated here so callers don't have to produce them.
 *
 * @returns The fully-constructed entry (including generated id + timestamp).
 */
export function recordTransaction(
  entry: Omit<TransactionEntry, "id" | "timestamp">,
): TransactionEntry {
  const full: TransactionEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  const current = getTransactions();
  current.unshift(full); // newest first
  // Cap at 100 entries so localStorage doesn't grow unboundedly.
  if (current.length > 100) current.length = 100;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  return full;
}
