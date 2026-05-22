"use client";

export interface BoardTheme {
  label: string;
  /** Optional background image URL. When set, the frame and felt become semi-transparent overlays. */
  backgroundImageUrl?: string;
  frameStart: string;
  frameEnd: string;
  frameInner: string;
  felt: string;
  feltAccent: string;
  pointLight: string;
  pointDark: string;
  pointStroke: string;
  bar: string;
  barEdge: string;
  rail: string;
  railText: string;
  checkerWarm: { fill: string; stroke: string };
  checkerCool: { fill: string; stroke: string };
}

export const BOARD_THEMES: Record<string, BoardTheme> = {
  walnut: {
    label: "Walnut Classic",
    frameStart:  "#6B3F1F",
    frameEnd:    "#4A2814",
    frameInner:  "#3A2014",
    felt:        "#F1E2BD",
    feltAccent:  "#E6D2A2",
    pointLight:  "#F6E9C6",
    pointDark:   "#7A1F1A",
    pointStroke: "rgba(0,0,0,0.18)",
    bar:         "#4A2814",
    barEdge:     "#3A2014",
    rail:        "#4A2814",
    railText:    "#F1D9A6",
    checkerWarm: { fill: "#1A1208", stroke: "#000000" },
    checkerCool: { fill: "#F5EBDC", stroke: "#A8967A" },
  },
  emerald: {
    label: "Emerald Hall",
    frameStart:  "#3D2818",
    frameEnd:    "#261509",
    frameInner:  "#1B0E04",
    felt:        "#073A28",
    feltAccent:  "#062E20",
    pointLight:  "#EFE3C2",
    pointDark:   "#179862",
    pointStroke: "rgba(0,0,0,0.32)",
    bar:         "#261509",
    barEdge:     "#1B0E04",
    rail:        "#1B0E04",
    railText:    "#D6C490",
    checkerWarm: { fill: "#E8C062", stroke: "#7E5B1F" },
    checkerCool: { fill: "#1A1A1E", stroke: "#000000" },
  },
  slate: {
    label: "Slate Tournament",
    frameStart:  "#2A2D33",
    frameEnd:    "#15171B",
    frameInner:  "#0B0D11",
    felt:        "#3D434C",
    feltAccent:  "#333944",
    pointLight:  "#E8E1CF",
    pointDark:   "#7BA0C4",
    pointStroke: "rgba(0,0,0,0.28)",
    bar:         "#15171B",
    barEdge:     "#0B0D11",
    rail:        "#15171B",
    railText:    "#C8CCD3",
    checkerWarm: { fill: "#D44A3E", stroke: "#7A1F18" },
    checkerCool: { fill: "#1E2026", stroke: "#000000" },
  },
  onyx: {
    label: "Onyx & Brass",
    frameStart:  "#1A1208",
    frameEnd:    "#0B0805",
    frameInner:  "#000000",
    felt:        "#1F1410",
    feltAccent:  "#2A1A14",
    pointLight:  "#E8C062",
    pointDark:   "#7A1F1A",
    pointStroke: "rgba(0,0,0,0.55)",
    bar:         "#0B0805",
    barEdge:     "#000000",
    rail:        "#0B0805",
    railText:    "#E8C062",
    checkerWarm: { fill: "#F4D49A", stroke: "#7E5B1F" },
    checkerCool: { fill: "#F5EBDC", stroke: "#7A6E5C" },
  },
  linen: {
    label: "Linen Studio",
    frameStart:  "#D8C3A3",
    frameEnd:    "#B59770",
    frameInner:  "#8A6D4A",
    felt:        "#C5A878",
    feltAccent:  "#B89968",
    pointLight:  "#FAF3E1",
    pointDark:   "#2F5235",
    pointStroke: "rgba(0,0,0,0.22)",
    bar:         "#B59770",
    barEdge:     "#8A6D4A",
    rail:        "#8A6D4A",
    railText:    "#FAF3E1",
    checkerWarm: { fill: "#2A2A2E", stroke: "#000000" },
    checkerCool: { fill: "#F5EBDC", stroke: "#7E6A4C" },
  },
  gemini1: {
    label: "Gemini Board 1",
    backgroundImageUrl: "/boards/gemini_board_1_no_checkers.png",
    frameStart:  "#0B0F22",
    frameEnd:    "#05070F",
    frameInner:  "#020408",
    felt:        "#0D1535",
    feltAccent:  "#0A1028",
    pointLight:  "#E8E4DC",
    pointDark:   "#1B3A6B",
    pointStroke: "rgba(100,160,255,0.25)",
    bar:         "#080C1E",
    barEdge:     "#030510",
    rail:        "#080C1E",
    railText:    "#8EB4E8",
    checkerWarm: { fill: "#F5F0E8", stroke: "#B0A890" },
    checkerCool: { fill: "#0A1832", stroke: "#1E4080" },
  },
  gemini2: {
    label: "Gemini Board 2",
    backgroundImageUrl: "/boards/gemini_board_2_no_checkers.png",
    frameStart:  "#051217",
    frameEnd:    "#020A0E",
    frameInner:  "#010608",
    felt:        "#061820",
    feltAccent:  "#051220",
    pointLight:  "#F0F8FF",
    pointDark:   "#0E4D5C",
    pointStroke: "rgba(0,200,220,0.25)",
    bar:         "#030D12",
    barEdge:     "#010709",
    rail:        "#030D12",
    railText:    "#60D8E8",
    checkerWarm: { fill: "#E8F4F8", stroke: "#90C8D8" },
    checkerCool: { fill: "#0A3040", stroke: "#106080" },
  },
  gemini3: {
    label: "Gemini Board 3",
    backgroundImageUrl: "/boards/gemini_board_3_no_checkers.png",
    frameStart:  "#1A1205",
    frameEnd:    "#0F0A00",
    frameInner:  "#080600",
    felt:        "#1C1508",
    feltAccent:  "#150F05",
    pointLight:  "#E8C060",
    pointDark:   "#2A1A00",
    pointStroke: "rgba(200,150,0,0.25)",
    bar:         "#0E0A03",
    barEdge:     "#080601",
    rail:        "#0E0A03",
    railText:    "#D4A030",
    checkerWarm: { fill: "#E8C060", stroke: "#906800" },
    checkerCool: { fill: "#0A0800", stroke: "#382400" },
  },
  gemini4: {
    label: "Gemini Board 4",
    backgroundImageUrl: "/boards/gemini_board_4_no_checkers.png",
    frameStart:  "#120D1E",
    frameEnd:    "#080512",
    frameInner:  "#04030A",
    felt:        "#160F24",
    feltAccent:  "#110C1E",
    pointLight:  "#C8B8E8",
    pointDark:   "#2A1060",
    pointStroke: "rgba(160,100,255,0.25)",
    bar:         "#0C0818",
    barEdge:     "#060310",
    rail:        "#0C0818",
    railText:    "#A080D8",
    checkerWarm: { fill: "#D4C0F0", stroke: "#806080" },
    checkerCool: { fill: "#1A0838", stroke: "#4020A0" },
  },
};

export const THEME_ORDER = ["walnut", "emerald", "slate", "onyx", "linen", "gemini1", "gemini2", "gemini3", "gemini4"] as const;
export type BoardThemeKey = typeof THEME_ORDER[number];

const STORAGE_KEY = "chaingammon.boardTheme";

export function loadTheme(): BoardThemeKey {
  if (typeof window === "undefined") return "walnut";
  const saved = localStorage.getItem(STORAGE_KEY);
  return (saved && saved in BOARD_THEMES ? saved : "walnut") as BoardThemeKey;
}

export function saveTheme(key: BoardThemeKey) {
  localStorage.setItem(STORAGE_KEY, key);
}
