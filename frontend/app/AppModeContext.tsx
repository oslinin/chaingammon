// AppModeContext — global mode toggle persisted to localStorage.
//
// Three modes progressively unlock UI features:
//   elo      (default) — standard on-chain ELO settlement, no staking or agent tools
//   money               — adds escrow stakes option when starting a new game
//   advanced            — adds Mint chip, Train chip, and ComputeBackendsPill agent settings
"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type AppMode = "elo" | "money" | "advanced";

interface AppModeContextValue {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  hydrated: boolean;
}

const AppModeContext = createContext<AppModeContextValue>({
  mode: "elo",
  setMode: () => {},
  hydrated: false,
});

export const APP_MODE_KEY = "chaingammon.appMode";

export function AppModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<AppMode>("elo");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(APP_MODE_KEY) as AppMode;
    if (saved === "elo" || saved === "money" || saved === "advanced") {
      setModeState(saved);
    }
    setHydrated(true);
  }, []);

  const setMode = (newMode: AppMode) => {
    setModeState(newMode);
    localStorage.setItem(APP_MODE_KEY, newMode);
  };

  return (
    <AppModeContext.Provider value={{ mode, setMode, hydrated }}>
      {children}
    </AppModeContext.Provider>
  );
}

export function useAppMode() {
  return useContext(AppModeContext);
}
