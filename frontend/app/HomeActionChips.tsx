// HomeActionChips — action chip bar on the home page.
//
// Chips shown per mode:
//   elo      (default) — Off-chain game, On-chain game
//   money               — same as elo (stake option appears on the /match page)
//   advanced            — Mint, Train, Off-chain game, On-chain game
"use client";

import Link from "next/link";
import { useAppMode } from "./AppModeContext";
import { useI18n } from "./i18n";

export function HomeActionChips() {
  const { mode } = useAppMode();
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {mode === "advanced" && (
        <>
          <Link href="/create-agent" className="cg-chip cg-chip-gold">{t("chip_mint")}</Link>
          <Link href="/training" className="cg-chip cg-chip-muted">{t("chip_train")}</Link>
          <Link href="/tournament" className="cg-chip cg-chip-warm">{t("chip_tournament")}</Link>
        </>
      )}
      <Link href="/team-demo" className="cg-chip cg-chip-muted">{t("chip_offchain")}</Link>
      <Link href="/team-demo?settle=1" className="cg-chip cg-chip-warm">{t("chip_onchain")}</Link>
    </div>
  );
}
