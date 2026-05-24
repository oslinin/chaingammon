"use client";

import { useEffect, useState } from "react";
import { useI18n, LANGUAGES, Language } from "./i18n";
import { BoardThemePicker } from "./BoardThemePicker";
import { loadTheme, saveTheme, loadPrefer3d, savePrefer3d, type BoardThemeKey } from "./boardThemes";
import { useAppMode, type AppMode } from "./AppModeContext";

export function SettingsModal() {
  const [open, setOpen] = useState(false);
  const [boardTheme, setBoardTheme] = useState<BoardThemeKey>("walnut");
  const [prefer3d, setPrefer3d] = useState(false);
  const [trainerMode, setTrainerMode] = useState<string>("round_robin");
  const [mounted, setMounted] = useState(false);
  const { language, setLanguage, t } = useI18n();
  const { mode, setMode } = useAppMode();

  useEffect(() => {
    setMounted(true);
    setBoardTheme(loadTheme());
    setPrefer3d(loadPrefer3d());
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
              onChange={(k) => {
                setBoardTheme(k);
                saveTheme(k);
                window.dispatchEvent(new CustomEvent("board-theme-change", { detail: k }));
              }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 12, color: "var(--cg-fg-2)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={prefer3d}
                onChange={(e) => {
                  setPrefer3d(e.target.checked);
                  savePrefer3d(e.target.checked);
                  window.dispatchEvent(new CustomEvent("prefer-3d-change", { detail: e.target.checked }));
                }}
                style={{ width: 14, height: 14 }}
              />
              3D perspective
            </label>
          </section>

          {/* App mode */}
          <section>
            <h3 style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--cg-fg-3)", marginBottom: 12 }}>
              {t("app_mode")}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {([
                { value: "elo" as AppMode, label: t("elo_mode"), desc: t("elo_mode_desc") },
                { value: "money" as AppMode, label: t("money_mode"), desc: t("money_mode_desc") },
                { value: "advanced" as AppMode, label: t("advanced_mode"), desc: t("advanced_mode_desc") },
              ]).map(({ value, label, desc }) => (
                <label key={value} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, color: "var(--cg-fg-2)", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="app_mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    style={{ marginTop: 3, flexShrink: 0 }}
                  />
                  <span>
                    <span style={{ fontWeight: 600, color: "var(--cg-fg-1)" }}>{label}</span>
                    <span style={{ display: "block", fontSize: 12, color: "var(--cg-fg-3)", marginTop: 2 }}>{desc}</span>
                  </span>
                </label>
              ))}
            </div>
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
