"use client";

import { useEffect, useState } from "react";
import { useI18n, LANGUAGES, Language } from "./i18n";
import { BoardThemePicker } from "./BoardThemePicker";
import { loadTheme, saveTheme, type BoardThemeKey } from "./boardThemes";

export function SettingsModal() {
  const [open, setOpen] = useState(false);
  const [boardTheme, setBoardTheme] = useState<BoardThemeKey>("walnut");
  const [trainerMode, setTrainerMode] = useState<string>("round_robin");
  const [mounted, setMounted] = useState(false);
  const { language, setLanguage, t } = useI18n();

  useEffect(() => {
    setMounted(true);
    setBoardTheme(loadTheme());
    const saved = localStorage.getItem("trainer_mode");
    if (saved === "round_robin" || saved === "challenge") setTrainerMode(saved);

    const handler = () => setOpen(true);
    window.addEventListener("open-settings", handler);
    return () => window.removeEventListener("open-settings", handler);
  }, []);

  if (!mounted || !open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-end",
      }}
    >
      {/* backdrop */}
      <div
        onClick={() => setOpen(false)}
        style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)" }}
      />
      {/* panel */}
      <div
        style={{
          position: "relative",
          width: "min(420px, 100vw)",
          height: "100dvh",
          background: "var(--cg-bg-2, #1a1612)",
          borderLeft: "1px solid var(--cg-line-1)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px 16px" }}>
          <h2 style={{ fontFamily: "var(--cg-font-display)", fontSize: 20, fontWeight: 600, color: "var(--cg-fg-1)", margin: 0 }}>
            {t("settings")}
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close settings"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--cg-fg-3)", padding: 4, borderRadius: 6, lineHeight: 0 }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={{ padding: "0 24px 32px", display: "flex", flexDirection: "column", gap: 32 }}>
          {/* Language */}
          <section>
            <h3 style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--cg-fg-3)", marginBottom: 12 }}>
              {t("language")}
            </h3>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              style={{ width: "100%", maxWidth: 280, borderRadius: 6, border: "1px solid var(--cg-line-2)", background: "var(--cg-bg-1)", padding: "6px 10px", fontSize: 13, color: "var(--cg-fg-2)" }}
            >
              {(Object.entries(LANGUAGES) as [Language, string][]).map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </section>

          {/* Board theme */}
          <section>
            <h3 style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--cg-fg-3)", marginBottom: 12 }}>
              {t("board_theme")}
            </h3>
            <BoardThemePicker
              value={boardTheme}
              onChange={(k) => { setBoardTheme(k); saveTheme(k); }}
            />
          </section>

          {/* Trainer mode */}
          <section>
            <h3 style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--cg-fg-3)", marginBottom: 12 }}>
              {t("trainer_mode")}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { value: "round_robin", label: t("round_robin") },
                { value: "challenge", label: t("challenge_trainer") },
              ].map(({ value, label }) => (
                <label key={value} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--cg-fg-2)", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="trainer_mode"
                    value={value}
                    checked={trainerMode === value}
                    onChange={() => { setTrainerMode(value); localStorage.setItem("trainer_mode", value); }}
                  />
                  {label}
                </label>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
