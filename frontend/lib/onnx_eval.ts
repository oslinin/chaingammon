import type * as ORT from "onnxruntime-web";
import { Board, generateLegalMoves, encodeFullBoard, applyMove } from "./rules_engine";

type OrtNs = typeof ORT;

let _ort: OrtNs | null = null;
let _session: ORT.InferenceSession | null = null;
let _initPromise: Promise<void> | null = null;
let _initFailed = false;
let _oomHandlerInstalled = false;

// Suppress unhandled rejections that originate inside ORT Web's own WASM
// bootstrap code. Those promises are created deep inside ort-wasm-simd-*.mjs
// and are never returned to our code, so we can't attach .catch() to them.
// Filtering by the known "no available backend" message keeps this targeted.
function installOOMHandler() {
  if (_oomHandlerInstalled || typeof window === "undefined") return;
  _oomHandlerInstalled = true;
  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const msg = String(event.reason?.message ?? event.reason ?? "");
    if (msg.includes("no available backend found") || msg.includes("initWasm")) {
      event.preventDefault();
      console.warn("[onnx] WASM runtime unavailable — Move Advisor falling back to heuristic ranking");
    }
  });
}

async function initRuntime(): Promise<void> {
  installOOMHandler();
  if (_session) return;
  if (_initFailed) throw new Error("ONNX runtime previously failed to initialize");
  if (!_initPromise) {
    _initPromise = (async () => {
      const ort = (await import("onnxruntime-web")) as OrtNs;
      ort.env.wasm.wasmPaths = "/js/";
      ort.env.wasm.numThreads = 1;
      const buf = await fetch("/backgammon_net.onnx").then((r) => r.arrayBuffer());
      // Force the plain WASM CPU backend (ort-wasm-simd-threaded.wasm, ~13 MB).
      // Without this, ORT tries the JSEP backend first (ort-wasm-simd-threaded.jsep.wasm,
      // ~26 MB) which exhausts browser memory and aborts with OOM.
      _session = await ort.InferenceSession.create(buf, {
        executionProviders: ["wasm"],
      });
      _ort = ort;
    })().catch((e) => {
      _initFailed = true;
      _initPromise = null;
      throw e;
    });
  }
  return _initPromise;
}

/**
 * Start loading the ONNX runtime in the background. Safe to call multiple
 * times — subsequent calls are no-ops once the promise is in flight or done.
 * Call this from the app root so the model is ready before the first move.
 */
export function warmupOnnx(): void {
  if (typeof window === "undefined") return;
  initRuntime().catch(() => {
    // Failure is already recorded in _initFailed; evaluateMoves degrades
    // gracefully to heuristic ranking when _initFailed is true.
  });
}

export async function getSession(): Promise<ORT.InferenceSession> {
  await initRuntime();
  return _session!;
}

export interface CandidateMove {
  move: string;
  equity: number;
}

export async function evaluateMoves(
  board: Board,
  side: number,
  dice: [number, number]
): Promise<CandidateMove[]> {
  const moves = generateLegalMoves(board, side, dice);
  if (moves.length === 0) return [];

  await initRuntime();
  const sess = _session!;
  const ort = _ort!;
  const candidates: CandidateMove[] = [];

  for (const moveStr of moves) {
    const nextBoard = applyMove(board, side, moveStr);
    const feat = encodeFullBoard(nextBoard, 1 - side);
    const tensor = new ort.Tensor("float32", feat, [1, 198]);
    const results = await sess.run({ board: tensor });
    const prob = results.equity.data[0] as number;
    candidates.push({ move: moveStr, equity: 1 - prob });
  }

  candidates.sort((a, b) => b.equity - a.equity);
  return candidates;
}
