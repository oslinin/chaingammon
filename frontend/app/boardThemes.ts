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

  board_steampunk: {
    label: "Steampunk — Brass & Iron",
    backgroundImageUrl: "/boards/new/board4/board.png",
    backgroundImageCrop: { srcX: 51, srcY: 88, srcW: 1217, srcH: 611, totalSrcW: 1344, totalSrcH: 768 },
    checkerImages: {
      warm: "/boards/new/board4/warm.svg",
      cool: "/boards/new/board4/cool.svg",
    },
    checkerSpots: {
      columnsX: [0.0377, 0.1096, 0.1815, 0.2534, 0.3254, 0.3973, 0.6181, 0.6900, 0.7620, 0.8339, 0.9058, 0.9777],
      topY: 0.1195,
      bottomY: 0.8494,
      barX: 0.5103,
      barTopY: 0.1347,
      barBottomY: 0.8342,
      leftOffX: 0.02,
      rightOffX: 0.98,
    },
    avatarSpots: {
      p0: { cx: 0.04, cy: 0.88 },
      p1: { cx: 0.96, cy: 0.12 },
      r: 0.06,
    },
    frameStart: "#2A1A08", frameEnd: "#150D04", frameInner: "#0A0602",
    felt: "#1A1008", feltAccent: "#241808",
    pointLight: "#C89030", pointDark: "#3A2010",
    pointStroke: "rgba(200,144,48,0.3)",
    bar: "#150D04", barEdge: "#0A0602",
    rail: "#150D04", railText: "#C89030",
    checkerWarm: { fill: "#E0A040", stroke: "#A06010" },
    checkerCool: { fill: "#2A1A08", stroke: "#000000" },
  },

  board_celtic: {
    label: "Celtic — Ornate Green",
    backgroundImageUrl: "/boards/new/board1/board.png",
    backgroundImageCrop: { srcX: 0, srcY: 128, srcW: 1024, srcH: 856, totalSrcW: 1024, totalSrcH: 1024 },
    checkerImages: {
      warm: "/boards/new/board1/warm.svg",
      cool: "/boards/new/board1/cool.svg",
    },
    checkerSpots: {
      columnsX: [0.0996, 0.1650, 0.2305, 0.2959, 0.3613, 0.4268, 0.5742, 0.6396, 0.7051, 0.7705, 0.8359, 0.8994],
      topY: 0.1647,
      bottomY: 0.8353,
      barX: 0.4854,
      barTopY: 0.4229,
      barBottomY: 0.5748,
      leftOffX: 0.02,
      rightOffX: 0.98,
    },
    avatarSpots: {
      p0: { cx: 0.04, cy: 0.88 },
      p1: { cx: 0.96, cy: 0.12 },
      r: 0.06,
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
    label: "Medieval — Dark Wood",
    frameStart: "#3D1F0A", frameEnd: "#1C0D04", frameInner: "#0C0602",
    felt: "#2A1208", feltAccent: "#3A1A0A",
    pointLight: "#C8A060", pointDark: "#3A1A0A", pointStroke: "rgba(0,0,0,0.4)",
    bar: "#1C0D04", barEdge: "#0C0602", rail: "#1C0D04", railText: "#C8A060",
    checkerWarm: { fill: "#E8D8B0", stroke: "#A09060" },
    checkerCool: { fill: "#2A1A0A", stroke: "#000000" },
  },
  board_roman: {
    label: "Roman — Marble Court",
    imageIs3d: true,
    backgroundImageUrl: "/boards/new/board3/board.png",
    backgroundImageCrop: { srcX: 168, srcY: 185, srcW: 990, srcH: 570, totalSrcW: 1248, totalSrcH: 832 },
    checkerImages: {
      warm: "/boards/new/board3/warm.svg",
      cool: "/boards/new/board3/cool.svg",
    },
    checkerSpots: {
      columnsX: [0.0374, 0.1121, 0.1869, 0.2616, 0.3374, 0.4121, 0.5879, 0.6626, 0.7374, 0.8121, 0.8879, 0.9626],
      topY: 0.2544,
      bottomY: 0.8684,
      barX: 0.5000,
      barTopY: 0.2544,
      barBottomY: 0.8684,
      leftOffX: 0.03,
      rightOffX: 0.97,
    },
    avatarSpots: {
      p0: { cx: 0.103, cy: 0.035 },
      p1: { cx: 0.871, cy: 0.035 },
      r: 0.044,
    },
    // Fallback SVG colors — marble cream + dark red:
    frameStart: "#5A3820", frameEnd: "#3A2010", frameInner: "#1A1008",
    felt: "#D8C8A8", feltAccent: "#E8D8C0",
    pointLight: "#F0E8D0", pointDark: "#8B1A1A", pointStroke: "rgba(0,0,0,0.2)",
    bar: "#A89878", barEdge: "#7A6848", rail: "#7A6848", railText: "#2A1008",
    checkerWarm: { fill: "#F5F0E8", stroke: "#C8B89A" },
    checkerCool: { fill: "#4A2010", stroke: "#2A1008" },
  },
  board_darkwood: {
    label: "Dark Wood — Tavern Table",
    frameStart: "#3A2010", frameEnd: "#1E1008", frameInner: "#0E0804",
    felt: "#1A0E06", feltAccent: "#241408",
    pointLight: "#B88040", pointDark: "#2A1408", pointStroke: "rgba(0,0,0,0.4)",
    bar: "#1E1008", barEdge: "#0E0804", rail: "#1E1008", railText: "#B88040",
    checkerWarm: { fill: "#E8D0A0", stroke: "#A09060" },
    checkerCool: { fill: "#241408", stroke: "#000000" },
  },
  board_cyber2: {
    label: "Cyber — Neural Grid",
    imageIs3d: true,
    backgroundImageUrl: "/boards/new/board6/board.png",
    backgroundImageCrop: { srcX: 183, srcY: 90, srcW: 973, srcH: 598, totalSrcW: 1344, totalSrcH: 768 },
    checkerImages: {
      warm: "/boards/new/board6/warm.svg",
      cool: "/boards/new/board6/cool.svg",
    },
    checkerSpots: {
      columnsX: [0.2199, 0.2610, 0.3022, 0.3433, 0.3844, 0.4255, 0.5899, 0.6413, 0.6927, 0.7441, 0.7955, 0.8469],
      topY: 0.1672,
      bottomY: 0.7943,
      barX: 0.5077,
      barTopY: 0.2007,
      barBottomY: 0.6689,
      leftOffX: 0.04,
      rightOffX: 0.96,
    },
    avatarSpots: {
      p0: { cx: 0.04, cy: 0.88 },
      p1: { cx: 0.96, cy: 0.12 },
      r: 0.06,
    },
    // Fallback SVG colors — cyber green + red:
    frameStart: "#0A0A0A", frameEnd: "#000000", frameInner: "#000000",
    felt: "#050505", feltAccent: "#0A0A0A",
    pointLight: "#00CC44", pointDark: "#CC0022", pointStroke: "rgba(0,204,68,0.4)",
    bar: "#0A0A0A", barEdge: "#000000", rail: "#0A0A0A", railText: "#00CC44",
    checkerWarm: { fill: "#00CC44", stroke: "#009933" },
    checkerCool: { fill: "#CC0022", stroke: "#990019" },
  },
};

export const THEME_ORDER = [
  "walnut", "emerald", "slate", "onyx", "linen",
  "nard", "tabula", "east_asian", "english", "manhattan", "neural_net",
  "board_desert", "board_classic", "board_asian", "board_minimal", "board_adventure", "board_scifi",
  "board_celtic", "board_medieval", "board_roman", "board_steampunk", "board_darkwood", "board_cyber2",
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

const PREFER_3D_KEY = "chaingammon.prefer3d";

export function loadPrefer3d(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(PREFER_3D_KEY) === "true";
}

export function savePrefer3d(v: boolean) {
  localStorage.setItem(PREFER_3D_KEY, String(v));
}

/** URLs for the 6 historical coin portrait avatars. */
export const COIN_POOL = [
  '/boards/new/coins/coin1.svg',
  '/boards/new/coins/coin2.svg',
  '/boards/new/coins/coin3.svg',
  '/boards/new/coins/coin4.svg',
  '/boards/new/coins/coin5.svg',
  '/boards/new/coins/coin6.svg',
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
