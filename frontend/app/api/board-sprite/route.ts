/**
 * GET /api/board-sprite
 *
 * Serves the composite board sprite (1024×1024 PNG, 2-col × 3-row layout).
 * Board.tsx crops six individual themes out of this single image at render
 * time using SVG positioning, so no pre-split files are required.
 *
 * Resolution order:
 *   1. Local file: public/boards/source.png  (fastest; add via
 *      `node scripts/download_board_sprite.mjs`)
 *   2. GitHub CDN fallback: the original upload URL (always works in dev,
 *      but incurs a network round-trip and depends on the CDN link remaining
 *      active)
 *
 * The response is cached for 24 h at the CDN / browser layer.
 */

import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** GitHub CDN URL of the composite board sprite uploaded with issue #143. */
const CDN_URL =
  "https://github.com/user-attachments/assets/5ff80b7f-f391-4547-95c9-7ba46f8aa1a6";

export async function GET() {
  // Attempt to serve the locally cached copy first.
  try {
    const localPath = join(process.cwd(), "public", "boards", "source.png");
    const data = await readFile(localPath);
    return new NextResponse(data, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
      },
    });
  } catch {
    // File absent — fall through to CDN fetch.
  }

  // Proxy from the GitHub CDN.
  let cdnRes: Response;
  try {
    cdnRes = await fetch(CDN_URL, { next: { revalidate: 86400 } });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not fetch board sprite from CDN", detail: String(err) },
      { status: 502 }
    );
  }

  if (!cdnRes.ok) {
    return NextResponse.json(
      { error: `CDN returned ${cdnRes.status}` },
      { status: 502 }
    );
  }

  return new NextResponse(cdnRes.body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
    },
  });
}
