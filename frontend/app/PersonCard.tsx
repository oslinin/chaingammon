"use client";

import Link from "next/link";

export interface MatchSummary {
  matches: number;
  wins: number;
  losses: number;
}

export interface PersonCardProps {
  label: string;
  nameHref?: string;
  elo: bigint | string | undefined;
  balance?: string;
  matchSummary: MatchSummary | null | undefined;
  infoHref?: string;
  infoLabel?: string;
  playHref?: string;
  extraLines?: string[];
}

export function PersonCard({
  label,
  nameHref,
  elo,
  balance,
  matchSummary,
  infoHref,
  infoLabel,
  playHref,
  extraLines,
}: PersonCardProps) {
  const eloDisplay = elo !== undefined ? String(elo) : undefined;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        borderRadius: "var(--cg-radius)",
        border: "1px solid var(--cg-line-2)",
        background: "var(--cg-bg-2)",
        padding: 20,
        boxShadow: "var(--cg-shadow-1)",
      }}
    >
      {/* Header row: name + info badges */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <h3
          style={{
            fontFamily: "var(--cg-font-mono)",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--cg-fg-1)",
            wordBreak: "break-all",
            margin: 0,
          }}
        >
          {nameHref ? (
            <a
              href={nameHref}
              target="_blank"
              rel="noreferrer"
              style={{ color: "inherit", textDecoration: "none" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = "var(--cg-brass)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = "var(--cg-fg-1)"; }}
            >
              {label}
            </a>
          ) : label}
        </h3>
        <div style={{ display: "flex", flexShrink: 0, alignItems: "center", gap: 4 }}>
          {infoHref && (
            <a
              href={infoHref}
              target="_blank"
              rel="noreferrer"
              title="Open info in a new tab"
              style={{
                borderRadius: "var(--cg-radius-sm)",
                border: "1px solid var(--cg-line-2)",
                background: "var(--cg-bg-3)",
                padding: "2px 6px",
                fontSize: 11,
                fontFamily: "var(--cg-font-mono)",
                color: "var(--cg-fg-3)",
                textDecoration: "none",
                transition: "border-color 120ms, color 120ms",
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLAnchorElement;
                el.style.color = "var(--cg-fg-1)";
                el.style.borderColor = "var(--cg-line-3)";
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLAnchorElement;
                el.style.color = "var(--cg-fg-3)";
                el.style.borderColor = "var(--cg-line-2)";
              }}
            >
              Info ↗
            </a>
          )}
          {infoLabel && (
            <span
              style={{
                borderRadius: "var(--cg-radius-sm)",
                border: "1px solid var(--cg-line-2)",
                background: "var(--cg-bg-3)",
                padding: "2px 6px",
                fontSize: 11,
                fontFamily: "var(--cg-font-mono)",
                color: "var(--cg-fg-3)",
              }}
            >
              {infoLabel}
            </span>
          )}
        </div>
      </div>

      {/* ELO + balance */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--cg-fg-4)",
              fontFamily: "var(--cg-font-sans)",
            }}
          >
            ELO
          </span>
          <span
            style={{
              fontFamily: "var(--cg-font-mono)",
              fontSize: 28,
              fontWeight: 700,
              color: "var(--cg-fg-1)",
              lineHeight: 1,
            }}
          >
            {eloDisplay ?? "—"}
          </span>
        </div>
        {balance !== "" && (
          <span style={{ fontFamily: "var(--cg-font-mono)", fontSize: 13, color: "var(--cg-fg-3)" }}>
            {balance ?? "…"}
          </span>
        )}
      </div>

      {/* Match record + extra lines */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {matchSummary === undefined ? (
          <p style={{ fontFamily: "var(--cg-font-mono)", fontSize: 12, color: "var(--cg-fg-4)" }}>
            Reading chain…
          </p>
        ) : matchSummary === null ? null : (
          <p style={{ fontFamily: "var(--cg-font-mono)", fontSize: 12, color: "var(--cg-fg-2)" }}>
            {matchSummary.matches} played · {matchSummary.wins} won · {matchSummary.losses} lost
          </p>
        )}
        {extraLines?.map((line) => (
          <p key={line} style={{ fontFamily: "var(--cg-font-mono)", fontSize: 12, color: "var(--cg-fg-3)" }}>
            {line}
          </p>
        ))}
      </div>

      {/* Play button */}
      {playHref && (
        <Link
          href={playHref}
          data-testid="person-card-play-button"
          style={{
            marginTop: 4,
            display: "block",
            borderRadius: "var(--cg-radius)",
            background: "var(--cg-brass)",
            color: "var(--cg-brass-ink)",
            padding: "8px 16px",
            textAlign: "center",
            fontSize: 14,
            fontWeight: 600,
            fontFamily: "var(--cg-font-sans)",
            textDecoration: "none",
            boxShadow: "var(--cg-shadow-1)",
            transition: "background 120ms",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "var(--cg-brass-hi)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "var(--cg-brass)"; }}
        >
          Play
        </Link>
      )}
    </div>
  );
}
