"use client";

import Link from "next/link";
import { useI18n } from "./i18n";

// Next.js's <Link> auto-prepends the configured basePath (e.g. "/chaingammon"
// on GitHub Pages); a plain <a href="/agent/1"> would resolve to the apex
// path and 404. Keep all internal navigation on <Link>.

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
  const { t } = useI18n();
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
        transition: "border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.borderColor = "var(--cg-line-3)";
        el.style.boxShadow = "var(--cg-shadow-2)";
        el.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.borderColor = "var(--cg-line-2)";
        el.style.boxShadow = "var(--cg-shadow-1)";
        el.style.transform = "";
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
            <Link
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
              {t("info")}
            </Link>
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
            {t("reading_chain")}
          </p>
        ) : matchSummary === null ? null : (
          <p style={{ fontFamily: "var(--cg-font-mono)", fontSize: 12, color: "var(--cg-fg-2)" }}>
            {matchSummary.matches} {t("played")} · {matchSummary.wins} {t("won")} · {matchSummary.losses} {t("lost")}
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
          className="cg-btn-primary"
          style={{
            marginTop: 4,
            display: "block",
            borderRadius: "var(--cg-radius)",
            background: "linear-gradient(180deg, #E3B779 0%, #C99B5C 55%, #B0843E 100%)",
            color: "var(--cg-brass-ink)",
            padding: "9px 16px",
            textAlign: "center",
            fontSize: 14,
            fontWeight: 600,
            fontFamily: "var(--cg-font-sans)",
            textDecoration: "none",
            boxShadow: "0 1px 0 0 rgba(255,236,196,0.35) inset, 0 -1px 0 0 rgba(0,0,0,0.25) inset, 0 4px 12px -3px rgba(140,90,30,0.4)",
            border: "1px solid rgba(0,0,0,0.25)",
          }}
        >
          {t("play_match")}
        </Link>
      )}
    </div>
  );
}
