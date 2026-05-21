"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type Language = "en" | "es" | "tr" | "ru" | "uk";

export const LANGUAGES: Record<Language, string> = {
  en: "English",
  es: "Spanish",
  tr: "Turkish",
  ru: "Russian",
  uk: "Ukrainian",
};

const DICTIONARY: Record<Language, Record<string, string>> = {
  en: {
    home: "Home",
    play: "Play",
    help: "Help",
    settings: "Settings",
    language: "Language",
    board_theme: "Board Theme",
    trainer_mode: "Trainer Mode",
    round_robin: "Round Robin",
    challenge_trainer: "Challenge Trainer",
  },
  es: {
    home: "Inicio",
    play: "Jugar",
    help: "Ayuda",
    settings: "Ajustes",
    language: "Idioma",
    board_theme: "Tema del Tablero",
    trainer_mode: "Modo Entrenador",
    round_robin: "Round Robin",
    challenge_trainer: "Entrenador de Retos",
  },
  tr: {
    home: "Ana Sayfa",
    play: "Oyna",
    help: "Yardım",
    settings: "Ayarlar",
    language: "Dil",
    board_theme: "Tahta Teması",
    trainer_mode: "Eğitmen Modu",
    round_robin: "Round Robin",
    challenge_trainer: "Meydan Okuma Eğitmeni",
  },
  ru: {
    home: "Главная",
    play: "Играть",
    help: "Помощь",
    settings: "Настройки",
    language: "Язык",
    board_theme: "Тема доски",
    trainer_mode: "Режим тренера",
    round_robin: "Круговой турнир",
    challenge_trainer: "Тренер-челлендж",
  },
  uk: {
    home: "Головна",
    play: "Грати",
    help: "Допомога",
    settings: "Налаштування",
    language: "Мова",
    board_theme: "Тема дошки",
    trainer_mode: "Режим тренера",
    round_robin: "Круговий турнір",
    challenge_trainer: "Тренер-челендж",
  },
};

interface I18nContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  language: "en",
  setLanguage: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("en");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem("app_language") as Language;
    if (saved && LANGUAGES[saved]) {
      setLanguageState(saved);
    }
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem("app_language", lang);
  };

  const t = (key: string) => {
    const translation = DICTIONARY[language]?.[key] || DICTIONARY["en"]?.[key] || key;
    return translation;
  };

  // If not mounted yet, render children with default English to prevent hydration mismatch
  if (!mounted) {
    return (
      <I18nContext.Provider value={{ language: "en", setLanguage, t }}>
        {children}
      </I18nContext.Provider>
    );
  }

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
