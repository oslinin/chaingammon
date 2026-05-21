/**
 * Direct browser-side reader for agent weights blobs stored on 0G Storage.
 *
 * 0G's indexer returns CORS-unrestricted responses, so the browser can fetch
 * the blob directly without routing through the FastAPI server.
 *
 * Two blob formats are supported:
 *   - Overlay JSON  (`{`)           → parse as Overlay envelope
 *   - PyTorch checkpoint (`PK\x03\x04`) → unzip, parse data.pkl with a
 *     minimal protocol-2 pickle reader, extract scalar/dict leaf values
 */

import { unzipSync } from "fflate";

// ─── public types ─────────────────────────────────────────────────────────────

export type OgWeightsResult =
  | { kind: "overlay"; match_count: number; values: Record<string, number>; summary: string }
  | { kind: "model"; match_count: number; values: Record<string, number>; meta: Record<string, unknown>; summary: string }
  | { kind: "null"; reason?: string };

// ─── constants ────────────────────────────────────────────────────────────────

const OG_INDEXER = "https://indexer-storage-testnet-turbo.0g.ai";
const ZERO_HASH = "0x" + "0".repeat(64);

// ─── entry point ──────────────────────────────────────────────────────────────

export async function fetchOgWeights(rootHash: string): Promise<OgWeightsResult> {
  if (!rootHash || rootHash === ZERO_HASH) {
    return { kind: "null", reason: "no hash" };
  }

  const resp = await fetch(`${OG_INDEXER}/file?root=${rootHash}`);
  if (!resp.ok) throw new Error(`0G indexer ${resp.status}`);

  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length === 0) return { kind: "null", reason: "empty blob" };

  // Content-sniff: `{` → overlay JSON; `PK\x03\x04` → PyTorch ZIP
  if (bytes[0] === 0x7b /* '{' */) {
    return parseOverlay(bytes);
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return parseCheckpoint(bytes);
  }
  return { kind: "null", reason: "unrecognized format" };
}

// ─── overlay JSON ─────────────────────────────────────────────────────────────

function parseOverlay(bytes: Uint8Array): OgWeightsResult {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const raw = parsed.values as Record<string, unknown> | undefined;
  const values: Record<string, number> = {};
  if (raw) for (const [k, v] of Object.entries(raw)) values[k] = Number(v);
  const match_count = Number(parsed.match_count ?? 0);
  return { kind: "overlay", match_count, values, summary: summarizeOverlay(values, match_count) };
}

// ─── PyTorch checkpoint (ZIP + pickle) ────────────────────────────────────────

function parseCheckpoint(bytes: Uint8Array): OgWeightsResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    return { kind: "null", reason: `ZIP error: ${String(e)}` };
  }

  const pklKey = Object.keys(files).find(
    (k) => k.endsWith("/data.pkl") || k === "data.pkl",
  );
  if (!pklKey) return { kind: "null", reason: "data.pkl not in archive" };

  let state: Record<string, unknown>;
  try {
    state = new Pickle2Reader(files[pklKey]).load() as Record<string, unknown>;
  } catch (e) {
    return { kind: "null", reason: `pickle error: ${String(e)}` };
  }
  if (!state || typeof state !== "object") {
    return { kind: "null", reason: "checkpoint did not deserialize to object" };
  }

  const raw = state.style_values as Record<string, unknown> | undefined;
  const values: Record<string, number> = {};
  if (raw) for (const [k, v] of Object.entries(raw)) values[k] = Number(v);

  const match_count = typeof state.match_count === "number" ? state.match_count : 0;

  const meta: Record<string, unknown> = {};
  for (const k of ["extras_dim", "in_dim", "hidden", "feature_encoder"]) {
    if (k in state) meta[k] = state[k];
  }

  return { kind: "model", match_count, values, meta, summary: summarizeModel(match_count) };
}

// ─── summary generation (mirrors agent_profile.py) ───────────────────────────

const CATEGORY_PHRASES: Record<string, string> = {
  opening_slot: "slotting on the opening roll",
  opening_split: "splitting back checkers in the opening",
  opening_builder: "playing builders in the opening",
  opening_anchor: "making an anchor early",
  build_5_point: "building the 5-point",
  build_bar_point: "building the bar point",
  bearoff_efficient: "bearing off efficiently",
  bearoff_safe: "bearing off safely",
  risk_hit_exposure: "leaving exposed checkers",
  risk_blot_leaving: "leaving blots",
  hits_blot: "hitting blots",
  runs_back_checker: "running back checkers",
  anchors_back: "holding deep anchors",
  phase_prime_building: "building primes",
  phase_race_conversion: "playing the race",
  phase_back_game: "playing back games",
  phase_holding_game: "playing holding games",
  phase_blitz: "playing blitzes",
  cube_offer_aggressive: "offering the cube aggressively",
  cube_take_aggressive: "taking the cube aggressively",
};

function summarizeOverlay(values: Record<string, number>, matchCount: number): string {
  if (matchCount === 0) return "This agent has just been minted — its style is still neutral.";
  const top = Object.entries(values)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3);
  const biases = top
    .filter(([, v]) => Math.abs(v) >= 0.05)
    .map(([cat, v]) => `${v > 0 ? "favors" : "avoids"} ${CATEGORY_PHRASES[cat] ?? cat}`);
  if (!biases.length) return `After ${matchCount} matches this agent has no strong style yet.`;
  return `After ${matchCount} matches this agent's tendencies are: ${biases.join("; ")}.`;
}

function summarizeModel(matchCount: number): string {
  if (matchCount === 0) return "This agent is a fresh value network — no training matches recorded yet.";
  return `This agent is a trained value network with ${matchCount} games of experience.`;
}

// ─── minimal pickle protocol-2 reader ─────────────────────────────────────────
//
// Handles the subset of opcodes that PyTorch's torch.save (protocol=2) emits.
// Unknown globals / tensor reconstructors are represented as null so the
// surrounding dict can still be traversed and scalar/dict fields extracted.

class Pickle2Reader {
  private v: DataView;
  private p = 0;
  private memo = new Map<number, unknown>();
  private stack: unknown[] = [];
  private marks: number[] = [];

  constructor(bytes: Uint8Array) {
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  load(): unknown {
    while (true) {
      const op = this.u8();
      switch (op) {
        // ── header ──────────────────────────────────────────────────────────
        case 0x80: this.u8(); break; // PROTO: skip version byte
        case 0x2e: return this.stack.pop(); // STOP

        // ── push constants ──────────────────────────────────────────────────
        case 0x4e: this.push(null); break; // NONE
        case 0x88: this.push(true); break; // NEWTRUE
        case 0x89: this.push(false); break; // NEWFALSE
        case 0x4b: this.push(this.u8()); break; // BININT1
        case 0x4d: this.push(this.u16()); break; // BININT2
        case 0x4a: this.push(this.i32()); break; // BININT
        case 0x47: this.push(this.f64()); break; // BINFLOAT (big-endian)

        // ── strings ─────────────────────────────────────────────────────────
        case 0x58: { // BINUNICODE (4-byte LE length)
          const n = this.u32();
          this.push(this.str(n));
          break;
        }
        case 0x8c: { // SHORT_BINUNICODE (1-byte length, protocol 4 but safe to handle)
          this.push(this.str(this.u8()));
          break;
        }
        case 0x55: { // SHORT_BINSTRING (1-byte, raw bytes as latin-1)
          this.push(this.str(this.u8()));
          break;
        }
        case 0x59: { // BINSTRING (4-byte LE, raw bytes as latin-1)
          this.push(this.str(this.u32()));
          break;
        }

        // ── bytes ────────────────────────────────────────────────────────────
        case 0x42: { const n = this.u32(); this.p += n; this.push(null); break; } // BINBYTES → null
        case 0x43: { this.p += this.u8(); this.push(null); break; } // SHORT_BINBYTES → null

        // ── containers ───────────────────────────────────────────────────────
        case 0x7d: this.push({}); break; // EMPTY_DICT
        case 0x5d: this.push([]); break; // EMPTY_LIST
        case 0x29: this.push([]); break; // EMPTY_TUPLE

        // ── mark / collections ────────────────────────────────────────────────
        case 0x28: this.marks.push(this.stack.length); break; // MARK

        case 0x73: { // SETITEM
          const val = this.stack.pop();
          const key = this.stack.pop();
          const d = this.stack[this.stack.length - 1];
          if (d && typeof d === "object" && !Array.isArray(d)) {
            (d as Record<string, unknown>)[String(key)] = val;
          }
          break;
        }
        case 0x75: { // SETITEMS
          const items = this.popMark();
          const d = this.stack[this.stack.length - 1];
          if (d && typeof d === "object" && !Array.isArray(d)) {
            for (let i = 0; i < items.length - 1; i += 2) {
              (d as Record<string, unknown>)[String(items[i])] = items[i + 1];
            }
          }
          break;
        }
        case 0x61: { // APPEND
          const item = this.stack.pop();
          const lst = this.stack[this.stack.length - 1];
          if (Array.isArray(lst)) lst.push(item);
          break;
        }
        case 0x65: { // APPENDS
          const items = this.popMark();
          const lst = this.stack[this.stack.length - 1];
          if (Array.isArray(lst)) lst.push(...items);
          break;
        }

        // ── tuples ────────────────────────────────────────────────────────────
        case 0x74: this.push(this.popMark()); break; // TUPLE
        case 0x85: { const a = this.stack.pop(); this.push([a]); break; } // TUPLE1
        case 0x86: { const b = this.stack.pop(); const a = this.stack.pop(); this.push([a, b]); break; } // TUPLE2
        case 0x87: { const c = this.stack.pop(); const b2 = this.stack.pop(); const a2 = this.stack.pop(); this.push([a2, b2, c]); break; } // TUPLE3

        // ── memo ─────────────────────────────────────────────────────────────
        case 0x71: this.memo.set(this.u8(), this.top()); break; // BINPUT
        case 0x72: this.memo.set(this.u32(), this.top()); break; // LONG_BINPUT
        case 0x68: this.push(this.memo.get(this.u8())); break; // BINGET
        case 0x6a: this.push(this.memo.get(this.u32())); break; // LONG_BINGET

        // ── callables ────────────────────────────────────────────────────────
        case 0x63: { // GLOBAL: reads "module\nname\n"
          let mod = "", name = "";
          for (let c = this.u8(); c !== 10; c = this.u8()) mod += String.fromCharCode(c);
          for (let c = this.u8(); c !== 10; c = this.u8()) name += String.fromCharCode(c);
          this.push({ __global__: `${mod}.${name}` });
          break;
        }
        case 0x52: { // REDUCE: func(args)
          const args = this.stack.pop() as unknown[];
          const func = this.stack.pop() as { __global__?: string } | null;
          if (func?.__global__ === "collections.OrderedDict") {
            // Treat as plain dict; any content comes via SETITEMS / BUILD.
            const d: Record<string, unknown> = {};
            if (Array.isArray(args) && args.length > 0 && Array.isArray(args[0])) {
              for (const pair of args[0] as unknown[][]) {
                if (Array.isArray(pair) && pair.length === 2) d[String(pair[0])] = pair[1];
              }
            }
            this.push(d);
          } else {
            // Tensor reconstructors and other callables → null placeholder.
            this.push(null);
          }
          break;
        }
        case 0x62: { // BUILD: obj.__setstate__(arg) or obj.__dict__.update(arg)
          const arg = this.stack.pop();
          const obj = this.stack[this.stack.length - 1];
          if (obj && typeof obj === "object" && !Array.isArray(obj) && arg && typeof arg === "object" && !Array.isArray(arg)) {
            Object.assign(obj, arg);
          }
          break;
        }
        case 0x51: { // BINPERSID: persistent_load(stack.pop()) → storage placeholder
          this.stack.pop();
          this.push(null);
          break;
        }

        // ── misc ─────────────────────────────────────────────────────────────
        case 0x30: this.stack.pop(); break; // POP
        case 0x32: this.push(this.top()); break; // DUP
        default: this.push(null); break; // unknown → null to keep stack sane
      }
    }
  }

  private push(v: unknown) { this.stack.push(v); }
  private top() { return this.stack[this.stack.length - 1]; }
  private popMark() {
    const idx = this.marks.pop() ?? 0;
    return this.stack.splice(idx);
  }
  private u8() { return this.v.getUint8(this.p++); }
  private u16() { const v = this.v.getUint16(this.p, true); this.p += 2; return v; }
  private u32() { const v = this.v.getUint32(this.p, true); this.p += 4; return v; }
  private i32() { const v = this.v.getInt32(this.p, true); this.p += 4; return v; }
  private f64() { const v = this.v.getFloat64(this.p, false); this.p += 8; return v; } // big-endian
  private str(n: number) {
    const bytes = new Uint8Array(this.v.buffer, this.v.byteOffset + this.p, n);
    this.p += n;
    return new TextDecoder().decode(bytes);
  }
}
