// Dedicated Web Worker for ONNX inference.
// Running ORT here isolates WASM compilation from the main thread's heap,
// preventing the streaming-compile OOM that occurs under main-thread memory
// pressure (large page + WASM binary competing for the same arena).

import type * as ORT from "onnxruntime-web";
import { generateLegalMoves, encodeFullBoard, applyMove } from "./rules_engine";
import type { Board } from "./rules_engine";

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

async function initORT(): Promise<void> {
  const ort = (await import("onnxruntime-web")) as OrtNs;
  ort.env.wasm.wasmPaths = "/js/";
  ort.env.wasm.numThreads = 1;
  const buf = await loadModelBytes();
  _session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
  _ort = ort;
}

// ── Message types ──────────────────────────────────────────────────────────

interface InitMsg { type: "init" }
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
    try {
      await initORT();
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
        const tensor = new _ort.Tensor("float32", feat, [1, 198]);
        const results = await _session.run({ board: tensor });
        const prob = results.equity.data[0] as number;
        candidates.push({ move: moveStr, equity: 1 - prob });
      }
      candidates.sort((a, b) => b.equity - a.equity);
      workerScope.postMessage({ type: "evaluate_ok", id, candidates });
    } catch (e) {
      workerScope.postMessage({ type: "evaluate_err", id, message: String(e) });
    }
  }
};
