"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n, LANGUAGES, Language } from "../i18n";
import { BoardThemePicker } from "../BoardThemePicker";
import { loadTheme, saveTheme, type BoardThemeKey } from "../boardThemes";

export default function SettingsPage() {
<<<<<<< Updated upstream
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
=======
  const router = useRouter();
  const { language: contextLanguage, setLanguage: setContextLanguage, t } = useI18n();
  const [mounted, setMounted] = useState(false);

  // Local state for the form so we don't apply immediately until Save is clicked
  const [localLanguage, setLocalLanguage] = useState<Language>("en");
  const [localBoardTheme, setLocalBoardTheme] = useState<BoardThemeKey>("walnut");
  const [localTrainerMode, setLocalTrainerMode] = useState<string>("round_robin");

  useEffect(() => {
    setMounted(true);

    // Initialize local state from persisted state
    setLocalLanguage(contextLanguage);
    setLocalBoardTheme(loadTheme());

    const savedTrainerMode = localStorage.getItem("trainer_mode");
    if (savedTrainerMode === "round_robin" || savedTrainerMode === "challenge") {
      setLocalTrainerMode(savedTrainerMode);
    }
  }, [contextLanguage]);

  const handleSave = () => {
    setContextLanguage(localLanguage);
    saveTheme(localBoardTheme);
    localStorage.setItem("trainer_mode", localTrainerMode);
    router.back();
  };

  const handleClose = () => {
    router.back();
  };

  if (!mounted) {
    return null; // Avoid hydration mismatch
  }

  return (
<<<<<<< Updated upstream
    <main className="mx-auto max-w-2xl px-4 py-8">
=======
    <main className="mx-auto max-w-2xl px-4 py-8 relative">
      {/* Top right close button (X) */}
      <button
        onClick={handleClose}
        className="absolute top-8 right-4 p-2 text-zinc-400 hover:text-zinc-100 focus:outline-none"
        aria-label={t("close")}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

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
<<<<<<< Updated upstream
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
=======
            value={localLanguage}
            onChange={(e) => setLocalLanguage(e.target.value as Language)}
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
<<<<<<< Updated upstream
            value={boardTheme}
            onChange={(k) => {
              setBoardTheme(k);
              saveTheme(k);
            }}
=======
            value={localBoardTheme}
            onChange={(k) => setLocalBoardTheme(k)}
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
<<<<<<< Updated upstream
                checked={trainerMode === "round_robin"}
                onChange={() => handleTrainerModeChange("round_robin")}
=======
                checked={localTrainerMode === "round_robin"}
                onChange={() => setLocalTrainerMode("round_robin")}
                className="h-4 w-4 border-zinc-700 bg-zinc-900 text-zinc-100 focus:ring-zinc-700 focus:ring-offset-zinc-900"
              />
              {t("round_robin")}
            </label>
            <label className="flex items-center gap-3 text-sm text-zinc-300">
              <input
                type="radio"
                name="trainer_mode"
                value="challenge"
<<<<<<< Updated upstream
                checked={trainerMode === "challenge"}
                onChange={() => handleTrainerModeChange("challenge")}
=======
                checked={localTrainerMode === "challenge"}
                onChange={() => setLocalTrainerMode("challenge")}
                className="h-4 w-4 border-zinc-700 bg-zinc-900 text-zinc-100 focus:ring-zinc-700 focus:ring-offset-zinc-900"
              />
              {t("challenge_trainer")}
            </label>
          </div>
        </section>

        {/* Action Buttons */}
        <div className="flex justify-end gap-4 pt-6 border-t border-zinc-800">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 focus:outline-none"
          >
            {t("close")}
          </button>
          <button
            onClick={handleSave}
            className="rounded bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-white focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 focus:ring-offset-zinc-900"
          >
            {t("save")}
          </button>
        </div>
      </div>
    </main>
  );
}
