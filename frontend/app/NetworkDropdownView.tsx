"use client";

// Presentational component for the network dropdown.
//
// Pure props — no wagmi, no `useSwitchChain`. The wagmi-aware wrapper
// (`NetworkDropdown`) feeds it derived state. This split makes the
// rendering testable on a fixture page without standing up a mock
// wallet, and keeps the dropdown's UI logic free of side effects.
//
// `data-testid` attributes are stable selectors for Playwright. Don't
// rename without updating `frontend/tests/network-dropdown.spec.ts`.

import { useEffect, useRef, useState } from "react";

import type { ChainEntry } from "./chains";

interface Props {
  /** Active chain id from `useChainId()`. May be a chain not in
   *  `selectableChains` (e.g. mainnet); in that case the trigger
   *  shows "Wrong network". */
  activeChainId: number;
  /** Chains the user can pick from — usually `useSelectableChains()`. */
  selectableChains: ChainEntry[];
  /** True while a `switchChain` call is in flight. Disables the trigger. */
  isPending?: boolean;
  /** Optional error from the last `switchChain` attempt. */
  error?: string | null;
  /** Called when the user clicks a row. The wrapper translates this
   *  into a wagmi `switchChain({ chainId })` call. */
  onSwitch: (chainId: number) => void;
}

export function NetworkDropdownView({
  activeChainId,
  selectableChains,
  isPending = false,
  error = null,
  onSwitch,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const activeEntry = selectableChains.find(
    (c) => c.chain.id === activeChainId,
  );
  const onWrongChain = !activeEntry;

  let triggerLabel: string;
  if (isPending) {
    triggerLabel = "Switching…";
  } else if (onWrongChain) {
    triggerLabel = "Wrong network";
  } else {
    triggerLabel = activeEntry.chain.name;
  }

  const triggerClass = [
    "inline-flex h-9 items-center gap-1 rounded-full px-3 text-xs font-medium",
    "border",
    onWrongChain
      ? "border-amber-500 bg-amber-500 text-white hover:bg-amber-600"
      : "border-zinc-300 text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900",
    "disabled:opacity-60",
  ].join(" ");

  return (
    <div ref={rootRef} className="relative flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid="network-dropdown-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={isPending}
        onClick={() => setOpen((v) => !v)}
        className={triggerClass}
      >
        {triggerLabel}
        <span aria-hidden>▾</span>
      </button>

      {open && (
        <ul
          data-testid="network-dropdown-menu"
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 min-w-[12rem] overflow-hidden rounded-md border border-zinc-200 bg-white text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-950"
        >
          {selectableChains.map((entry) => {
            const isActive = entry.chain.id === activeChainId;
            return (
              <li key={entry.chain.id}>
                <button
                  type="button"
                  role="menuitem"
                  data-active={isActive ? "true" : "false"}
                  onClick={() => {
                    onSwitch(entry.chain.id);
                    setOpen(false);
                  }}
                  className={[
                    "flex w-full items-center gap-2 px-3 py-2 text-left",
                    "hover:bg-zinc-50 dark:hover:bg-zinc-900",
                    isActive
                      ? "font-semibold text-zinc-900 dark:text-zinc-50"
                      : "text-zinc-700 dark:text-zinc-300",
                  ].join(" ")}
                >
                  <span aria-hidden className="w-3">
                    {isActive ? "✓" : ""}
                  </span>
                  {entry.chain.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      )}
    </div>
  );
}
