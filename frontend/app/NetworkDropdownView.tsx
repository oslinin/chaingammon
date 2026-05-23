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
import { useI18n } from "./i18n";

interface Props {
  activeChainId: number;
  selectableChains: ChainEntry[];
  isPending?: boolean;
  error?: string | null;
  onSwitch: (chainId: number) => void;
}

export function NetworkDropdownView({
  activeChainId,
  selectableChains,
  isPending = false,
  error = null,
  onSwitch,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const activeEntry = selectableChains.find((c) => c.chain.id === activeChainId);
  const onWrongChain = !activeEntry;

  let triggerLabel: string;
  if (isPending) triggerLabel = t("switching");
  else if (onWrongChain) triggerLabel = t("wrong_network");
  else triggerLabel = activeEntry.chain.name;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <button
        type="button"
        data-testid="network-dropdown-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={isPending}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          height: 32,
          borderRadius: "var(--cg-radius-pill)",
          padding: "0 12px",
          fontSize: 12,
          fontWeight: 500,
          fontFamily: "var(--cg-font-sans)",
          cursor: isPending ? "not-allowed" : "pointer",
          opacity: isPending ? 0.6 : 1,
          transition: "background 120ms, border-color 120ms",
          border: onWrongChain
            ? "1px solid var(--cg-warn)"
            : "1px solid var(--cg-line-2)",
          background: onWrongChain
            ? "rgba(208,138,60,0.12)"
            : "transparent",
          color: onWrongChain ? "var(--cg-warn)" : "var(--cg-fg-2)",
        }}
      >
        {triggerLabel}
        <span aria-hidden style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <ul
          data-testid="network-dropdown-menu"
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            zIndex: 50,
            marginTop: 4,
            minWidth: "12rem",
            overflow: "hidden",
            borderRadius: "var(--cg-radius)",
            border: "1px solid var(--cg-line-2)",
            background: "var(--cg-bg-2)",
            boxShadow: "var(--cg-shadow-2)",
            listStyle: "none",
            padding: 0,
            margin: 0,
          }}
        >
          {selectableChains.map((entry) => {
            const isActive = entry.chain.id === activeChainId;
            return (
              <li key={entry.chain.id}>
                <button
                  type="button"
                  role="menuitem"
                  data-active={isActive ? "true" : "false"}
                  onClick={() => { onSwitch(entry.chain.id); setOpen(false); }}
                  style={{
                    display: "flex",
                    width: "100%",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 12px",
                    textAlign: "left",
                    fontSize: 13,
                    fontFamily: "var(--cg-font-sans)",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: isActive ? "var(--cg-fg-1)" : "var(--cg-fg-2)",
                    fontWeight: isActive ? 600 : 400,
                    transition: "background 120ms",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--cg-bg-3)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                >
                  <span aria-hidden style={{ width: 12, color: "var(--cg-brass)" }}>
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
        <span style={{ fontSize: 11, color: "var(--cg-danger)" }}>{error}</span>
      )}
    </div>
  );
}
