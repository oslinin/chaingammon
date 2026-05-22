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
    // Home page
    hero_eyebrow: "Open backgammon protocol · v1",
    hero_line1: "Skill is permanent.",
    hero_line2_italic: "Now your rating is",
    hero_line2_end: ", too.",
    live_agents: "Live agents · Sepolia testnet",
    transactions: "Transactions",
    // Action chips
    chip_mint: "Mint",
    chip_train: "Train",
    chip_offchain: "Off-chain game",
    chip_onchain: "On-chain game",
    // PersonCard
    info: "Info ↗",
    reading_chain: "Reading chain…",
    played: "played",
    won: "won",
    lost: "lost",
    play_match: "Play match",
    // AgentCard
    games_trained: "games trained",
    // AgentsList
    loading_agents: "Loading agents…",
    no_agents: "No agents registered yet.",
    no_deployment: "No Chaingammon deployment on this chain",
    no_agents_found: "No agents found.",
    // DiscoveryList
    loading: "Loading…",
    players: "Players",
    no_players: "No players registered yet.",
    agents: "Agents",
    // ConnectButton
    connect_wallet: "Connect wallet",
    connecting: "Connecting…",
    disconnect: "Disconnect",
    install_metamask: "Install MetaMask",
    open_in_metamask: "Open in MetaMask",
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
    // Home page
    hero_eyebrow: "Protocolo abierto de backgammon · v1",
    hero_line1: "La habilidad es permanente.",
    hero_line2_italic: "Ahora tu reputación también",
    hero_line2_end: " lo es.",
    live_agents: "Agentes en vivo · Sepolia testnet",
    transactions: "Transacciones",
    // Action chips
    chip_mint: "Crear",
    chip_train: "Entrenar",
    chip_offchain: "Juego off-chain",
    chip_onchain: "Juego on-chain",
    // PersonCard
    info: "Info ↗",
    reading_chain: "Leyendo cadena…",
    played: "jugados",
    won: "ganados",
    lost: "perdidos",
    play_match: "Jugar partida",
    // AgentCard
    games_trained: "partidas entrenadas",
    // AgentsList
    loading_agents: "Cargando agentes…",
    no_agents: "No hay agentes registrados.",
    no_deployment: "No hay implementación de Chaingammon en esta cadena",
    no_agents_found: "No se encontraron agentes.",
    // DiscoveryList
    loading: "Cargando…",
    players: "Jugadores",
    no_players: "No hay jugadores registrados.",
    agents: "Agentes",
    // ConnectButton
    connect_wallet: "Conectar billetera",
    connecting: "Conectando…",
    disconnect: "Desconectar",
    install_metamask: "Instalar MetaMask",
    open_in_metamask: "Abrir en MetaMask",
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
    // Home page
    hero_eyebrow: "Açık tavla protokolü · v1",
    hero_line1: "Beceri kalıcıdır.",
    hero_line2_italic: "Artık reputasyonun da",
    hero_line2_end: " öyle.",
    live_agents: "Canlı ajanlar · Sepolia testnet",
    transactions: "İşlemler",
    // Action chips
    chip_mint: "Mint",
    chip_train: "Eğit",
    chip_offchain: "Zincir dışı oyun",
    chip_onchain: "Zincir üstü oyun",
    // PersonCard
    info: "Bilgi ↗",
    reading_chain: "Zincir okunuyor…",
    played: "oynandı",
    won: "kazanıldı",
    lost: "kaybedildi",
    play_match: "Maç oyna",
    // AgentCard
    games_trained: "eğitilen oyun",
    // AgentsList
    loading_agents: "Ajanlar yükleniyor…",
    no_agents: "Henüz ajan kayıtlı değil.",
    no_deployment: "Bu zincirde Chaingammon dağıtımı yok",
    no_agents_found: "Ajan bulunamadı.",
    // DiscoveryList
    loading: "Yükleniyor…",
    players: "Oyuncular",
    no_players: "Henüz oyuncu kayıtlı değil.",
    agents: "Ajanlar",
    // ConnectButton
    connect_wallet: "Cüzdan bağla",
    connecting: "Bağlanıyor…",
    disconnect: "Bağlantıyı kes",
    install_metamask: "MetaMask yükle",
    open_in_metamask: "MetaMask'ta aç",
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
    // Home page
    hero_eyebrow: "Открытый протокол нард · v1",
    hero_line1: "Мастерство вечно.",
    hero_line2_italic: "Теперь твой рейтинг тоже",
    hero_line2_end: ".",
    live_agents: "Активные агенты · Sepolia testnet",
    transactions: "Транзакции",
    // Action chips
    chip_mint: "Минт",
    chip_train: "Тренировка",
    chip_offchain: "Игра off-chain",
    chip_onchain: "Игра on-chain",
    // PersonCard
    info: "Инфо ↗",
    reading_chain: "Читаю цепочку…",
    played: "сыграно",
    won: "выиграно",
    lost: "проиграно",
    play_match: "Сыграть матч",
    // AgentCard
    games_trained: "игр обучено",
    // AgentsList
    loading_agents: "Загрузка агентов…",
    no_agents: "Агенты ещё не зарегистрированы.",
    no_deployment: "На этой цепочке нет развёртывания Chaingammon",
    no_agents_found: "Агенты не найдены.",
    // DiscoveryList
    loading: "Загрузка…",
    players: "Игроки",
    no_players: "Игроки ещё не зарегистрированы.",
    agents: "Агенты",
    // ConnectButton
    connect_wallet: "Подключить кошелёк",
    connecting: "Подключение…",
    disconnect: "Отключить",
    install_metamask: "Установить MetaMask",
    open_in_metamask: "Открыть в MetaMask",
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
    // Home page
    hero_eyebrow: "Відкритий протокол нардів · v1",
    hero_line1: "Майстерність вічна.",
    hero_line2_italic: "Тепер твій рейтинг теж",
    hero_line2_end: ".",
    live_agents: "Активні агенти · Sepolia testnet",
    transactions: "Транзакції",
    // Action chips
    chip_mint: "Мінт",
    chip_train: "Тренування",
    chip_offchain: "Гра off-chain",
    chip_onchain: "Гра on-chain",
    // PersonCard
    info: "Інфо ↗",
    reading_chain: "Читаю ланцюг…",
    played: "зіграно",
    won: "виграно",
    lost: "програно",
    play_match: "Зіграти матч",
    // AgentCard
    games_trained: "ігор навчено",
    // AgentsList
    loading_agents: "Завантаження агентів…",
    no_agents: "Агенти ще не зареєстровані.",
    no_deployment: "На цьому ланцюзі немає розгортання Chaingammon",
    no_agents_found: "Агентів не знайдено.",
    // DiscoveryList
    loading: "Завантаження…",
    players: "Гравці",
    no_players: "Гравці ще не зареєстровані.",
    agents: "Агенти",
    // ConnectButton
    connect_wallet: "Підключити гаманець",
    connecting: "Підключення…",
    disconnect: "Відключити",
    install_metamask: "Встановити MetaMask",
    open_in_metamask: "Відкрити в MetaMask",
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
