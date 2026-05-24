"use client";

import Link from "next/link";
import { useAccount, useReadContract } from "wagmi";

import { AgentsList } from "./AgentsList";
import { DiscoveryList } from "./DiscoveryList";
import { FindHumanButton } from "./FindHumanButton";
import { HomeActionChips } from "./HomeActionChips";
import { useAppMode } from "./AppModeContext";
import { useI18n } from "./i18n";
import { MatchRegistryABI, useChainContracts } from "./contracts";
import { useActiveChainId } from "./chains";

// ── Elo homepage glyphs ──────────────────────────────────────────────────────
function DiceGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <rect x="3"  y="7"  width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="10" y="3"  width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="6.5"  cy="10.5" r="1" fill="currentColor" />
      <circle cx="10.5" cy="14.5" r="1" fill="currentColor" />
      <circle cx="15.5" cy="6.5"  r="1" fill="currentColor" />
      <circle cx="15.5" cy="10.5" r="1" fill="currentColor" />
    </svg>
  );
}
function CheckerGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </svg>
  );
}
function CoinGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4"
            fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

interface ActionCardProps {
  variant: "primary" | "secondary";
  glyph: React.ReactNode;
  label: string;
  sublabel: string;
  meta: string;
  href: string;
}

function ActionCard({ variant, glyph, label, sublabel, meta, href }: ActionCardProps) {
  const primary = variant === "primary";
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "20px 18px",
        borderRadius: "var(--cg-radius)",
        background: primary ? "var(--cg-brass)" : "var(--cg-bg-2)",
        border: primary ? "1px solid var(--cg-brass-hi)" : "1px solid var(--cg-line-2)",
        color: primary ? "var(--cg-brass-ink)" : "var(--cg-fg-1)",
        textDecoration: "none",
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 44, height: 44,
        borderRadius: "var(--cg-radius-sm)",
        background: primary ? "var(--cg-brass-ink)" : "var(--cg-bg-0)",
        border: primary ? "1px solid rgba(26,18,8,0.6)" : "1px solid var(--cg-line-2)",
        color: "var(--cg-brass)",
        flexShrink: 0,
      }}>
        {glyph}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" as const }}>
          <span style={{
            fontFamily: "var(--cg-font-sans)",
            fontSize: 20, fontWeight: 600,
            letterSpacing: "-0.01em", lineHeight: 1,
          }}>{label}</span>
          <span style={{
            fontFamily: "var(--cg-font-mono)",
            fontSize: 11, fontWeight: 500,
            letterSpacing: "0.04em",
            color: primary ? "rgba(26,18,8,0.65)" : "var(--cg-fg-3)",
          }}>{meta}</span>
        </span>
        <span style={{
          fontFamily: "var(--cg-font-sans)",
          fontSize: 12, fontWeight: 400, lineHeight: 1.4,
          color: primary ? "rgba(26,18,8,0.72)" : "var(--cg-fg-3)",
        }}>{sublabel}</span>
      </span>
      <span style={{
        fontFamily: "var(--cg-font-mono)", fontSize: 18, lineHeight: 1,
        color: primary ? "var(--cg-brass-ink)" : "var(--cg-fg-3)",
        flexShrink: 0,
      }}>→</span>
    </Link>
  );
}

function EloHome() {
  const { address } = useAccount();
  const { matchRegistry } = useChainContracts();
  const chainId = useActiveChainId();
  const { setMode } = useAppMode();

  const { data: chainEloRaw } = useReadContract({
    address: matchRegistry,
    abi: MatchRegistryABI,
    functionName: "humanElo",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: !!address, refetchInterval: 10000 },
  });
  const elo = chainEloRaw != null ? String(chainEloRaw) : undefined;

  return (
    <div style={{
      flex: 1,
      background: [
        "radial-gradient(circle at 18% 10%, rgba(227,183,121,0.05) 0, transparent 45%)",
        "radial-gradient(circle at 84% 92%, rgba(201,155,92,0.03) 0, transparent 50%)",
        "var(--cg-bg-0)",
      ].join(", "),
      display: "flex",
      flexDirection: "column",
    }}>
      <div style={{
        maxWidth: 412, width: "100%",
        margin: "0 auto",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--cg-line-1)",
        borderRight: "1px solid var(--cg-line-1)",
      }}>
        {/* Hero */}
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          gap: 18, padding: "40px 16px 28px",
        }}>
          <span style={{
            fontFamily: "var(--cg-font-sans)",
            fontSize: 11, fontWeight: 500,
            letterSpacing: "0.22em", textTransform: "uppercase" as const,
            color: "var(--cg-fg-3)",
          }}>Elo mode</span>

          <img
            src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chaingammon-icon.svg`}
            alt=""
            width={84} height={84}
            style={{ display: "block" }}
          />

          <h1 style={{
            margin: 0,
            fontFamily: "var(--cg-font-display)",
            fontSize: 44, fontWeight: 400,
            lineHeight: 1, letterSpacing: "-0.02em",
            display: "inline-flex", alignItems: "baseline",
          }}>
            <span style={{ color: "var(--cg-fg-2)", fontStyle: "italic" }}>Chain</span>
            <span style={{ color: "var(--cg-brass)", padding: "0 0.05em" }}>·</span>
            <span style={{ color: "var(--cg-fg-1)" }}>Gammon</span>
          </h1>

          {elo && (
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 10,
              padding: "8px 14px",
              borderRadius: "var(--cg-radius-pill)",
              background: "rgba(201,155,92,0.10)",
              border: "1px solid rgba(201,155,92,0.35)",
            }}>
              <span style={{
                fontFamily: "var(--cg-font-sans)",
                fontSize: 10, fontWeight: 500,
                letterSpacing: "0.18em", textTransform: "uppercase" as const,
                color: "var(--cg-brass-hi)",
              }}>ELO</span>
              <span style={{
                fontFamily: "var(--cg-font-mono)",
                fontSize: 20, fontWeight: 600,
                color: "var(--cg-fg-1)", lineHeight: 1,
              }}>{elo}</span>
            </div>
          )}
        </div>

        {/* CTAs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 16px 24px" }}>
          <ActionCard
            variant="secondary"
            glyph={<DiceGlyph />}
            label="Train"
            meta="UNRATED"
            sublabel="Practice vs. bot · no Elo change"
            href="/team-demo?opponents=4"
          />
          <ActionCard
            variant="primary"
            glyph={<CheckerGlyph />}
            label="Play"
            meta="RATED"
            sublabel="Matchmake by Elo · no stake"
            href="/match"
          />
          <ActionCard
            variant="secondary"
            glyph={<CoinGlyph />}
            label="Play ($)"
            meta="STAKE"
            sublabel="Wagered match · winner takes pot"
            href="/match?stake=1"
          />
        </div>

        <div style={{ flex: 1 }} />

        {/* Footer */}
        <div style={{
          padding: "16px",
          borderTop: "1px solid var(--cg-line-1)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12,
        }}>
          <span style={{
            fontFamily: "var(--cg-font-mono)",
            fontSize: 10, color: "var(--cg-fg-4)",
            letterSpacing: "0.04em",
          }}>7-pt · single cube · 30s/move</span>
          <button
            onClick={() => setMode("advanced")}
            style={{
              fontFamily: "var(--cg-font-sans)",
              fontSize: 11, fontWeight: 500,
              color: "var(--cg-brass)",
              letterSpacing: "0.04em",
              background: "none", border: "none", cursor: "pointer", padding: 0,
            }}
          >
            Advanced ↗
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const { t } = useI18n();
  const { mode, hydrated } = useAppMode();

  if (!hydrated) return null;

  if (mode === "elo") {
    return <EloHome />;
  }

  return (
    <div style={{ display: "flex", flex: 1, flexDirection: "column", background: "var(--cg-bg-0)" }}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-10 sm:px-8 sm:py-16">

        {/* Hero */}
        <div className="flex flex-col gap-5 cg-fade-up">
          {/* Eyebrow */}
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            fontFamily: "var(--cg-font-sans)",
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "var(--cg-brass)",
          }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: "var(--cg-brass)",
              boxShadow: "0 0 10px rgba(201,155,92,0.7)",
              flexShrink: 0,
            }} />
            {t("hero_eyebrow")}
          </div>

          <h1 style={{
            fontFamily: "var(--cg-font-display)",
            fontWeight: 400,
            fontSize: "clamp(34px, 6vw, 56px)",
            lineHeight: 1.08,
            letterSpacing: "-0.02em",
            color: "var(--cg-fg-1)",
            margin: 0,
            maxWidth: "min(640px, 100%)",
          }}>
            {t("hero_line1")}<br />
            <span style={{ color: "var(--cg-fg-2)", fontStyle: "italic" }}>{t("hero_line2_italic")}</span>
            <span style={{ color: "var(--cg-brass)" }}>{t("hero_line2_end")}</span>
          </h1>

          <p className="cg-fade-up-1" style={{ maxWidth: 500, fontSize: 15, lineHeight: 1.65, color: "var(--cg-fg-2)", margin: 0 }}>
            Every match settles on 0G Chain and updates your portable ENS
            reputation at{" "}
            <code style={{ fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-1)", fontSize: 13 }}>
              &lt;name&gt;.chaingammon.eth
            </code>
            . AI agents are NFTs — their skill persists on-chain.
          </p>
        </div>

        {/* Agents section */}
        <section className="flex flex-col gap-4 cg-fade-up-2">
          <div style={{ borderTop: "1px solid var(--cg-line-1)", paddingTop: 24 }}>
            <div className="flex items-baseline gap-3 flex-wrap" style={{ marginBottom: 16 }}>
              <div style={{
                fontFamily: "var(--cg-font-sans)",
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "var(--cg-fg-3)",
              }}>
                {t("live_agents")}
              </div>
              <HomeActionChips />
            </div>
          </div>
          <AgentsList />
        </section>

        <section className="flex flex-col gap-4 cg-fade-up-3">
          <FindHumanButton />
          <DiscoveryList playersOnly />
        </section>

        <Link
          href="/transactions"
          style={{ fontSize: 13, color: "var(--cg-fg-4)", textDecoration: "none" }}
        >
          {t("transactions")}
        </Link>
      </main>
    </div>
  );
}
