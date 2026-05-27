"use client";

import Link from "next/link";
import { useI18n } from "./i18n";

export function HeaderLinks() {
  const { t } = useI18n();

  return (
    <>
      <Link
        href="/stages"
        className="cg-nav-link"
        style={{
          fontSize: 13,
          textDecoration: "none",
          fontFamily: "var(--cg-font-sans)",
          padding: "4px 8px",
          borderRadius: "var(--cg-radius-sm)",
        }}
      >
        Stages
      </Link>
      <Link
        href="/help"
        target="_blank"
        rel="noreferrer"
        className="cg-nav-link"
        style={{
          fontSize: 13,
          textDecoration: "none",
          fontFamily: "var(--cg-font-sans)",
          padding: "4px 8px",
          borderRadius: "var(--cg-radius-sm)",
        }}
      >
        {t("help")}
      </Link>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("open-settings"))}
        className="cg-nav-link"
        style={{
          fontSize: 13,
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--cg-font-sans)",
          padding: "4px 8px",
          borderRadius: "var(--cg-radius-sm)",
        }}
      >
        {t("settings")}
      </button>
    </>
  );
}
