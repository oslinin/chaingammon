/**
 * splitBoardImage — browser-side utility for splitting a composite board image.
 *
 * Loads a single sprite PNG (or any image URL) into an off-screen Canvas,
 * then crops it into `cols × rows` equal sections and returns each section
 * as a Blob URL.  Blob URLs remain valid for the lifetime of the current
 * page; call URL.revokeObjectURL(url) when a board image is no longer needed.
 *
 * Usage (React example):
 *   const [urls, setUrls] = useState<string[]>([]);
 *   useEffect(() => {
 *     splitBoardImage("/boards/source.png", 2, 3).then(setUrls);
 *     return () => urls.forEach(URL.revokeObjectURL);
 *   }, []);
 *
 * For server-side splitting (build step / CI), use the companion Node.js
 * script at scripts/split_board_image.mjs instead.
 */

export interface SplitOptions {
  /** Number of columns in the composite (default 2). */
  cols?: number;
  /** Number of rows in the composite (default 3). */
  rows?: number;
  /** Output MIME type (default "image/png"). "image/jpeg" is smaller. */
  mimeType?: "image/png" | "image/jpeg";
  /** JPEG quality 0–1 (only used when mimeType is "image/jpeg"; default 0.9). */
  quality?: number;
}

/**
 * Split a composite board image into individual board images.
 *
 * @param src    URL of the composite image (may be a same-origin path, a
 *               crossOrigin URL, or a data-URL).
 * @param opts   Optional tuning parameters.
 * @returns      Promise resolving to an array of Blob URLs, ordered
 *               left-to-right, top-to-bottom.
 */
export async function splitBoardImage(
  src: string,
  opts: SplitOptions = {}
): Promise<string[]> {
  const { cols = 2, rows = 3, mimeType = "image/png", quality = 0.9 } = opts;

  const img = await loadImage(src);
  const cellW = Math.floor(img.naturalWidth / cols);
  const cellH = Math.floor(img.naturalHeight / rows);

  const blobUrls: string[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellW;
      const y = r * cellH;
      // Last column/row absorbs any remainder pixels from integer division.
      const w = c === cols - 1 ? img.naturalWidth - x : cellW;
      const h = r === rows - 1 ? img.naturalHeight - y : cellH;

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context not available");

      ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
      const blob = await canvasToBlob(canvas, mimeType, quality);
      blobUrls.push(URL.createObjectURL(blob));
    }
  }

  return blobUrls;
}

/**
 * Compute the crop geometry for one cell in a composite image without doing
 * any actual pixel work.  The returned object is compatible with the
 * `backgroundImageCrop` field in `BoardTheme` (boardThemes.ts), so you can
 * build themes programmatically.
 *
 * @param totalW  Total composite image width (pixels).
 * @param totalH  Total composite image height (pixels).
 * @param cols    Number of columns.
 * @param rows    Number of rows.
 * @param idx     Zero-based index of the desired cell (left-to-right, top-to-bottom).
 */
export function computeCrop(
  totalW: number,
  totalH: number,
  cols: number,
  rows: number,
  idx: number
) {
  const col = idx % cols;
  const row = Math.floor(idx / cols);
  const cellW = Math.floor(totalW / cols);
  const cellH = Math.floor(totalH / rows);
  const srcX = col * cellW;
  const srcY = row * cellH;
  const srcW = col === cols - 1 ? totalW - srcX : cellW;
  const srcH = row === rows - 1 ? totalH - srcY : cellH;
  return { srcX, srcY, srcW, srcH, totalSrcW: totalW, totalSrcH: totalH };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null"))),
      mimeType,
      quality
    );
  });
}
