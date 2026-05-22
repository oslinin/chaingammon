"use client";

export interface BoardTheme {
  label: string;
  /** Optional background image URL. When set, the frame and felt become semi-transparent overlays. */
  backgroundImageUrl?: string;
  /** Optional pre-rendered 3D checker assets. When set, replaces the SVG circle rendering. */
  checkerImages?: {
    warm: string; // P0 (human, bottom)
    cool: string; // P1 (agent, top)
  };
  /**
   * When set, the background image is cropped to the given rectangle instead
   * of being stretched to fill the full viewport. All pixel values refer to
   * the source (un-cropped) image coordinate system. Board.tsx scales and
   * positions the image element so that exactly this rectangle maps onto the
   * 716×440 SVG viewport. Use this to carve individual board skins out of a
   * composite sprite sheet without pre-splitting the file.
   */
  backgroundImageCrop?: {
    srcX: number;       // left edge of the crop region (source pixels)
    srcY: number;       // top edge of the crop region (source pixels)
    srcW: number;       // width of the crop region (source pixels)
    srcH: number;       // height of the crop region (source pixels)
    totalSrcW: number;  // total source image width (source pixels)
    totalSrcH: number;  // total source image height (source pixels)
  };
  /**
   * Per-spot checker landing coordinates for image-based boards. All values
   * are fractions of the 716×440 viewport (0–1). When set, Board.tsx looks
   * each checker's (x, y) up directly so they land on the painted triangles
   * — no uniform-grid assumption.
   *
   * columnsX: 12 column center X values, left → right. Mapping:
   *   col 0  = points 12 (bottom) & 13 (top), leftmost
   *   col 5  = points  7 & 18, just left of bar
   *   col 6  = points  6 & 19, just right of bar
   *   col 11 = points  1 & 24, rightmost
   */
  checkerSpots?: {
    columnsX: number[];  // length 12
    topY: number;        // first checker center y for top points (13–24)
    bottomY: number;     // first checker center y for bottom points (1–12)
    barX: number;        // bar checker stack x
    barTopY: number;     // first agent (P1) bar checker, stacks downward
    barBottomY: number;  // first human (P0) bar checker, stacks upward
    leftOffX: number;    // left tray x (agent/P1 bear-off)
    rightOffX: number;   // right tray x (human/P0 bear-off)
  };
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
  nard: {
    label: "Nard — Mesopotamia & Persia",
    frameStart:  "#7C3D12",
    frameEnd:    "#431407",
    frameInner:  "#1C0C03",
    felt:        "#FEF3C7",
    feltAccent:  "#FDE68A",
    pointLight:  "#0F766E",
    pointDark:   "#B45309",
    pointStroke: "rgba(0,0,0,0.2)",
    bar:         "#92400E",
    barEdge:     "#431407",
    rail:        "#92400E",
    railText:    "#FDE68A",
    checkerWarm: { fill: "#2DD4BF", stroke: "#0D9488" },
    checkerCool: { fill: "#92400E", stroke: "#451A03" },
  },
  tabula: {
    label: "Tabula — The Roman Evolution",
    frameStart:  "#44403C",
    frameEnd:    "#1C1917",
    frameInner:  "#0C0A09",
    felt:        "#D6D3D1",
    feltAccent:  "#E7E5E4",
    pointLight:  "#991B1B",
    pointDark:   "#57534E",
    pointStroke: "rgba(0,0,0,0.2)",
    bar:         "#A8A29E",
    barEdge:     "#78716C",
    rail:        "#78716C",
    railText:    "#1C1917",
    checkerWarm: { fill: "#F5F5F4", stroke: "#A8A29E" },
    checkerCool: { fill: "#B91C1C", stroke: "#7F1D1D" },
  },
  east_asian: {
    label: "Shuanglu / Sugoroku — Imperial Courtyard",
    frameStart:  "#27272A",
    frameEnd:    "#09090B",
    frameInner:  "#000000",
    felt:        "#18181B",
    feltAccent:  "#27272A",
    pointLight:  "#CA8A04",
    pointDark:   "#3F3F46",
    pointStroke: "rgba(202,138,4,0.35)",
    bar:         "#3F3F46",
    barEdge:     "#27272A",
    rail:        "#27272A",
    railText:    "#CA8A04",
    checkerWarm: { fill: "#10B981", stroke: "#059669" },
    checkerCool: { fill: "#F5F5F4", stroke: "#A8A29E" },
  },
  english: {
    label: "English Rebranding — 17th Century",
    frameStart:  "#431407",
    frameEnd:    "#1C0A03",
    frameInner:  "#0D0502",
    felt:        "#292524",
    feltAccent:  "#1C1917",
    pointLight:  "#78350F",
    pointDark:   "#0C0A09",
    pointStroke: "rgba(120,53,15,0.3)",
    bar:         "#1C0A03",
    barEdge:     "#0D0502",
    rail:        "#1C0A03",
    railText:    "#FED7AA",
    checkerWarm: { fill: "#D97706", stroke: "#92400E" },
    checkerCool: { fill: "#44403C", stroke: "#1C1917" },
  },
  manhattan: {
    label: "Manhattan High-Roller — 1920s",
    frameStart:  "#431407",
    frameEnd:    "#1C1917",
    frameInner:  "#0C0A09",
    felt:        "#1C1208",
    feltAccent:  "#0C0A09",
    pointLight:  "#D97706",
    pointDark:   "#171717",
    pointStroke: "rgba(234,179,8,0.25)",
    bar:         "#1C1917",
    barEdge:     "#0C0A09",
    rail:        "#1C1917",
    railText:    "#EAB308",
    checkerWarm: { fill: "#EAB308", stroke: "#92400E" },
    checkerCool: { fill: "#262626", stroke: "#171717" },
  },
  neural_net: {
    label: "Neural Net Disciple — The gnubg Era",
    frameStart:  "#0A0A0A",
    frameEnd:    "#000000",
    frameInner:  "#000000",
    felt:        "#000000",
    feltAccent:  "#050505",
    pointLight:  "#10B981",
    pointDark:   "#F43F5E",
    pointStroke: "rgba(16,185,129,0.35)",
    bar:         "#171717",
    barEdge:     "#262626",
    rail:        "#171717",
    railText:    "#34D399",
    checkerWarm: { fill: "#10B981", stroke: "#059669" },
    checkerCool: { fill: "#F43F5E", stroke: "#E11D48" },
  },

  // ── Image-skin themes ────────────────────────────────────────────────────────
  // These six themes share a single composite sprite served via /api/board-sprite
  // (which proxies the GitHub CDN or serves a local copy from public/boards/source.png).
  // Each theme declares a `backgroundImageCrop` that isolates one of the six
  // panels in the 2-column × 3-row layout.  Board.tsx uses SVG image positioning
  // to show only the relevant crop; no pre-split files are required at build time.
  //
  // To serve the sprite locally (recommended for production):
  //   node scripts/download_board_sprite.mjs
  //   # → writes frontend/public/boards/source.png
  //
  // To generate individually split PNG files:
  //   node scripts/split_board_image.mjs
  //
  // The composite is a 1024×1024 PNG arranged as:
  //   col 0 (x 0–511)    col 1 (x 512–1023)
  //   row 0 (y 0–340)    Desert         Classic
  //   row 1 (y 341–681)  Asian          Minimal
  //   row 2 (y 682–1023) Adventure      Sci-fi

  board_desert: {
    label: "Desert Sands",
    backgroundImageUrl: "/api/board-sprite",
    backgroundImageCrop: { srcX: 0, srcY: 0, srcW: 512, srcH: 341, totalSrcW: 1024, totalSrcH: 1024 },
    frameStart:  "#C8960C",
    frameEnd:    "#7A4E12",
    frameInner:  "#4A2E08",
    felt:        "#D4A855",
    feltAccent:  "#E6C56A",
    pointLight:  "#FFD780",
    pointDark:   "#8B3A0F",
    pointStroke: "rgba(0,0,0,0.2)",
    bar:         "#7A4E12",
    barEdge:     "#4A2E08",
    rail:        "#7A4E12",
    railText:    "#FFD780",
    checkerWarm: { fill: "#2DD4BF", stroke: "#0D9488" },
    checkerCool: { fill: "#B45309", stroke: "#78350F" },
  },

  board_classic: {
    label: "Classic Mahogany",
    backgroundImageUrl: "/api/board-sprite",
    backgroundImageCrop: { srcX: 512, srcY: 0, srcW: 512, srcH: 341, totalSrcW: 1024, totalSrcH: 1024 },
    frameStart:  "#3D1F0F",
    frameEnd:    "#1C0D06",
    frameInner:  "#0C0603",
    felt:        "#2D1508",
    feltAccent:  "#3D1F0F",
    pointLight:  "#F5EBD8",
    pointDark:   "#8B1A1A",
    pointStroke: "rgba(0,0,0,0.3)",
    bar:         "#1C0D06",
    barEdge:     "#0C0603",
    rail:        "#1C0D06",
    railText:    "#F5EBD8",
    checkerWarm: { fill: "#F5F0E8", stroke: "#C8B89A" },
    checkerCool: { fill: "#1A1208", stroke: "#000000" },
  },

  board_asian: {
    label: "Imperial Dragon",
    backgroundImageUrl: "/api/board-sprite",
    backgroundImageCrop: { srcX: 0, srcY: 341, srcW: 512, srcH: 341, totalSrcW: 1024, totalSrcH: 1024 },
    frameStart:  "#1A1A1A",
    frameEnd:    "#0A0A0A",
    frameInner:  "#000000",
    felt:        "#0D1F0D",
    feltAccent:  "#142814",
    pointLight:  "#CA8A04",
    pointDark:   "#1A2E1A",
    pointStroke: "rgba(202,138,4,0.3)",
    bar:         "#1A1A1A",
    barEdge:     "#000000",
    rail:        "#1A1A1A",
    railText:    "#CA8A04",
    checkerWarm: { fill: "#10B981", stroke: "#059669" },
    checkerCool: { fill: "#F5F0E8", stroke: "#C8B89A" },
  },

  board_minimal: {
    label: "Shadow Steel",
    backgroundImageUrl: "/api/board-sprite",
    backgroundImageCrop: { srcX: 512, srcY: 341, srcW: 512, srcH: 341, totalSrcW: 1024, totalSrcH: 1024 },
    frameStart:  "#1E2028",
    frameEnd:    "#0E1018",
    frameInner:  "#080A10",
    felt:        "#242830",
    feltAccent:  "#1C2028",
    pointLight:  "#8BAAC8",
    pointDark:   "#3A4560",
    pointStroke: "rgba(0,0,0,0.35)",
    bar:         "#0E1018",
    barEdge:     "#080A10",
    rail:        "#0E1018",
    railText:    "#8BAAC8",
    checkerWarm: { fill: "#C8D8E8", stroke: "#8BAAC8" },
    checkerCool: { fill: "#1A1E28", stroke: "#000000" },
  },

  board_adventure: {
    label: "Old World Adventure",
    backgroundImageUrl: "/api/board-sprite",
    backgroundImageCrop: { srcX: 0, srcY: 682, srcW: 512, srcH: 342, totalSrcW: 1024, totalSrcH: 1024 },
    frameStart:  "#4A2C0A",
    frameEnd:    "#2A1806",
    frameInner:  "#180E03",
    felt:        "#3A2208",
    feltAccent:  "#4A2C0A",
    pointLight:  "#D4A040",
    pointDark:   "#2A1806",
    pointStroke: "rgba(0,0,0,0.35)",
    bar:         "#2A1806",
    barEdge:     "#180E03",
    rail:        "#2A1806",
    railText:    "#D4A040",
    checkerWarm: { fill: "#E8C050", stroke: "#A07820" },
    checkerCool: { fill: "#1C1008", stroke: "#000000" },
  },

  board_scifi: {
    label: "Cyber Matrix",
    backgroundImageUrl: "/api/board-sprite",
    backgroundImageCrop: { srcX: 512, srcY: 682, srcW: 512, srcH: 342, totalSrcW: 1024, totalSrcH: 1024 },
    frameStart:  "#060606",
    frameEnd:    "#000000",
    frameInner:  "#000000",
    felt:        "#020202",
    feltAccent:  "#050505",
    pointLight:  "#00CC88",
    pointDark:   "#CC0044",
    pointStroke: "rgba(0,204,136,0.4)",
    bar:         "#0A0A0A",
    barEdge:     "#000000",
    rail:        "#0A0A0A",
    railText:    "#00CC88",
    checkerWarm: { fill: "#00CC88", stroke: "#009966" },
    checkerCool: { fill: "#FF3366", stroke: "#CC0044" },
  },
};

export const THEME_ORDER = [
  "walnut", "emerald", "slate", "onyx", "linen",
  "nard", "tabula", "east_asian", "english", "manhattan", "neural_net",
  "board_desert", "board_classic", "board_asian", "board_minimal", "board_adventure", "board_scifi",
] as const;
export type BoardThemeKey = typeof THEME_ORDER[number];

/**
 * URL of the composite board sprite sheet used by the six image-skin themes.
 * Points to the Next.js proxy route which serves public/boards/source.png
 * when present, or falls back to the GitHub CDN upload.
 * Run `node scripts/download_board_sprite.mjs` to cache the sprite locally.
 */
export const BOARD_SPRITE_URL = "/api/board-sprite";

const STORAGE_KEY = "chaingammon.boardTheme";

export function loadTheme(): BoardThemeKey {
  if (typeof window === "undefined") return "walnut";
  const saved = localStorage.getItem(STORAGE_KEY);
  return (saved && saved in BOARD_THEMES ? saved : "walnut") as BoardThemeKey;
}

export function saveTheme(key: BoardThemeKey) {
  localStorage.setItem(STORAGE_KEY, key);
}
