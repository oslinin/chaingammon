import type { Board } from "./rules_engine";

export interface CandidateMove {
  move: string;
  equity: number;
}

// ── Worker lifecycle ───────────────────────────────────────────────────────

type Pending = { resolve: (v: CandidateMove[]) => void; reject: (e: Error) => void };

let _worker: Worker | null = null;
let _initPromise: Promise<void> | null = null;
let _initResolve: (() => void) | null = null;
let _initReject: ((e: Error) => void) | null = null;
let _initDone = false;
let _initFailed = false;
let _nextId = 0;
const _pending = new Map<string, Pending>();

function handleMessage(event: MessageEvent) {
  const msg = event.data as Record<string, unknown>;

  if (msg.type === "init_ok") {
    _initDone = true;
    _initResolve?.();
    return;
  }

  if (msg.type === "init_err") {
    _initFailed = true;
    _initDone = true;
    console.warn("[onnx] worker init failed:", msg.message);
    _initReject?.(new Error(String(msg.message)));
    return;
  }

  if (msg.type === "evaluate_ok") {
    const id = msg.id as string;
    const p = _pending.get(id);
    if (p) {
      _pending.delete(id);
      p.resolve(msg.candidates as CandidateMove[]);
    }
    return;
  }

  if (msg.type === "evaluate_err") {
    const id = msg.id as string;
    const p = _pending.get(id);
    if (p) {
      _pending.delete(id);
      p.reject(new Error(String(msg.message)));
    }
  }
}

function getWorker(): Worker {
  if (!_worker) {
    _worker = new Worker(new URL("./onnx_worker.ts", import.meta.url));
    _worker.onmessage = handleMessage;
    _worker.onerror = (e) => console.error("[onnx] worker error:", e.message);
  }
  return _worker;
}

function ensureInit(): Promise<void> {
  if (_initDone && !_initFailed) return Promise.resolve();
  if (_initFailed) return Promise.reject(new Error("ONNX runtime previously failed to initialize"));
  if (!_initPromise) {
    _initPromise = new Promise<void>((resolve, reject) => {
      _initResolve = resolve;
      _initReject = reject;
      getWorker().postMessage({ type: "init" });
    });
  }
  return _initPromise;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Start loading the ONNX runtime in the background. Safe to call multiple
 * times — subsequent calls are no-ops once the promise is in flight or done.
 * Call this from the app root so the model is ready before the first move.
 */
export function warmupOnnx(): void {
  if (typeof window === "undefined") return;
  ensureInit().catch(() => {
    // Failure is recorded in _initFailed; evaluateMoves will throw, and
    // callers fall back to heuristic move selection.
  });
}

export async function evaluateMoves(
  board: Board,
  side: number,
  dice: [number, number]
): Promise<CandidateMove[]> {
  await ensureInit();
  const id = String(_nextId++);
  return new Promise<CandidateMove[]>((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: "evaluate", id, board, side, dice });
  });
}
