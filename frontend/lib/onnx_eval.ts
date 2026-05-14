import * as ort from "onnxruntime-web";
import { Board, generateLegalMoves, encodeFullBoard, applyMove } from "./rules_engine";

ort.env.wasm.wasmPaths = "/js/";

let session: ort.InferenceSession | null = null;

export async function getSession(): Promise<ort.InferenceSession> {
  if (!session) {
    session = await ort.InferenceSession.create("/backgammon_net.onnx");
  }
  return session;
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
    const nextPerspective = 1 - side;
    const feat = encodeFullBoard(nextBoard, nextPerspective);

    const tensor = new ort.Tensor("float32", feat, [1, 198]);
    const results = await sess.run({ board: tensor });
    const equityTensor = results.equity;
    const nextPlayerWinProb = equityTensor.data[0] as number;
    const equity = 1.0 - nextPlayerWinProb;

    candidates.push({ move: moveStr, equity });
  }

  candidates.sort((a, b) => b.equity - a.equity);
  return candidates;
}
