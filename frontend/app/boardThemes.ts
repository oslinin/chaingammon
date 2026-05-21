"use client";

export interface BoardTheme {
  label: string;
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
};

export const THEME_ORDER = ["walnut", "emerald", "slate", "onyx", "linen"] as const;
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
