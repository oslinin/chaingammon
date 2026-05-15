/**
 * match_engine.ts — client-side backgammon match engine.
 *
 * Replaces the local gnubg_service (port 8001) entirely. All game logic
 * runs in the browser:
 *   - Move legality and application: rules_engine.ts
 *   - Neural-net move selection:     onnx_eval.ts (BackgammonNet)
 *   - Position/match encoding:       gnubg_state.ts (gnubg-compatible IDs
 *                                    for settlement / KeeperHub wiring)
 *
 * The exported MatchState interface is a drop-in replacement for the
 * previous gnubg_service MatchStateDict so callers need no type changes.
 */

import {
  Board,
  OPENING_BOARD,
  applyMove,
  isLegal,
  generateLegalMoves,
} from "./rules_engine";
import { evaluateMoves, CandidateMove } from "./onnx_eval";
import { encodePositionId, encodeMatchId } from "./gnubg_state";

// ── Public types ──────────────────────────────────────────────────────────────

export interface MatchState {
  position_id: string;
  match_id: string;
  board: number[];
  bar: [number, number];
  off: [number, number];
  turn: 0 | 1;
  dice: [number, number] | null;
  score: [number, number];
  match_length: number;
  game_over: boolean;
  winner: 0 | 1 | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toBoard(state: MatchState): Board {
  return { points: state.board, bar: state.bar, off: state.off };
}

function makeState(
  board: Board,
  turn: 0 | 1,
  score: [number, number],
  matchLength: number,
  gameOver: boolean,
  winner: 0 | 1 | null,
  resign = false,
  dice: [number, number] | null = null
): MatchState {
  return {
    position_id: encodePositionId(board),
    match_id: encodeMatchId(turn, matchLength, score, gameOver, resign ? 1 : 0),
    board: board.points,
    bar: board.bar,
    off: board.off,
    turn,
    dice,
    score,
    match_length: matchLength,
    game_over: gameOver,
    winner,
  };
}

function freshBoard(): Board {
  return {
    points: [...OPENING_BOARD.points],
    bar: [0, 0],
    off: [0, 0],
  };
}

function randomDie(): number {
  return Math.floor(Math.random() * 6) + 1;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Create the opening state for a new match. No dice — caller rolls. */
export function newMatch(matchLength = 3): MatchState {
  return makeState(freshBoard(), 0, [0, 0], matchLength, false, null);
}

/**
 * Apply a move string to the current state. Validates legality; throws
 * on an illegal or malformed move. Handles game/match score transitions:
 *   - When a player bears off all 15 checkers → score incremented.
 *   - If winner's score reaches match_length → game_over=true.
 *   - Otherwise → board resets for the next game, match continues.
 */
export function applyMoveToState(state: MatchState, moveStr: string): MatchState {
  if (!state.dice) throw new Error("No dice to play");
  const board = toBoard(state);
  const side = state.turn;

  if (!isLegal(board, state.dice, side, moveStr)) {
    throw new Error(`Illegal move: ${moveStr}`);
  }

  const newBoard = applyMove(board, side, moveStr);

  if (newBoard.off[side] === 15) {
    // Current player bore off all checkers — wins this game (1 pt, no cube).
    const newScore: [number, number] =
      side === 0
        ? [state.score[0] + 1, state.score[1]]
        : [state.score[0], state.score[1] + 1];

    const matchOver =
      newScore[0] >= state.match_length || newScore[1] >= state.match_length;

    if (matchOver) {
      return makeState(newBoard, side, newScore, state.match_length, true, side);
    }

    // Match continues — reset board, swap turn.
    const nextTurn = (1 - side) as 0 | 1;
    return makeState(freshBoard(), nextTurn, newScore, state.match_length, false, null);
  }

  const nextTurn = (1 - side) as 0 | 1;
  return makeState(newBoard, nextTurn, state.score, state.match_length, false, null);
}

/** Pass the turn without moving (bar-dance: checker on bar, board closed). */
export function skipTurn(state: MatchState): MatchState {
  const nextTurn = (1 - state.turn) as 0 | 1;
  return makeState(toBoard(state), nextTurn, state.score, state.match_length, false, null);
}

/** Human forfeits — agent (side 1) wins the match. */
export function resignMatch(state: MatchState): MatchState {
  const agentWinner: 0 | 1 = 1;
  const newScore: [number, number] = [state.score[0], state.score[1] + 1];
  return makeState(
    toBoard(state),
    state.turn,
    newScore,
    state.match_length,
    true,
    agentWinner,
    true,
  );
}

/**
 * Pick the best move for the current side using the BackgammonNet ONNX model.
 * Returns null when there are no legal moves (bar-dance).
 */
export async function getBestMove(
  board: Board,
  side: 0 | 1,
  dice: [number, number]
): Promise<string | null> {
  const candidates = await evaluateMoves(board, side, dice);
  return candidates.length > 0 ? candidates[0].move : null;
}

/**
 * Evaluate legal moves and return ranked candidates (at most topN).
 * Used by the coach panel to get candidates before calling the LLM.
 */
export async function evaluateCandidates(
  board: Board,
  side: 0 | 1,
  dice: [number, number],
  topN = 3
): Promise<CandidateMove[]> {
  const candidates = await evaluateMoves(board, side, dice);
  return candidates.slice(0, topN);
}

/**
 * Check whether the current side has any legal moves at all.
 * Used to detect bar-dance situations before skipping the turn.
 */
export function hasLegalMoves(
  board: Board,
  side: 0 | 1,
  dice: [number, number]
): boolean {
  return generateLegalMoves(board, side, dice).length > 0;
}

/**
 * Fast-forward: run the full remaining match with both sides picking a random
 * legal move. Returns the final MatchState.
 *
 * Intentionally avoids ONNX inference — evaluating every candidate position
 * through the neural net would take 10–30 s for a full match. Random play
 * is sufficient for a UX fast-forward.
 *
 * Yields to the browser every 100 half-moves so the UI stays responsive.
 * Bound to 3000 half-moves (enough for a multi-game match with random play).
 * Dice are rolled locally (Math.random) — this is a UX shortcut, not the
 * rated path (which uses drand for verifiable randomness).
 */
export async function playMatchToEnd(state: MatchState): Promise<MatchState> {
  let s = state;

  for (let i = 0; i < 3000 && !s.game_over; i++) {
    if (i % 100 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    const dice: [number, number] = s.dice ?? [randomDie(), randomDie()];
    const stateWithDice: MatchState = { ...s, dice };
    const board = toBoard(stateWithDice);

    const moves = generateLegalMoves(board, s.turn, dice).filter((m) => m.trim());
    if (moves.length === 0) {
      s = skipTurn(stateWithDice);
      continue;
    }

    const move = moves[Math.floor(Math.random() * moves.length)];
    try {
      s = applyMoveToState(stateWithDice, move);
    } catch {
      s = skipTurn(stateWithDice);
    }
  }

  return s;
}
