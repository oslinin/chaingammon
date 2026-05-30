"use client";

// Felt-and-brass player status card shown above (or beside) the board.
// Active player (on roll) gets a brass border + warm glow tint; idle player
// stays muted. Stats line is monospace for clean alignment of numbers.

import React from "react";

interface Props {
  side: 0 | 1;
  name: string;
  /** Optional ELO — opponent ELO comes from on-chain `agentElo`. */
  elo?: number | bigint;
  pip: number;
  off: number;
  onRoll: boolean;
}

export function PlayerStatusCard({ side, name, elo, pip, off, onRoll }: Props) {
  const swatch = side === 0 ? "var(--cg-player-warm)" : "var(--cg-player-cool)";
  const eloText = elo === undefined ? null : typeof elo === "bigint" ? String(elo) : String(elo);

  return (
    <div
      data-testid={`player-card-${side}`}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: "var(--cg-radius)",
        background: onRoll ? "var(--cg-player-warm-glow)" : "var(--cg-bg-2)",
        border: `1px solid ${onRoll ? "var(--cg-brass)" : "var(--cg-line-2)"}`,
        transition: "background 200ms, border-color 200ms",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: `radial-gradient(circle at 35% 30%, ${swatch}, ${swatch} 55%, rgba(0,0,0,0.25))`,
          border: "1px solid rgba(0,0,0,0.25)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.35), inset 0 1px 2px rgba(255,255,255,0.25)",
          flex: "0 0 auto",
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: "var(--cg-font-display)",
              fontSize: 16,
              color: "var(--cg-fg-1)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {name}
          </span>
          {eloText !== null && (
            <span
              style={{
                fontFamily: "var(--cg-font-mono)",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--cg-brass-hi)",
                flex: "0 0 auto",
              }}
            >
              {eloText}
            </span>
          )}
        </div>
        <div
          style={{
            fontFamily: "var(--cg-font-mono)",
            fontSize: 10,
            color: "var(--cg-fg-4)",
            letterSpacing: "0.06em",
            marginTop: 1,
          }}
        >
          pip {pip} · off {off}
          {onRoll && (
            <span style={{ color: "var(--cg-brass)", marginLeft: 6 }}>· on roll</span>
          )}
        </div>
      </div>
    </div>
  );
}
