"use client";

import Link from "next/link";
import { useI18n } from "./i18n";

export function HeaderLinks() {
  const { t } = useI18n();

  return (
    <>
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
      <Link
        href="/settings"
        target="_blank"
        rel="noopener noreferrer"
        className="cg-nav-link"
        style={{
          fontSize: 13,
          textDecoration: "none",
          fontFamily: "var(--cg-font-sans)",
          padding: "4px 8px",
          borderRadius: "var(--cg-radius-sm)",
        }}
      >
        {t("settings")}
      </Link>
    </>
  );
}
