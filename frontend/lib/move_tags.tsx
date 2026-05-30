// Shared move-tag UI used by both the AgentTeammatePanel chip list and the
// landscape MoveCycler so the two surfaces never drift on category colors.
// Single source of truth for TAG_COLORS + TagBadge — formerly lived inside
// ChiefOfStaffPanel.tsx.

import React from "react";

export type MoveTag = "Safe" | "Aggressive" | "Priming" | "Anchor" | "Blitz";

export const TAG_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  Safe:       { bg: "rgba(125,155,74,0.12)",  text: "#7D9B4A", border: "rgba(125,155,74,0.35)" },
  Aggressive: { bg: "rgba(208,138,60,0.12)",  text: "#D08A3C", border: "rgba(208,138,60,0.35)" },
  Priming:    { bg: "rgba(232,192,126,0.12)", text: "#F4D49A", border: "rgba(232,192,126,0.35)" },
  Anchor:     { bg: "rgba(107,138,166,0.12)", text: "#6B8AA6", border: "rgba(107,138,166,0.35)" },
  Blitz:      { bg: "rgba(192,74,59,0.12)",   text: "#C04A3B", border: "rgba(192,74,59,0.35)" },
};

export function TagBadge({ tag }: { tag: string }) {
  const c = TAG_COLORS[tag] ?? TAG_COLORS.Safe;
  return (
    <span
      style={{
        display: "inline-block",
        borderRadius: "var(--cg-radius-sm)",
        padding: "1px 6px",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        background: c.bg,
        color: c.text,
        border: `1px solid ${c.border}`,
      }}
    >
      {tag}
    </span>
  );
}
