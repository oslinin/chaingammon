/**
 * split_board_image.mjs
 *
 * Splits a composite PNG that contains N×M backgammon board screenshots into
 * N*M individual PNG files.  Uses only Node.js built-in modules — no external
 * dependencies required.
 *
 * Usage:
 *   node scripts/split_board_image.mjs [input] [outputDir] [cols] [rows]
 *
 * Defaults:
 *   input      — /tmp/github-images/image-1779424205149-0.png
 *   outputDir  — frontend/public/boards
 *   cols       — 2
 *   rows       — 3
 *
 * The script writes files named board-1.png … board-N.png (left-to-right,
 * top-to-bottom).  Pass --names=a,b,c,d,e,f to override the stem list.
 *
 * Example:
 *   node scripts/split_board_image.mjs \
 *     /tmp/composite.png frontend/public/boards 2 3 \
 *     --names=board-desert,board-classic,board-asian,board-minimal,board-adventure,board-scifi
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { join } from "node:path";

// ─── PNG constants ────────────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Pre-computed CRC32 lookup table. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── PNG chunk I/O ───────────────────────────────────────────────────────────

/**
 * Parse all chunks from a raw PNG buffer (after the 8-byte signature).
 * Returns an array of { type: string, data: Buffer }.
 */
function readChunks(buf) {
  const chunks = [];
  let pos = 8; // skip signature
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
    const data = Buffer.from(buf.subarray(pos + 8, pos + 8 + len));
    chunks.push({ type, data });
    pos += 12 + len; // length(4) + type(4) + data(len) + crc(4)
  }
  return chunks;
}

/**
 * Encode a single chunk: length + type + data + crc.
 */
function encodeChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

// ─── IHDR ────────────────────────────────────────────────────────────────────

function parseIHDR(data) {
  return {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    bitDepth: data[8],
    colorType: data[9],
    compression: data[10],
    filter: data[11],
    interlace: data[12],
  };
}

function buildIHDR({ width, height, bitDepth, colorType, compression, filter, interlace }) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = bitDepth;
  d[9] = colorType;
  d[10] = compression;
  d[11] = filter;
  d[12] = interlace;
  return d;
}

/** Bytes per pixel for the given colorType + bitDepth combination. */
function bpp(colorType, bitDepth) {
  const channels =
    colorType === 0 ? 1 :  // grayscale
    colorType === 2 ? 3 :  // RGB
    colorType === 3 ? 1 :  // indexed
    colorType === 4 ? 2 :  // grayscale + alpha
    colorType === 6 ? 4 :  // RGBA
    (() => { throw new Error(`Unsupported colorType ${colorType}`); })();
  return Math.ceil((channels * bitDepth) / 8);
}

// ─── PNG filter reconstruction ────────────────────────────────────────────────

/**
 * Reconstruct (un-filter) a single scanline.
 * @param {Buffer} row    Raw scanline bytes including the leading filter byte.
 * @param {Buffer|null} prev  Previous (already unfiltered) scanline pixels, or null.
 * @param {number}  bytesPerPixel
 * @returns {Buffer}  Unfiltered pixel bytes (no filter byte prefix).
 */
function unfilterRow(row, prev, bytesPerPixel) {
  const f = row[0];
  const len = row.length - 1;
  const out = Buffer.alloc(len);

  for (let i = 0; i < len; i++) {
    const x = row[i + 1];
    const a = i >= bytesPerPixel ? out[i - bytesPerPixel] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;

    switch (f) {
      case 0: out[i] = x; break;                                         // None
      case 1: out[i] = (x + a) & 0xff; break;                            // Sub
      case 2: out[i] = (x + b) & 0xff; break;                            // Up
      case 3: out[i] = (x + Math.floor((a + b) / 2)) & 0xff; break;      // Average
      case 4: {                                                           // Paeth
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out[i] = (x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        break;
      }
      default: throw new Error(`Unknown PNG filter byte ${f}`);
    }
  }
  return out;
}

// ─── Main split function ──────────────────────────────────────────────────────

/**
 * Split a composite PNG into `cols × rows` individual PNGs.
 *
 * @param {string}   inputPath   Path to the source PNG.
 * @param {string}   outputDir   Directory where output PNGs are written.
 * @param {number}   cols        Number of columns in the composite.
 * @param {number}   rows        Number of rows in the composite.
 * @param {string[]} names       Stem names for each output file (length = cols*rows,
 *                               ordered left-to-right, top-to-bottom).
 * @returns {string[]}  Absolute paths of the written files.
 */
export function splitBoardImage(inputPath, outputDir, cols, rows, names) {
  const buf = readFileSync(inputPath);

  if (!buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error(`${inputPath} is not a valid PNG file`);
  }

  const chunks = readChunks(buf);
  const ihdr = parseIHDR(chunks.find((c) => c.type === "IHDR").data);
  const { width, height, bitDepth, colorType } = ihdr;
  const B = bpp(colorType, bitDepth);
  const rowStride = width * B;

  console.log(`Source: ${width}×${height} px | colorType=${colorType} bitDepth=${bitDepth} bpp=${B}`);

  // Decompress IDAT
  const idatData = Buffer.concat(
    chunks.filter((c) => c.type === "IDAT").map((c) => c.data)
  );
  const raw = inflateSync(idatData);

  // Un-filter all scanlines
  const filteredStride = rowStride + 1; // +1 for filter byte
  const scanlines = [];
  for (let y = 0; y < height; y++) {
    const rowRaw = raw.subarray(y * filteredStride, (y + 1) * filteredStride);
    scanlines.push(unfilterRow(rowRaw, y > 0 ? scanlines[y - 1] : null, B));
  }

  // Cell dimensions
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);

  mkdirSync(outputDir, { recursive: true });

  const outputPaths = [];
  let idx = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW;
      const y0 = r * cellH;
      // Last column/row absorbs any remainder pixels from integer division.
      const w = c === cols - 1 ? width - x0 : cellW;
      const h = r === rows - 1 ? height - y0 : cellH;

      // Crop pixel data — filter type 0 (None) for each output row.
      const rowBufs = [];
      for (let y = 0; y < h; y++) {
        const src = scanlines[y0 + y];
        const filter = Buffer.from([0]); // None
        const pixels = Buffer.from(src.subarray(x0 * B, (x0 + w) * B));
        rowBufs.push(Buffer.concat([filter, pixels]));
      }

      const rawCrop = Buffer.concat(rowBufs);
      const compressed = deflateSync(rawCrop, { level: 6 });

      const outIHDR = buildIHDR({ ...ihdr, width: w, height: h });
      const outBuf = Buffer.concat([
        PNG_SIG,
        encodeChunk("IHDR", outIHDR),
        encodeChunk("IDAT", compressed),
        encodeChunk("IEND", Buffer.alloc(0)),
      ]);

      const stem = names?.[idx] ?? `board-${idx + 1}`;
      const outPath = join(outputDir, `${stem}.png`);
      writeFileSync(outPath, outBuf);
      console.log(`  [${idx + 1}/${cols * rows}] ${outPath}  (${w}×${h} px)`);
      outputPaths.push(outPath);
      idx++;
    }
  }

  return outputPaths;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => a.slice(2).split("="))
  );

  const inputPath = args[0] ?? "/tmp/github-images/image-1779424205149-0.png";
  const outputDir = args[1] ?? "frontend/public/boards";
  const cols      = parseInt(args[2] ?? "2", 10);
  const rows      = parseInt(args[3] ?? "3", 10);
  const names     = flags.names ? flags.names.split(",") : [
    "board-desert",
    "board-classic",
    "board-asian",
    "board-minimal",
    "board-adventure",
    "board-scifi",
  ];

  try {
    splitBoardImage(inputPath, outputDir, cols, rows, names);
    console.log("Done.");
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}
