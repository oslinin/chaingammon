// Generate square, disc-centered avatar versions of the coin images.
// The source coins are wide canvases (e.g. 1408x736) with the disc on the
// left and transparent/opaque padding, which crop badly into a circular
// avatar. This trims the padding and centers the disc on a transparent
// square, producing /boards/new/coins/coinN_avatar.png.
//
//   node scripts/square_coins.mjs

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "boards", "new", "coins");
const SIZE = 512;
const SOURCES = ["coin1.png", "coin2.png", "coin3.png", "coin4.jpeg", "coin5.png", "coin6.png"];

for (const src of SOURCES) {
  const out = join(DIR, src.replace(/\.(png|jpeg|jpg)$/, "_avatar.png"));
  const { width, height } = await sharp(join(DIR, src)).metadata();
  // The disc is a full-height circle on the left of a wide canvas — take that
  // left square, then trim residual padding/shadow (high threshold ignores the
  // faint drop shadow) and center the disc on a transparent square.
  const side = Math.min(width, height);
  // Pass 1: crop the left square to a buffer (sharp reorders trim before a
  // pre-resize extract in a single pipeline, so keep them separate).
  const square = await sharp(join(DIR, src))
    .ensureAlpha()
    .extract({ left: 0, top: 0, width: side, height: side })
    .png()
    .toBuffer();
  // Pass 2: trim residual padding/shadow, then `cover` so the disc fills the
  // square edge-to-edge (contain would leave a margin, so the disc wouldn't
  // reach the avatar's circular clip and a backing crescent would show).
  await sharp(square)
    .trim({ threshold: 120 })   // high threshold also cuts the faint glow halo,
                                 // so the solid disc (not its glow) fills the square
    .resize(SIZE, SIZE, { fit: "cover", position: "center" })
    .png()
    .toFile(out);
  const meta = await sharp(out).metadata();
  console.log(`${src} -> ${out.split("/").pop()} (${meta.width}x${meta.height})`);
}
