// Generate the canonical board-geometry template + its calibration file.
//
//   node scripts/gen_board_template.mjs
//
// Emits:
//   public/boards/template/board_template.svg   — vector source
//   public/boards/template/board_template.png   — 1024x595 raster (ControlNet input)
//   lib/calibration/board_template.json         — checkerSpots for boardThemes.ts
//
// Why: AI image generators produce beautiful photorealistic boards but wonky
// geometry — uneven point spacing, drifting bar, random dimensions — which is
// why every existing image skin (boards/new/board1..7) needed its own
// hand-made lib/calibration/*.json. This template inverts the workflow:
// generate new skins CONFORMING to one ideal geometry, so they all share the
// single board_template.json emitted here and never need per-skin calibration.
//
// Recipe for a new skin (all free):
//   1. ControlNet (strongest): Stable Diffusion + ControlNet lineart/canny —
//      local ComfyUI/AUTOMATIC1111, Google Colab free tier, or a Hugging Face
//      Space. Control image = board_template.png, weight 0.8-1.0, output
//      1024x595 (or 2048x1190 and downscale). Prompt the style + materials,
//      and ALWAYS end with: "empty board, no checkers, no dice" — checkers,
//      dice, and avatars are overlaid by Board.tsx, never baked into the art.
//   2. img2img at ~0.5-0.65 denoise on an existing skin keeps layout and
//      output dimensions while changing style.
//   3. Gemini/GPT image EDITING mode (upload board_template.png or an
//      existing skin as reference, "repaint in style X keeping the exact
//      layout and framing") — editing preserves geometry; fresh
//      text-to-image does not.
//
// Wiring the result into the app: drop the image at
// public/boards/new/boardN/board.png, add a boardThemes.ts entry with
//   backgroundImageCrop: { srcX:0, srcY:0, srcW:1024, srcH:595,
//                          totalSrcW:1024, totalSrcH:595 },
//   checkerSpots: calBoardTemplate,   // ← lib/calibration/board_template.json
// and reuse any existing checkerImages set.
//
// PNG rendering uses @playwright/test's chromium (already a devDependency).
// On a machine without `playwright install`'s browsers, point CHROMIUM_PATH
// at a system Chromium (e.g. /opt/pw-browsers/chromium in the CI sandbox);
// if no browser is available the script still writes the SVG + JSON and says
// how to get the PNG.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "boards", "template");
const CAL_PATH = join(ROOT, "lib", "calibration", "board_template.json");

// ── Canonical geometry ──────────────────────────────────────────────────────
// 1024x595 matches the celtic skin's crop and is close to SDXL's native
// landscape buckets, so generations need no resizing.
const W = 1024, H = 595;
const SIDE = 100, TOP = 60;      // frame margins (room for ornate border art)
const BAR_W = 60;
const TRI_LEN = 190;             // point length (~5-checker stack)
const R = 29;                    // checker radius (diameter 58 < point width 63.7)

const fieldL = SIDE, fieldR = W - SIDE;
const fieldT = TOP, fieldB = H - TOP;
const barL = W / 2 - BAR_W / 2;
const quadW = (fieldR - fieldL - BAR_W) / 2;
const ptW = quadW / 6;           // triangle base width; triangles are adjacent

const cols = [
  ...Array.from({ length: 6 }, (_, i) => fieldL + ptW * (i + 0.5)),
  ...Array.from({ length: 6 }, (_, i) => barL + BAR_W + ptW * (i + 0.5)),
];

// ── SVG ─────────────────────────────────────────────────────────────────────
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
  `<rect width="${W}" height="${H}" fill="white"/>`,
  `<rect x="3" y="3" width="${W - 6}" height="${H - 6}" fill="none" stroke="black" stroke-width="5"/>`,
  `<rect x="${fieldL - 5}" y="${fieldT - 5}" width="${fieldR - fieldL + 10}" height="${fieldB - fieldT + 10}" fill="none" stroke="black" stroke-width="4"/>`,
  `<rect x="${barL}" y="${fieldT - 5}" width="${BAR_W}" height="${fieldB - fieldT + 10}" fill="#d9d9d9" stroke="black" stroke-width="4"/>`,
];
cols.forEach((x, i) => {
  for (const row of ["top", "bottom"]) {
    const pts =
      row === "top"
        ? `${(x - ptW / 2).toFixed(1)},${fieldT} ${(x + ptW / 2).toFixed(1)},${fieldT} ${x.toFixed(1)},${fieldT + TRI_LEN}`
        : `${(x - ptW / 2).toFixed(1)},${fieldB} ${(x + ptW / 2).toFixed(1)},${fieldB} ${x.toFixed(1)},${fieldB - TRI_LEN}`;
    const odd = (i + (row === "top" ? 0 : 1)) % 2;
    svg.push(`<polygon points="${pts}" fill="${odd ? "#bfbfbf" : "#f2f2f2"}" stroke="black" stroke-width="3"/>`);
  }
});
svg.push("</svg>");

mkdirSync(OUT_DIR, { recursive: true });
const svgPath = join(OUT_DIR, "board_template.svg");
writeFileSync(svgPath, svg.join("\n"));
console.log(`wrote ${svgPath}`);

// ── Calibration (same shape as the hand-made lib/calibration files) ─────────
const round4 = (v) => Math.round(v * 1e4) / 1e4;
const cal = {
  columnsX: cols.map((x) => round4(x / W)),
  topY: round4((fieldT + R) / H),
  bottomY: round4((fieldB - R) / H),
  barX: 0.5,
  barTopY: round4((fieldT + R) / H),
  barBottomY: round4((fieldB - R) / H),
  leftOffX: 0.045,
  rightOffX: 0.955,
};
writeFileSync(CAL_PATH, JSON.stringify(cal, null, 2) + "\n");
console.log(`wrote ${CAL_PATH}`);

// ── PNG via Playwright chromium ─────────────────────────────────────────────
try {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto("file://" + svgPath);
  const pngPath = join(OUT_DIR, "board_template.png");
  await page.screenshot({ path: pngPath });
  await browser.close();
  console.log(`wrote ${pngPath}`);
} catch (e) {
  console.error(
    `PNG render skipped (${e.message.split("\n")[0]}). ` +
      `Run \`pnpm exec playwright install chromium\` or set CHROMIUM_PATH, then re-run.`,
  );
}
