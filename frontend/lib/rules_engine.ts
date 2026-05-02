/**
 * rules_engine.ts — pure-TypeScript backgammon move legality.
 *
 * Browser-side companion to agent/rules_engine.py. Shares the same
 * board encoding and move-notation conventions so a KeeperHub audit
 * replayer running in the browser produces bit-identical results to
 * the Python settlement validator.
 *
 * Board encoding:
 *   - 24-element `points` array indexed 0..23 (points[0] = point 1).
 *   - Positive counts = player 0 checkers; negative = player 1.
 *   - Player 0 moves 24 → 1 (high-to-low index).
 *   - Player 1 moves 1 → 24 (low-to-high index).
 *   - BAR_SRC = 25 (player 0 entering from bar), BAR_SRC_P1 = 0 (player 1).
 *   - OFF_DST = 0 (player 0 bearing off), OFF_DST_P1 = 25 (player 1).
 *
 * Scope mirrors the Python version — common cases only, no cube rules.
 */

export const NUM_POINTS = 24;
export const BAR_SRC = 25;    // player 0 enters from bar (sentinel src)
export const BAR_SRC_P1 = 0;  // player 1 enters from bar (sentinel src)
export const OFF_DST = 0;     // player 0 bears off (sentinel dst)
export const OFF_DST_P1 = 25; // player 1 bears off (sentinel dst)

export interface Board {
  /** 24 signed checker counts (positive = player 0, negative = player 1). */
  points: number[];
  /** [p0_on_bar, p1_on_bar] */
  bar: [number, number];
  /** [p0_borne_off, p1_borne_off] */
  off: [number, number];
}

export interface CheckerMove {
  src: number;
  dst: number;
  hit: boolean;
}

/** Standard backgammon opening position (player 0 perspective). */
export const OPENING_BOARD: Board = {
  points: [
    -2,  0,  0,  0,  0,  5,  // points 1-6
     0,  3,  0,  0,  0, -5,  // points 7-12
     5,  0,  0,  0, -3,  0,  // points 13-18
    -5,  0,  0,  0,  0,  2,  // points 19-24
  ],
  bar: [0, 0],
  off: [0, 0],
};

/**
 * Parse a gnubg-format move string into individual checker movements.
 *
 * @example parseMove("8/5 6/5", 0) → [{src:8,dst:5,hit:false}, {src:6,dst:5,hit:false}]
 * @example parseMove("bar/22", 0)  → [{src:25,dst:22,hit:false}]
 * @example parseMove("6/off", 0)   → [{src:6,dst:0,hit:false}]
 * @example parseMove("13/8*", 0)   → [{src:13,dst:8,hit:true}]
 */
export function parseMove(moveStr: string, side: number): CheckerMove[] {
  const moves: CheckerMove[] = [];
  const re = /(\d+|bar)\/(\d+|off)(\*?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(moveStr)) !== null) {
    const rawSrc = m[1].toLowerCase();
    const rawDst = m[2].toLowerCase();
    const hit = m[3] === "*";
    const src =
      rawSrc === "bar" ? (side === 0 ? BAR_SRC : BAR_SRC_P1) : parseInt(rawSrc, 10);
    const dst =
      rawDst === "off" ? (side === 0 ? OFF_DST : OFF_DST_P1) : parseInt(rawDst, 10);
    moves.push({ src, dst, hit });
  }
  return moves;
}

/** Returns the full pip pool for a dice roll (doubles → four pips). */
export function dicePool(dice: [number, number]): number[] {
  const [d1, d2] = dice;
  return d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
}

function pipConsumed(checker: CheckerMove, side: number): number {
  if (side === 0) {
    if (checker.src === BAR_SRC) return BAR_SRC - checker.dst;
    if (checker.dst === OFF_DST) return checker.src;
    return checker.src - checker.dst;
  }
  if (checker.src === BAR_SRC_P1) return checker.dst;
  if (checker.dst === OFF_DST_P1) return BAR_SRC_P1 + (NUM_POINTS + 1 - checker.src);
  return checker.dst - checker.src;
}

function allInHome(points: number[], bar: number[], side: number): boolean {
  if (bar[side] > 0) return false;
  if (side === 0) return points.slice(6).every((c) => c <= 0);
  return points.slice(0, 18).every((c) => c >= 0);
}

/**
 * Check whether `moveStr` is legal from `board` for `side` given `dice`.
 *
 * Returns false for malformed move strings, wrong pips, blocked destinations,
 * source points the side doesn't own, bar-entry violations, and bear-off
 * attempted before all checkers are in the home board.
 */
export function isLegal(
  board: Board,
  dice: [number, number],
  side: number,
  moveStr: string,
): boolean {
  const pieces = parseMove(moveStr, side);
  if (pieces.length === 0) return false;

  const pool = dicePool(dice);
  const barSrc = side === 0 ? BAR_SRC : BAR_SRC_P1;

  if (board.bar[side] > 0 && pieces[0].src !== barSrc) return false;

  const simPoints = [...board.points];
  const simBar = [...board.bar];
  const available = [...pool];

  for (const piece of pieces) {
    const pip = pipConsumed(piece, side);
    const pipIdx = available.indexOf(pip);
    if (pipIdx === -1) return false;
    available.splice(pipIdx, 1);

    // Validate and lift from source.
    if (piece.src === barSrc) {
      if (simBar[side] <= 0) return false;
      simBar[side]--;
    } else {
      const srcIdx = piece.src - 1;
      if (srcIdx < 0 || srcIdx >= NUM_POINTS) return false;
      if (side === 0 && simPoints[srcIdx] <= 0) return false;
      if (side === 1 && simPoints[srcIdx] >= 0) return false;
      simPoints[srcIdx] += side === 0 ? -1 : 1;
    }

    // Validate and place at destination.
    const offDst = side === 0 ? OFF_DST : OFF_DST_P1;
    if (piece.dst === offDst) {
      if (!allInHome(simPoints, simBar, side)) return false;
    } else {
      const dstIdx = piece.dst - 1;
      if (dstIdx < 0 || dstIdx >= NUM_POINTS) return false;
      const dstCount = simPoints[dstIdx];
      if (side === 0) {
        if (dstCount <= -2) return false;
        if (dstCount === -1) {
          if (!piece.hit) return false;
          simBar[1]++;
          simPoints[dstIdx] = 1;
        } else {
          simPoints[dstIdx]++;
        }
      } else {
        if (dstCount >= 2) return false;
        if (dstCount === 1) {
          if (!piece.hit) return false;
          simBar[0]++;
          simPoints[dstIdx] = -1;
        } else {
          simPoints[dstIdx]--;
        }
      }
    }
  }

  return true;
}

/**
 * Apply a move (assumed valid) to `board` and return the resulting board.
 * Does not mutate the input. Caller must call `isLegal` first.
 */
export function applyMove(board: Board, side: number, moveStr: string): Board {
  const pieces = parseMove(moveStr, side);
  const simPoints = [...board.points];
  const simBar: [number, number] = [board.bar[0], board.bar[1]];
  const simOff: [number, number] = [board.off[0], board.off[1]];

  const barSrc = side === 0 ? BAR_SRC : BAR_SRC_P1;
  const offDst = side === 0 ? OFF_DST : OFF_DST_P1;

  for (const piece of pieces) {
    // Lift from source.
    if (piece.src === barSrc) {
      simBar[side]--;
    } else {
      const srcIdx = piece.src - 1;
      simPoints[srcIdx] += side === 0 ? -1 : 1;
    }

    // Place at destination.
    if (piece.dst === offDst) {
      simOff[side]++;
    } else {
      const dstIdx = piece.dst - 1;
      if (side === 0) {
        if (simPoints[dstIdx] === -1) {
          simBar[1]++;
          simPoints[dstIdx] = 1;
        } else {
          simPoints[dstIdx]++;
        }
      } else {
        if (simPoints[dstIdx] === 1) {
          simBar[0]++;
          simPoints[dstIdx] = -1;
        } else {
          simPoints[dstIdx]--;
        }
      }
    }
  }

  return { points: simPoints, bar: simBar, off: simOff };
}

export interface MoveValidationResult {
  valid: boolean;
  /** Index of the first invalid move, or -1 when all moves are valid. */
  firstInvalidIndex: number;
  /** Human-readable error for the first invalid move, or null. */
  error: string | null;
}

/**
 * Validate a full sequence of game-record move entries against backgammon rules.
 *
 * Each entry must have `turn` (0|1), `dice` ([d1, d2]), and `move` (gnubg notation).
 * Entries with an empty or `"(auto-played)"` move string are skipped.
 */
export function validateGameMoves(
  moves: Array<{ turn: number; dice: number[]; move: string }>,
): MoveValidationResult {
  let board = { ...OPENING_BOARD, points: [...OPENING_BOARD.points] };

  for (let i = 0; i < moves.length; i++) {
    const entry = moves[i];
    const moveStr = entry.move ?? "";
    if (!moveStr || moveStr === "(auto-played)") continue;

    const dice = [entry.dice[0], entry.dice[1]] as [number, number];
    const side = entry.turn as 0 | 1;

    if (!isLegal(board, dice, side, moveStr)) {
      return {
        valid: false,
        firstInvalidIndex: i,
        error: `move #${i} violates backgammon rules — side ${side}, dice ${JSON.stringify(dice)}, move "${moveStr}"`,
      };
    }

    board = applyMove(board, side, moveStr);
  }

  return { valid: true, firstInvalidIndex: -1, error: null };
}
