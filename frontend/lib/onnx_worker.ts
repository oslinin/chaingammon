// Dedicated Web Worker for ONNX inference.
// Running ORT here isolates WASM compilation from the main thread's heap,
// preventing the streaming-compile OOM that occurs under main-thread memory
// pressure (large page + WASM binary competing for the same arena).

import type * as ORT from "onnxruntime-web";
import { generateLegalMoves, encodeFullBoard, applyMove } from "./rules_engine";
import type { Board } from "./rules_engine";
import { STYLE_DIM } from "./career_features";

type OrtNs = typeof ORT;

// IndexedDB model cache — avoids re-fetching the ONNX model on every page load.
// Key includes a version token so a new model deployment busts the cache.
const IDB_NAME = "chaingammon-onnx-v1";
const IDB_STORE = "model";
const MODEL_KEY = "backgammon_net";

// Next.js `basePath` (e.g. "/chaingammon" on GitHub Pages) only auto-prepends
// to URLs routed through next/link or next/image — raw fetch() calls do not
// get the prefix. Read the build-time NEXT_PUBLIC_BASE_PATH (set in
// next.config.ts) so this worker fetches the model from the correct path
// when deployed under a subdirectory.
const MODEL_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/backgammon_net.onnx`;

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadModelBytes(): Promise<ArrayBuffer> {
  try {
    const db = await idbOpen();
    const cached: ArrayBuffer | undefined = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(MODEL_KEY);
      req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
      req.onerror = () => reject(req.error);
    });
    if (cached) {
      db.close();
      return cached;
    }
    const buf = await fetch(MODEL_URL).then(r => r.arrayBuffer());
    // Store a copy — buf.slice(0) transfers ownership cleanly.
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(buf.slice(0), MODEL_KEY);
    db.close();
    return buf;
  } catch {
    // IDB unavailable (private browsing, quota exceeded) — fall back to fetch.
    return fetch(MODEL_URL).then(r => r.arrayBuffer());
  }
}

let _ort: OrtNs | null = null;
let _session: ORT.InferenceSession | null = null;

// ── Uniform agent input contract ─────────────────────────────────────────────
// Every per-agent model (MLP or sklearn forest) takes one input that is the
// board encoding concatenated with the style vector: features = [board ‖ style].
// The bundled base model is board-only. We don't know the width up front
// (onnxruntime-web 1.16 exposes input *names* but not shapes), so the first
// inference probes board-only and falls back to board+style.
const BOARD_DIM = 198;
let _styleVec: Float32Array | null = null; // real style for the loaded agent, if any
let _inputName = "board";
let _featMode: "unknown" | "board" | "concat" = "unknown";

function styleHalf(): Float32Array {
  if (_styleVec && _styleVec.length === STYLE_DIM) return _styleVec;
  // Neutral style: all-zero with the bias channel set, matching the trainer's
  // encode_career_context bias slot — a valid input that lets any model run.
  const s = new Float32Array(STYLE_DIM);
  s[STYLE_DIM - 1] = 1.0;
  return s;
}

function concatFeatures(board: Float32Array): Float32Array {
  const f = new Float32Array(BOARD_DIM + STYLE_DIM);
  f.set(board, 0);
  f.set(styleHalf(), BOARD_DIM);
  return f;
}

async function runEquity(board: Float32Array): Promise<number> {
  const ort = _ort!;
  const session = _session!;
  const runBoard = async () => {
    const t = new ort.Tensor("float32", board, [1, BOARD_DIM]);
    const r = await session.run({ [_inputName]: t });
    return r.equity.data[0] as number;
  };
  const runConcat = async () => {
    const feats = concatFeatures(board);
    const t = new ort.Tensor("float32", feats, [1, feats.length]);
    const r = await session.run({ [_inputName]: t });
    return r.equity.data[0] as number;
  };
  if (_featMode === "board") return runBoard();
  if (_featMode === "concat") return runConcat();
  // First call: detect the contract. Board-only models (base/legacy) succeed
  // here; board+style models reject the 198-wide input, so we retry with style.
  try {
    const v = await runBoard();
    _featMode = "board";
    return v;
  } catch {
    const v = await runConcat();
    _featMode = "concat";
    return v;
  }
}

async function initORT(modelBytes?: ArrayBuffer): Promise<void> {
  const ort = (await import("onnxruntime-web")) as OrtNs;
  ort.env.wasm.wasmPaths = "/js/";
  ort.env.wasm.numThreads = 1;
  const buf = modelBytes ?? await loadModelBytes();
  _session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
  _inputName = _session.inputNames?.[0] ?? "board";
  _featMode = "unknown";
  _ort = ort;
}

// ── Message types ──────────────────────────────────────────────────────────

interface InitMsg {
  type: "init";
  /** Optional per-agent ONNX bytes. When provided the model is loaded from
   *  these bytes instead of fetching /backgammon_net.onnx. Transfer the
   *  ArrayBuffer as a Transferable so the main thread cedes ownership. */
  modelBytes?: ArrayBuffer;
  /** Optional style vector (career_features 40-d layout) for the loaded agent.
   *  Fed as the second half of `features = [board ‖ style]`. When omitted, a
   *  neutral style is used so board+style models still run. */
  styleVec?: number[];
}
interface EvaluateMsg {
  type: "evaluate";
  id: string;
  board: Board;
  side: number;
  dice: [number, number];
}

// globalThis in a worker is DedicatedWorkerGlobalScope. TypeScript's dom lib
// types it as Window; cast to a minimal interface to get the right postMessage overload.
interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}
const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = async (event: MessageEvent<InitMsg | EvaluateMsg>) => {
  const msg = event.data;

  if (msg.type === "init") {
    const initMsg = msg as InitMsg;
    _styleVec = initMsg.styleVec ? Float32Array.from(initMsg.styleVec) : null;
    try {
      await initORT(initMsg.modelBytes);
      workerScope.postMessage({ type: "init_ok" });
    } catch (e) {
      workerScope.postMessage({ type: "init_err", message: String(e) });
    }
    return;
  }

  if (msg.type === "evaluate") {
    const { id, board, side, dice } = msg;
    if (!_session || !_ort) {
      workerScope.postMessage({ type: "evaluate_err", id, message: "not initialized" });
      return;
    }
    try {
      const moves = generateLegalMoves(board, side, dice);
      const candidates: Array<{ move: string; equity: number }> = [];
      for (const moveStr of moves) {
        const nextBoard = applyMove(board, side, moveStr);
        const feat = encodeFullBoard(nextBoard, 1 - side);
        const prob = await runEquity(feat);
        candidates.push({ move: moveStr, equity: 1 - prob });
      }
      candidates.sort((a, b) => b.equity - a.equity);
      workerScope.postMessage({ type: "evaluate_ok", id, candidates });
    } catch (e) {
      workerScope.postMessage({ type: "evaluate_err", id, message: String(e) });
    }
  }
};
