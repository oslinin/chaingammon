"use client";

// Prepend base path so asset URLs resolve correctly on GitHub Pages
// (where the app is served under /chaingammon/ rather than /).
const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

import calBoardSteampunk from "../lib/calibration/board_steampunk.json";
import calBoardCeltic    from "../lib/calibration/board_celtic.json";
import calBoardMedieval  from "../lib/calibration/board_medieval.json";
import calBoardDarkwood  from "../lib/calibration/board_darkwood.json";
import calBoardTokyo     from "../lib/calibration/board_tokyo.json";
import calBoardCyber2    from "../lib/calibration/board_cyber2.json";

/** Crop spec for a single checker PNG. srcX/Y/W/H are viewBox coords in the source image. */
export interface CheckerImageSpec {
  url: string;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  totalW: number;
  totalH: number;
}

export interface BoardTheme {
  label: string;
  /** Optional background image URL. When set, the frame and felt become semi-transparent overlays. */
  backgroundImageUrl?: string;
  /** Optional pre-rendered 3D checker assets. When set, replaces the SVG circle rendering. */
  checkerImages?: {
    warm: CheckerImageSpec; // P0 (human, bottom)
    cool: CheckerImageSpec; // P1 (agent, top)
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
  /** When true, the background image is pre-rendered with a perspective tilt; 2D mode compensates with an inverse CSS transform. */
  imageIs3d?: boolean;
  /** Degrees of rotateX tilt applied in 3D mode (default 20). */
  perspectiveDeg?: number;
  /** Portrait avatar spots for player coin display (image themes only). All values fractions of 716×440. */
  avatarSpots?: {
    p0: { cx: number; cy: number };  // human/warm player avatar center
    p1: { cx: number; cy: number };  // agent/cool player avatar center
    r: number;                        // avatar circle radius as fraction of min(716,440)=440
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
    label: "Walnut — Georgian England c.1750",
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
    label: "Emerald — Victorian Club c.1870",
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
    label: "Slate — Club Tournament c.1980",
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
    label: "Onyx & Brass — Contemporary",
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
    label: "Linen — Contemporary",
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
  // Each theme declares a `backgroundImageUrl` plus a `backgroundImageCrop` that
  // isolates the board panel. Board.tsx uses SVG image positioning to show only
  // the relevant crop.

  board_steampunk: {
    label: "Dark Mahogany — British Empire c.1890",
    backgroundImageUrl: `${BP}/boards/new/board4/board.jpeg`,
    backgroundImageCrop: { srcX: 0, srcY: 0, srcW: 830, srcH: 500, totalSrcW: 830, totalSrcH: 500 },
    checkerImages: {
      warm: { url: `${BP}/boards/new/board4/light_checker.png`, srcX: 208, srcY: 0, srcW: 832, srcH: 832, totalW: 1248, totalH: 832 },
      cool: { url: `${BP}/boards/new/board4/dark_checker.png`,  srcX: 208, srcY: 0, srcW: 832, srcH: 832, totalW: 1248, totalH: 832 },
    },
    checkerSpots: calBoardSteampunk,
    avatarSpots: { p0: { cx: 0.043, cy: 0.12 }, p1: { cx: 0.957, cy: 0.12 }, r: 0.052 },
    frameStart: "#2A1A0A", frameEnd: "#150D04", frameInner: "#0A0602",
    felt: "#3A2810", feltAccent: "#4A3418",
    pointLight: "#A07840", pointDark: "#2A1808", pointStroke: "rgba(0,0,0,0.45)",
    bar: "#1A1008", barEdge: "#0A0604", rail: "#1A1008", railText: "#C8A060",
    checkerWarm: { fill: "#D4A050", stroke: "#8A6020" },
    checkerCool: { fill: "#2A2018", stroke: "#100C06" },
  },

  board_celtic: {
    label: "Persian — The Nard Era",
    backgroundImageUrl: `${BP}/boards/new/board1/board.jpeg`,
    backgroundImageCrop: { srcX: 0, srcY: 0, srcW: 1024, srcH: 595, totalSrcW: 1024, totalSrcH: 595 },
    checkerImages: {
      warm: { url: `${BP}/boards/new/board1/checkers.png`, srcX: 0,   srcY: 256, srcW: 512, srcH: 512, totalW: 1024, totalH: 1024 },
      cool: { url: `${BP}/boards/new/board1/checkers.png`, srcX: 512, srcY: 256, srcW: 512, srcH: 512, totalW: 1024, totalH: 1024 },
    },
    checkerSpots: calBoardCeltic,
    avatarSpots: {
      p0: { cx: 0.063, cy: 0.123 },
      p1: { cx: 0.937, cy: 0.123 },
      r: 0.105,
    },
    // Fallback SVG colors — match the green/gold board art:
    frameStart: "#2D5A1B", frameEnd: "#1A3A0F", frameInner: "#0F2208",
    felt: "#1A4A10", feltAccent: "#244F16",
    pointLight: "#E8C84A", pointDark: "#0A2A06",
    pointStroke: "rgba(0,0,0,0.3)",
    bar: "#1A3A0F", barEdge: "#0F2208",
    rail: "#1A3A0F", railText: "#E8C84A",
    checkerWarm: { fill: "#8B4513", stroke: "#5C2D0A" },
    checkerCool: { fill: "#40B8B8", stroke: "#1A8A8A" },
  },
  board_medieval: {
    label: "Roman — Imperial Court",
    backgroundImageUrl: `${BP}/boards/new/board2/board.jpeg`,
    backgroundImageCrop: { srcX: 0, srcY: 0, srcW: 1024, srcH: 559, totalSrcW: 1024, totalSrcH: 559 },
    checkerImages: {
      warm: { url: `${BP}/boards/new/board2/light_checker.png`, srcX: 0, srcY: 0, srcW: 1024, srcH: 1024, totalW: 1024, totalH: 1024 },
      cool: { url: `${BP}/boards/new/board2/dark_checker.png`,  srcX: 0, srcY: 0, srcW: 1024, srcH: 1024, totalW: 1024, totalH: 1024 },
    },
    checkerSpots: calBoardMedieval,
    avatarSpots: { p0: { cx: 0.043, cy: 0.12 }, p1: { cx: 0.957, cy: 0.12 }, r: 0.052 },
    frameStart: "#6B3010", frameEnd: "#3A1808", frameInner: "#1A0C04",
    felt: "#E8E0D0", feltAccent: "#F5EED8",
    pointLight: "#F0EAD8", pointDark: "#8B1A1A", pointStroke: "rgba(0,0,0,0.18)",
    bar: "#C8A040", barEdge: "#A07820", rail: "#A07820", railText: "#1A0C04",
    checkerWarm: { fill: "#F0E8D0", stroke: "#C0A060" },
    checkerCool: { fill: "#5A1A1A", stroke: "#2A0808" },
  },
  board_darkwood: {
    label: "Manhattan — 1920s Art Deco",
    backgroundImageUrl: `${BP}/boards/new/board5/board.jpeg`,
    backgroundImageCrop: { srcX: 0, srcY: 0, srcW: 1024, srcH: 559, totalSrcW: 1024, totalSrcH: 559 },
    checkerImages: {
      warm: { url: `${BP}/boards/new/board5/light_checker.png`, srcX: 208, srcY: 0, srcW: 832, srcH: 832, totalW: 1248, totalH: 832 },
      cool: { url: `${BP}/boards/new/board5/dark_checker.png`,  srcX: 208, srcY: 0, srcW: 832, srcH: 832, totalW: 1248, totalH: 832 },
    },
    checkerSpots: calBoardDarkwood,
    avatarSpots: { p0: { cx: 0.043, cy: 0.12 }, p1: { cx: 0.957, cy: 0.12 }, r: 0.052 },
    frameStart: "#1A1A1A", frameEnd: "#0A0A0A", frameInner: "#000000",
    felt: "#0D1A0D", feltAccent: "#142014",
    pointLight: "#CA8A04", pointDark: "#1A2E1A", pointStroke: "rgba(202,138,4,0.3)",
    bar: "#1A1A1A", barEdge: "#000000", rail: "#1A1A1A", railText: "#CA8A04",
    checkerWarm: { fill: "#10B981", stroke: "#059669" },
    checkerCool: { fill: "#F5F0E8", stroke: "#C8B89A" },
  },
  board_tokyo: {
    label: "Tokyo — Contemporary Japan",
    backgroundImageUrl: `${BP}/boards/new/board7/board.jpeg`,
    backgroundImageCrop: { srcX: 0, srcY: 0, srcW: 1024, srcH: 655, totalSrcW: 1024, totalSrcH: 655 },
    checkerImages: {
      warm: { url: `${BP}/boards/new/board7/light_checker.jpeg`, srcX: 193, srcY: 11, srcW: 640, srcH: 640, totalW: 1024, totalH: 655 },
      cool: { url: `${BP}/boards/new/board7/dark_checker.jpeg`,  srcX: 193, srcY: 11, srcW: 640, srcH: 640, totalW: 1024, totalH: 655 },
    },
    checkerSpots: calBoardTokyo,
    avatarSpots: { p0: { cx: 0.043, cy: 0.12 }, p1: { cx: 0.957, cy: 0.12 }, r: 0.052 },
    frameStart: "#3D2010", frameEnd: "#1E0D06", frameInner: "#0C0602",
    felt: "#2A1808", feltAccent: "#3A2010",
    pointLight: "#D4B896", pointDark: "#1A0E06", pointStroke: "rgba(0,0,0,0.4)",
    bar: "#1E0D06", barEdge: "#0C0602", rail: "#1E0D06", railText: "#D4B896",
    checkerWarm: { fill: "#E8D5B0", stroke: "#A08858" },
    checkerCool: { fill: "#2A1808", stroke: "#000000" },
  },
  board_cyber2: {
    label: "Cyber — Digital Age c.2020",
    backgroundImageUrl: `${BP}/boards/new/board6/board.png`,
    backgroundImageCrop: { srcX: 0, srcY: 0, srcW: 737, srcH: 463, totalSrcW: 737, totalSrcH: 463 },
    checkerImages: {
      warm: { url: `${BP}/boards/new/board6/light_checker.png`, srcX: 288, srcY: 0,    srcW: 768,  srcH: 768,  totalW: 1344, totalH: 768  },
      cool: { url: `${BP}/boards/new/board6/dark_checker.png`,  srcX: 0,   srcY: 0,    srcW: 1024, srcH: 1024, totalW: 1024, totalH: 1024 },
    },
    checkerSpots: calBoardCyber2,
    // No avatarSpots: the neon board's point wedges reach the corners, leaving
    // no room for a corner avatar. Player colours still show via label swatches.
    frameStart: "#0A0A0A", frameEnd: "#000000", frameInner: "#000000",
    felt: "#050505", feltAccent: "#0A0A0A",
    pointLight: "#CC44FF", pointDark: "#0088CC", pointStroke: "rgba(204,68,255,0.4)",
    bar: "#0A0A0A", barEdge: "#000000", rail: "#0A0A0A", railText: "#CC44FF",
    checkerWarm: { fill: "#CC44FF", stroke: "#8800CC" },
    checkerCool: { fill: "#00AAFF", stroke: "#0066CC" },
  },

  // ── Design-system flat-color themes (from ui_kits/app/Boards-mobile.html) ──

  indigo: {
    label: "Indigo · Saffron — Mughal India c.1650",
    frameStart:  "#050A18",
    frameEnd:    "#050A18",
    frameInner:  "#050A18",
    felt:        "#1F3A6B",
    feltAccent:  "#1A3060",
    pointDark:   "#0A1428",
    pointLight:  "#E8B85A",
    pointStroke: "rgba(0,0,0,0.25)",
    bar:         "#5A2A18",
    barEdge:     "#050A18",
    rail:        "#5A2A18",
    railText:    "#E8B85A",
    checkerWarm: { fill: "#F0E5D0", stroke: "#050A18" },
    checkerCool: { fill: "#C4423A", stroke: "#050A18" },
  },

  coffee: {
    label: "Coffee House — Ottoman Empire c.1700",
    frameStart:  "#1A0E08",
    frameEnd:    "#1A0E08",
    frameInner:  "#1A0E08",
    felt:        "#C4A275",
    feltAccent:  "#B8966A",
    pointDark:   "#2A1208",
    pointLight:  "#F5E8C8",
    pointStroke: "rgba(0,0,0,0.2)",
    bar:         "#1A0E08",
    barEdge:     "#1A0E08",
    rail:        "#1A0E08",
    railText:    "#F5E8C8",
    checkerWarm: { fill: "#4A2A18", stroke: "#1A0E08" },
    checkerCool: { fill: "#C4423A", stroke: "#1A0E08" },
  },

  // ── Design-system six boards (from ui_kits/app/Boards-six-themes.html) ────

  persian: {
    label: "Persian Carpet — Safavid c.1600",
    frameStart:  "#5A1F18",
    frameEnd:    "#3A1208",
    frameInner:  "#3A1208",
    felt:        "#0E5560",
    feltAccent:  "#0A4A54",
    pointDark:   "#3FA8B0",
    pointLight:  "#C4423A",
    pointStroke: "rgba(0,0,0,0.2)",
    bar:         "#3A1208",
    barEdge:     "#5A1F18",
    rail:        "#3A1208",
    railText:    "#E8DCB4",
    checkerWarm: { fill: "#3FA8B0", stroke: "#1A0E08" },
    checkerCool: { fill: "#C4423A", stroke: "#1A0E08" },
  },

  marble: {
    label: "Marble — Roman Classical c.200",
    frameStart:  "#B8902E",
    frameEnd:    "#8A6820",
    frameInner:  "#8A6820",
    felt:        "#EDE6D8",
    feltAccent:  "#E4DBD0",
    pointDark:   "#7A1F18",
    pointLight:  "#C4A56A",
    pointStroke: "rgba(0,0,0,0.18)",
    bar:         "#B8902E",
    barEdge:     "#8A6820",
    rail:        "#B8902E",
    railText:    "#5A4020",
    checkerWarm: { fill: "#D4B370", stroke: "#5A4020" },
    checkerCool: { fill: "#F0E5D0", stroke: "#5A4020" },
  },

  lacquer: {
    label: "Lacquer — Tang Dynasty c.700",
    frameStart:  "#0A0A0A",
    frameEnd:    "#0A0A0A",
    frameInner:  "#0A0A0A",
    felt:        "#15110E",
    feltAccent:  "#1A1510",
    pointDark:   "#E8E1CF",
    pointLight:  "#1F1A14",
    pointStroke: "rgba(232,225,207,0.2)",
    bar:         "#0A0A0A",
    barEdge:     "#0A0A0A",
    rail:        "#0A0A0A",
    railText:    "#C9BEA8",
    checkerWarm: { fill: "#3A8F5A", stroke: "#0A0A0A" },
    checkerCool: { fill: "#E8E1CF", stroke: "#0A0A0A" },
  },

  tavern: {
    label: "Tavern — Medieval Europe c.1350",
    frameStart:  "#3A2A1C",
    frameEnd:    "#2A1C10",
    frameInner:  "#2A1C10",
    felt:        "#6B4A30",
    feltAccent:  "#5E3F28",
    pointDark:   "#C4A075",
    pointLight:  "#2A1A10",
    pointStroke: "rgba(0,0,0,0.2)",
    bar:         "#2A1A10",
    barEdge:     "#3A2A1C",
    rail:        "#2A1A10",
    railText:    "#E8D4A8",
    checkerWarm: { fill: "#E8D4A8", stroke: "#1A0E08" },
    checkerCool: { fill: "#3A2010", stroke: "#1A0E08" },
  },

  parlour: {
    label: "Parlour — Victorian Era c.1880",
    frameStart:  "#4A2A18",
    frameEnd:    "#2A1208",
    frameInner:  "#2A1208",
    felt:        "#A87848",
    feltAccent:  "#9A6B40",
    pointDark:   "#7A1F18",
    pointLight:  "#1A0E08",
    pointStroke: "rgba(0,0,0,0.2)",
    bar:         "#2A1208",
    barEdge:     "#4A2A18",
    rail:        "#2A1208",
    railText:    "#E8B040",
    checkerWarm: { fill: "#E8B040", stroke: "#2A1208" },
    checkerCool: { fill: "#1A0E08", stroke: "#4A2A18" },
  },

  neon: {
    label: "Neon — Arcade Era c.1985",
    frameStart:  "#050608",
    frameEnd:    "#050608",
    frameInner:  "#050608",
    felt:        "#0E1014",
    feltAccent:  "#0A0C10",
    pointDark:   "#1A4F2A",
    pointLight:  "#4F1A1F",
    pointStroke: "rgba(61,214,114,0.3)",
    bar:         "#050608",
    barEdge:     "#050608",
    rail:        "#050608",
    railText:    "#3DD672",
    checkerWarm: { fill: "#3DD672", stroke: "#050608" },
    checkerCool: { fill: "#E63B4A", stroke: "#050608" },
  },
};

export const THEME_ORDER = [
  "walnut", "emerald", "slate", "indigo", "coffee",
  "persian", "marble", "lacquer", "tavern", "parlour", "neon",
  "onyx", "linen",
  "nard", "tabula", "east_asian", "english", "manhattan", "neural_net",
  "board_celtic", "board_medieval", "board_steampunk", "board_darkwood", "board_tokyo", "board_cyber2",
] as const;
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

const PREFER_3D_KEY = "chaingammon.prefer3d";

export function loadPrefer3d(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(PREFER_3D_KEY);
  return stored === null ? true : stored === "true";
}

export function savePrefer3d(v: boolean) {
  localStorage.setItem(PREFER_3D_KEY, String(v));
}

/** URLs for the 6 historical coin portrait avatars. */
export const COIN_POOL = [
  `${BP}/boards/new/coins/coin1_avatar.png`,
  `${BP}/boards/new/coins/coin2_avatar.png`,
  `${BP}/boards/new/coins/coin3_avatar.png`,
  `${BP}/boards/new/coins/coin4_avatar.png`,
  `${BP}/boards/new/coins/coin5_avatar.png`,
  `${BP}/boards/new/coins/coin6_avatar.png`,
] as const;

/**
 * Pick 2 distinct coins from the pool for a game session.
 * warm = P0 (human, bottom), cool = P1 (agent, top).
 * Call once per game start and store the result in component state.
 */
export function pickGameCoins(): { warm: string; cool: string } {
  const pool = [...COIN_POOL];
  const i1 = Math.floor(Math.random() * pool.length);
  const [warm] = pool.splice(i1, 1);
  const i2 = Math.floor(Math.random() * pool.length);
  return { warm, cool: pool[i2] };
}
