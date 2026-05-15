import * as ort from "onnxruntime-web";
import { Board, generateLegalMoves, encodeFullBoard, applyMove } from "./rules_engine";

ort.env.wasm.wasmPaths = "/js/";
// numThreads=1 means the threaded WASM binary runs on the main thread only;
// SharedArrayBuffer / COOP-COEP headers are not required.
ort.env.wasm.numThreads = 1;

let session: ort.InferenceSession | null = null;
let sessionPromise: Promise<ort.InferenceSession> | null = null;

// Deduplicate concurrent cold-start requests so only one InferenceSession is created.
export async function getSession(): Promise<ort.InferenceSession> {
  if (session) return session;
  if (!sessionPromise) {
    // Fetch as ArrayBuffer so ORT Web never tries to load a separate .data
    // file and the browser cache of any previous broken model is bypassed.
    sessionPromise = fetch("/backgammon_net.onnx")
      .then(r => r.arrayBuffer())
      .then(buf => ort.InferenceSession.create(buf))
      .then(s => { session = s; return s; })
      .catch(e => { sessionPromise = null; throw e; });
  }
  return sessionPromise;
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

  const sess = await getSession();
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
