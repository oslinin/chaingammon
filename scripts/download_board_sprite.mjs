/**
 * download_board_sprite.mjs
 *
 * One-time script: downloads the composite board sprite from the GitHub CDN
 * and saves it to frontend/public/boards/source.png.  Run this once after
 * cloning the repo if the file is not already present.
 *
 *   node scripts/download_board_sprite.mjs
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const SPRITE_URL =
  "https://github.com/user-attachments/assets/5ff80b7f-f391-4547-95c9-7ba46f8aa1a6";
const DEST = join(ROOT, "frontend", "public", "boards", "source.png");

async function main() {
  mkdirSync(join(ROOT, "frontend", "public", "boards"), { recursive: true });

  console.log(`Downloading board sprite from GitHub CDN…`);
  const res = await fetch(SPRITE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const writer = createWriteStream(DEST);
  await pipeline(res.body, writer);
  console.log(`Saved to ${DEST}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
