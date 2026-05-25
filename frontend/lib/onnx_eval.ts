import type { Board } from "./rules_engine";

export interface CandidateMove {
  move: string;
  equity: number;
}

// ── Per-agent evaluator (named, isolated Web Worker per agent) ─────────────

interface AgentEntry {
  evaluate: (board: Board, side: number, dice: [number, number]) => Promise<CandidateMove[]>;
  destroy: () => void;
}

const _agentEvals = new Map<number, AgentEntry>();

function _makeAgentEntry(modelBytes: ArrayBuffer, styleVec?: number[]): AgentEntry {
  const pending = new Map<string, Pending>();
  let nextId = 0;
  let initResolve: (() => void) | null = null;
  let initReject: ((e: Error) => void) | null = null;

  const worker = new Worker(new URL("./onnx_worker.ts", import.meta.url));

  const initPromise = new Promise<void>((res, rej) => {
    initResolve = res;
    initReject = rej;
  });

  worker.onmessage = (event: MessageEvent) => {
    const msg = event.data as Record<string, unknown>;
    if (msg.type === "init_ok") { initResolve?.(); return; }
    if (msg.type === "init_err") { initReject?.(new Error(String(msg.message))); return; }
    if (msg.type === "evaluate_ok") {
      const p = pending.get(msg.id as string);
      if (p) { pending.delete(msg.id as string); p.resolve(msg.candidates as CandidateMove[]); }
      return;
    }
    if (msg.type === "evaluate_err") {
      const p = pending.get(msg.id as string);
      if (p) { pending.delete(msg.id as string); p.reject(new Error(String(msg.message))); }
    }
  };
  worker.onerror = (e) => initReject?.(new Error(e.message));

  worker.postMessage({ type: "init", modelBytes, styleVec }, [modelBytes]);

  return {
    evaluate: async (board, side, dice) => {
      await initPromise;
      const id = String(nextId++);
      return new Promise<CandidateMove[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "evaluate", id, board, side, dice });
      });
    },
    destroy: () => worker.terminate(),
  };
}

/**
 * Load an agent's ONNX model into its own isolated Web Worker.
 * Replaces any existing evaluator for this agentId.
 * Transfers ownership of modelBytes — do not use the buffer after calling this.
 */
export function createAgentEvaluator(
  agentId: number,
  modelBytes: ArrayBuffer,
  styleVec?: number[],
): void {
  destroyAgentEvaluator(agentId);
  _agentEvals.set(agentId, _makeAgentEntry(modelBytes, styleVec));
}

/** Tear down the isolated worker for this agent. */
export function destroyAgentEvaluator(agentId: number): void {
  _agentEvals.get(agentId)?.destroy();
  _agentEvals.delete(agentId);
}

/** Evaluate moves with a specific agent's model. Falls back to the base model if not loaded. */
export async function evaluateMovesWithAgent(
  agentId: number,
  board: Board,
  side: number,
  dice: [number, number],
): Promise<CandidateMove[]> {
  const entry = _agentEvals.get(agentId);
  if (!entry) return evaluateMoves(board, side, dice);
  try {
    return await entry.evaluate(board, side, dice);
  } catch {
    return evaluateMoves(board, side, dice);
  }
}

/**
 * Ensemble evaluation: run all listed agents in parallel, average equity per
 * move across agents, return sorted candidates. Falls back to base model when
 * agentIds is empty or none are loaded.
 */
export async function evaluateTeamMoves(
  agentIds: number[],
  board: Board,
  side: number,
  dice: [number, number],
): Promise<CandidateMove[]> {
  const loaded = agentIds.filter(id => _agentEvals.has(id));
  if (loaded.length === 0) return evaluateMoves(board, side, dice);

  const results = await Promise.all(
    loaded.map(id => evaluateMovesWithAgent(id, board, side, dice))
  );

  // Average equity per move across all agents.
  const equityMap = new Map<string, { total: number; count: number }>();
  for (const candidates of results) {
    for (const { move, equity } of candidates) {
      const e = equityMap.get(move) ?? { total: 0, count: 0 };
      e.total += equity;
      e.count += 1;
      equityMap.set(move, e);
    }
  }

  return Array.from(equityMap.entries())
    .map(([move, { total, count }]) => ({ move, equity: total / count }))
    .sort((a, b) => b.equity - a.equity);
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

/**
 * Re-initialize the ONNX worker with a per-agent model.
 *
 * Terminates the existing worker (if any) and starts a new one using the
 * provided ONNX bytes. After this call, `evaluateMoves` uses the agent's
 * model instead of the bundled base model.
 *
 * The caller transfers ownership of `modelBytes` — do not use the buffer
 * after calling this function.
 *
 * `styleVec` is the agent's 40-d style vector (career_features layout). When
 * the model is a board+style model it is fed as the second half of
 * `features = [board ‖ style]`; omit it and the worker uses a neutral style.
 */
export async function loadAgentModel(
  modelBytes: ArrayBuffer,
  styleVec?: number[],
): Promise<void> {
  if (_worker) {
    _worker.terminate();
    _worker = null;
  }
  _initDone = false;
  _initFailed = false;
  _initPromise = null;
  _initResolve = null;
  _initReject = null;
  _pending.clear();

  _initPromise = new Promise<void>((resolve, reject) => {
    _initResolve = resolve;
    _initReject = reject;
    // Transfer modelBytes so the worker owns the memory.
    getWorker().postMessage({ type: "init", modelBytes, styleVec }, [modelBytes]);
  });
  return _initPromise;
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
