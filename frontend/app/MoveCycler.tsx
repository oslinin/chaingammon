"use client";

// Compact landscape-phone move cycler. Shows the human a single gnubg-ranked
// candidate at a time (previewed on the board as ghost checkers via the
// page-level ghostMove state), with ‹ › arrows to cycle and a ✓ to commit
// the full turn. Replaces the need to open the big advisor overlay just to
// see and pick a move on a phone in landscape.
//
// Pure presenter — never calls ONNX. The page owns cycleIdx + the ghost
// state and feeds this component a controlled `index` + `candidates`.

import React from "react";
import { TagBadge } from "../lib/move_tags";
import type { TaggedCandidate } from "../lib/useTaggedCandidates";

interface Props {
  candidates: TaggedCandidate[];
  index: number;
  onIndexChange: (next: number) => void;
  onConfirm: (move: string) => void;
  disabled?: boolean;
}

const arrowBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "var(--cg-radius-sm)",
  background: "var(--cg-bg-3)",
  color: "var(--cg-fg-1)",
  border: "1px solid var(--cg-line-2)",
  fontSize: 18,
  fontWeight: 700,
  lineHeight: 1,
  display: "grid",
  placeItems: "center",
  cursor: "pointer",
  flex: "0 0 auto",
};

export function MoveCycler({ candidates, index, onIndexChange, onConfirm, disabled = false }: Props) {
  const n = candidates.length;
  if (n === 0) return null;
  const i = Math.min(Math.max(index, 0), n - 1);
  const c = candidates[i];
  const equityText = `${c.equity >= 0 ? "+" : ""}${c.equity.toFixed(3)}`;

  return (
    <div
      data-testid="move-cycler-landscape"
      className="hidden landscape:max-lg:flex fixed top-2 left-1/2 z-50 items-center gap-2 rounded-md"
      style={{
        transform: "translateX(-50%)",
        background: "var(--cg-bg-2)",
        border: "1px solid var(--cg-line-2)",
        boxShadow: "var(--cg-shadow-2)",
        padding: "4px 8px",
        opacity: disabled ? 0.6 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      <button
        type="button"
        data-testid="move-cycler-prev"
        aria-label="Previous suggested move"
        onClick={() => onIndexChange((i - 1 + n) % n)}
        style={arrowBtn}
      >
        ‹
      </button>

      <div
        data-testid="move-cycler-label"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "var(--cg-fg-1)",
          fontFamily: "var(--cg-font-sans)",
          fontSize: 11,
          lineHeight: 1.2,
          padding: "0 4px",
          minWidth: 130,
          maxWidth: 200,
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <TagBadge tag={c.tag} />
        <span
          style={{
            fontFamily: "var(--cg-font-mono)",
            color: "var(--cg-brass-hi)",
            fontWeight: 600,
          }}
        >
          {equityText}
        </span>
        <span style={{ color: "var(--cg-fg-3)" }}>
          {i + 1}/{n}
          {i === 0 ? " · best" : ""}
        </span>
      </div>

      <button
        type="button"
        data-testid="move-cycler-next"
        aria-label="Next suggested move"
        onClick={() => onIndexChange((i + 1) % n)}
        style={arrowBtn}
      >
        ›
      </button>

      <button
        type="button"
        data-testid="move-cycler-confirm"
        aria-label="Play this move"
        onClick={() => onConfirm(c.move)}
        style={{
          ...arrowBtn,
          width: 38,
          background: "var(--cg-brass)",
          color: "var(--cg-brass-ink)",
          border: "none",
          boxShadow: "var(--cg-shadow-1)",
          fontWeight: 800,
          fontSize: 16,
        }}
      >
        ✓
      </button>
    </div>
  );
}
