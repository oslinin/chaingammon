"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useI18n } from "./i18n";

export function MobileNav() {
  const [lastAgentId, setLastAgentId] = useState<number | null>(null);
  const { t } = useI18n();
  const pathname = usePathname();

  useEffect(() => {
    const stored = window.localStorage.getItem("lastAgentId");
    if (stored) setLastAgentId(Number(stored));
  }, []);

  const playHref = lastAgentId ? `/match?agentId=${lastAgentId}` : "/match?agentId=1";

  const isHome = pathname === "/" || pathname === "";
  const isPlay = pathname.startsWith("/match") || pathname.startsWith("/team-demo") || pathname.startsWith("/training");
  const isSettings = pathname.startsWith("/settings");

  const tabColor = (active: boolean) =>
    active ? "var(--cg-brass)" : "var(--cg-fg-4)";

  return (
    <nav
      data-testid="mobile-nav"
      aria-label="Mobile navigation"
      className="md:hidden"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        height: 60,
        borderTop: "1px solid var(--cg-line-2)",
        background: "rgba(21,17,14,0.96)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      {/* Home */}
      <Link
        href="/"
        data-testid="mobile-nav-home"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
          padding: "8px 0",
          textDecoration: "none",
          color: tabColor(isHome),
          transition: "color 120ms ease",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9.5L12 3l9 6.5V21a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" />
          <path d="M9 22V12h6v10" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, fontFamily: "var(--cg-font-sans)", letterSpacing: "0.04em" }}>
          {t("home")}
        </span>
      </Link>

      {/* Play — brass circle focal point */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Link
          href={playHref}
          data-testid="mobile-nav-play"
          style={{
            width: 50,
            height: 50,
            borderRadius: "50%",
            background: "linear-gradient(180deg, #E3B779 0%, #C99B5C 55%, #B0843E 100%)",
            border: "2px solid rgba(21,17,14,0.9)",
            boxShadow: "0 1px 0 0 rgba(255,236,196,0.35) inset, 0 -1px 0 0 rgba(0,0,0,0.4) inset, 0 4px 14px -3px rgba(140,90,30,0.55)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 1,
            textDecoration: "none",
            color: "#1A1208",
            outline: isPlay ? "2px solid var(--cg-brass)" : "none",
            outlineOffset: 2,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <polygon points="4,2 14,8 4,14" />
          </svg>
          <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "var(--cg-font-sans)", letterSpacing: "0.06em" }}>
            {t("play").toUpperCase()}
          </span>
        </Link>
      </div>

      {/* Settings */}
      <Link
        href="/settings"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
          padding: "8px 0",
          textDecoration: "none",
          color: tabColor(isSettings),
          transition: "color 120ms ease",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, fontFamily: "var(--cg-font-sans)", letterSpacing: "0.04em" }}>
          {t("settings")}
        </span>
      </Link>
    </nav>
  );
}
