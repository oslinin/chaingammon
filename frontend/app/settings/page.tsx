"use client";

import { useEffect, useState } from "react";
import { useI18n, LANGUAGES, Language } from "../i18n";
import { BoardThemePicker } from "../BoardThemePicker";
import { loadTheme, saveTheme, type BoardThemeKey } from "../boardThemes";

export default function SettingsPage() {
  const { language, setLanguage, t } = useI18n();
  const [boardTheme, setBoardTheme] = useState<BoardThemeKey>("walnut");
  const [trainerMode, setTrainerMode] = useState<string>("round_robin");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setBoardTheme(loadTheme());
    const savedTrainerMode = localStorage.getItem("trainer_mode");
    if (savedTrainerMode === "round_robin" || savedTrainerMode === "challenge") {
      setTrainerMode(savedTrainerMode);
    }
  }, []);

  const handleTrainerModeChange = (mode: string) => {
    setTrainerMode(mode);
    localStorage.setItem("trainer_mode", mode);
  };

  if (!mounted) {
    return null; // Avoid hydration mismatch
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-8 text-2xl font-semibold text-zinc-100" style={{ fontFamily: "var(--cg-font-display)" }}>
        {t("settings")}
      </h1>

      <div className="space-y-8">
        {/* Language Selection */}
        <section>
          <h2 className="mb-4 text-sm font-semibold tracking-wider text-zinc-400 uppercase">
            {t("language")}
          </h2>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            className="w-full max-w-xs rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 focus:border-zinc-700 focus:outline-none focus:ring-1 focus:ring-zinc-700"
          >
            {(Object.entries(LANGUAGES) as [Language, string][]).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </section>

        {/* Board Theme Selection */}
        <section>
          <h2 className="mb-4 text-sm font-semibold tracking-wider text-zinc-400 uppercase">
            {t("board_theme")}
          </h2>
          <BoardThemePicker
            value={boardTheme}
            onChange={(k) => {
              setBoardTheme(k);
              saveTheme(k);
            }}
          />
        </section>

        {/* Trainer Mode Selection */}
        <section>
          <h2 className="mb-4 text-sm font-semibold tracking-wider text-zinc-400 uppercase">
            {t("trainer_mode")}
          </h2>
          <div className="space-y-3">
            <label className="flex items-center gap-3 text-sm text-zinc-300">
              <input
                type="radio"
                name="trainer_mode"
                value="round_robin"
                checked={trainerMode === "round_robin"}
                onChange={() => handleTrainerModeChange("round_robin")}
                className="h-4 w-4 border-zinc-700 bg-zinc-900 text-zinc-100 focus:ring-zinc-700 focus:ring-offset-zinc-900"
              />
              {t("round_robin")}
            </label>
            <label className="flex items-center gap-3 text-sm text-zinc-300">
              <input
                type="radio"
                name="trainer_mode"
                value="challenge"
                checked={trainerMode === "challenge"}
                onChange={() => handleTrainerModeChange("challenge")}
                className="h-4 w-4 border-zinc-700 bg-zinc-900 text-zinc-100 focus:ring-zinc-700 focus:ring-offset-zinc-900"
              />
              {t("challenge_trainer")}
            </label>
          </div>
        </section>
      </div>
    </main>
  );
}
