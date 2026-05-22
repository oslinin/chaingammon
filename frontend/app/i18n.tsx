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
    app_mode: "Mode",
    elo_mode: "Elo",
    elo_mode_desc: "Play and choose opponents for on-chain ELO settlement",
    money_mode: "Money",
    money_mode_desc: "Adds escrow stakes option when starting new games",
    advanced_mode: "Advanced",
    advanced_mode_desc: "Adds agent settings, Mint, and epoch training controls",
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
    app_mode: "Modo",
    elo_mode: "Elo",
    elo_mode_desc: "Juega y elige oponentes para liquidación ELO en cadena",
    money_mode: "Dinero",
    money_mode_desc: "Agrega opción de apuestas en custodia al iniciar nuevos juegos",
    advanced_mode: "Avanzado",
    advanced_mode_desc: "Agrega configuración de agentes, Mint y controles de entrenamiento",
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
    app_mode: "Mod",
    elo_mode: "Elo",
    elo_mode_desc: "Oyna ve zincir üstü ELO uzlaşması için rakip seç",
    money_mode: "Para",
    money_mode_desc: "Yeni oyunlara emanet bahis seçeneği ekler",
    advanced_mode: "Gelişmiş",
    advanced_mode_desc: "Ajan ayarları, Mint ve dönem eğitim kontrolleri ekler",
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
    app_mode: "Режим",
    elo_mode: "Эло",
    elo_mode_desc: "Играй и выбирай соперников для on-chain расчёта ELO",
    money_mode: "Деньги",
    money_mode_desc: "Добавляет опцию ставок через эскроу при создании игры",
    advanced_mode: "Продвинутый",
    advanced_mode_desc: "Добавляет настройки агентов, Mint и управление эпохами",
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
    app_mode: "Режим",
    elo_mode: "Ело",
    elo_mode_desc: "Грай та обирай суперників для on-chain розрахунку ELO",
    money_mode: "Гроші",
    money_mode_desc: "Додає опцію застав через ескроу при створенні гри",
    advanced_mode: "Розширений",
    advanced_mode_desc: "Додає налаштування агентів, Mint та управління епохами",
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
