/**
 * team_play.spec.ts — end-to-end game simulation for the team-play scenario.
 *
 * Exercises the full rules_engine + move_tagger pipeline that powers both the
 * human team (side 0) and the agent opponent team (side 1) in the team-demo
 * page.  No ONNX / browser required: move selection uses the heuristic tagger
 * (Blitz > Aggressive > Priming > Anchor > Safe) so the test runs under the
 * plain Playwright Node runner.
 *
 * Invariants checked every ply:
 *   - All chosen moves come from generateLegalMoves
 *   - Total checkers on board + bar + off remains 30 throughout
 *   - Tags are drawn from the five canonical values
 *   - A game finishes in ≤ 400 half-moves
 */

import { test, expect } from "@playwright/test";
import {
  generateLegalMoves,
  applyMove,
  OPENING_BOARD,
  Board,
} from "../lib/rules_engine";
import { tagCandidates } from "../lib/move_tagger";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TAG_PRIORITY: Record<string, number> = {
  Blitz: 5,
  Aggressive: 4,
  Priming: 3,
  Anchor: 2,
  Safe: 1,
};

const VALID_TAGS = new Set(["Safe", "Aggressive", "Priming", "Anchor", "Blitz"]);

function freshBoard(): Board {
  return {
    points: [...OPENING_BOARD.points],
    bar: [0, 0],
    off: [0, 0],
  };
}

function rollDice(): [number, number] {
  return [
    Math.floor(Math.random() * 6) + 1,
    Math.floor(Math.random() * 6) + 1,
  ];
}

/**
 * Pick the highest-priority move using the heuristic tagger.
 * Blitz beats Aggressive beats Priming beats Anchor beats Safe.
 * Within the same tag, the tagger's internal order (index 0 = first legal move)
 * is preserved so the choice is deterministic for a given move list.
 */
function pickMove(moves: string[], boardPoints: number[]): string {
  if (moves.length === 1) return moves[0];
  const unranked = moves.map((m, i) => ({ move: m, equity: -i * 0.001 }));
  const tagged = tagCandidates(unranked, boardPoints, moves.length);
  const sorted = [...tagged].sort(
    (a, b) => (TAG_PRIORITY[b.tag] ?? 1) - (TAG_PRIORITY[a.tag] ?? 1),
  );
  return sorted[0].move;
}

/**
 * Play one complete game of backgammon.
 * Side 0 = human + Agent Teammate team.
 * Side 1 = opponent agent team.
 * Both sides use the heuristic move picker.
 *
 * Returns the winner (0 or 1) and the number of half-moves played.
 * Throws if the game exceeds MAX_PLIES.
 */
function playOneGame(): { winner: 0 | 1; plies: number } {
  let board = freshBoard();
  let turn: 0 | 1 = 0;
  const MAX_PLIES = 400;

  for (let ply = 0; ply < MAX_PLIES; ply++) {
    const dice = rollDice();
    const moves = generateLegalMoves(board, turn, dice);

    if (moves.length > 0) {
      board = applyMove(board, turn, pickMove(moves, board.points));
    }
    // else: no legal moves (bar-dance) — turn passes without moving

    if (board.off[turn] === 15) {
      return { winner: turn, plies: ply + 1 };
    }

    turn = (1 - turn) as 0 | 1;
  }

  throw new Error(`Game did not finish in ${MAX_PLIES} half-moves`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("single game reaches game_over with a valid winner", () => {
  const { winner, plies } = playOneGame();

  expect([0, 1]).toContain(winner);
  // A real backgammon game takes at least ~10 half-moves and fewer than 400.
  expect(plies).toBeGreaterThan(10);
  expect(plies).toBeLessThan(400);
});

test("3-point match terminates with correct score", () => {
  const MATCH_LENGTH = 3;
  const score: [number, number] = [0, 0];
  let gameCount = 0;

  while (score[0] < MATCH_LENGTH && score[1] < MATCH_LENGTH) {
    const { winner } = playOneGame();
    score[winner]++;
    gameCount++;
    // Guard against an infinite loop in case of a bug
    expect(gameCount).toBeLessThan(30);
  }

  const matchWinner: 0 | 1 = score[0] >= MATCH_LENGTH ? 0 : 1;
  expect(score[matchWinner]).toBe(MATCH_LENGTH);
  expect(score[1 - matchWinner]).toBeLessThan(MATCH_LENGTH);
});

test("move tagger assigns valid strategic labels on every ply", () => {
  let board = freshBoard();
  let turn: 0 | 1 = 0;
  const tagCounts: Record<string, number> = {};
  let plies = 0;

  for (let ply = 0; ply < 120; ply++) {
    const dice = rollDice();
    const moves = generateLegalMoves(board, turn, dice);

    if (moves.length > 0) {
      const unranked = moves.map((m, i) => ({ move: m, equity: -i * 0.001 }));
      const tagged = tagCandidates(unranked, board.points, moves.length);

      for (const tc of tagged) {
        expect(VALID_TAGS).toContain(tc.tag);
        expect(tc.tag_reason.length).toBeGreaterThan(0);
        tagCounts[tc.tag] = (tagCounts[tc.tag] ?? 0) + 1;
      }

      board = applyMove(board, turn, tagged[0].move);
      plies++;
    }

    if (board.off[turn] === 15) break;
    turn = (1 - turn) as 0 | 1;
  }

  // Safe is the default tag; it must appear in any real game
  expect(tagCounts["Safe"] ?? 0).toBeGreaterThan(0);
  expect(plies).toBeGreaterThan(5);
});

test("checker count stays at 30 throughout a full game", () => {
  let board = freshBoard();
  let turn: 0 | 1 = 0;

  for (let ply = 0; ply < 400; ply++) {
    // Invariant: 15 checkers per side, 30 total
    const onBoard = board.points.reduce((s, v) => s + Math.abs(v), 0);
    const total = onBoard + board.bar[0] + board.bar[1] + board.off[0] + board.off[1];
    expect(total).toBe(30);

    const dice = rollDice();
    const moves = generateLegalMoves(board, turn, dice);

    if (moves.length > 0) {
      const chosen = pickMove(moves, board.points);
      // The chosen move must come from the legal-move list
      expect(moves).toContain(chosen);
      board = applyMove(board, turn, chosen);
    }

    if (board.off[turn] === 15) break;
    turn = (1 - turn) as 0 | 1;
  }
});

test("both sides alternate turns correctly across a full game", () => {
  let board = freshBoard();
  let turn: 0 | 1 = 0;
  let prevTurn: 0 | 1 | null = null;
  let passTurnCount = 0; // a pass is still a turn for the same side — after which side flips

  for (let ply = 0; ply < 400; ply++) {
    // Turn must have flipped from previous (or be the first ply)
    if (prevTurn !== null) {
      expect(turn).not.toBe(prevTurn);
    }
    prevTurn = turn;

    const dice = rollDice();
    const moves = generateLegalMoves(board, turn, dice);

    if (moves.length === 0) {
      passTurnCount++;
    } else {
      board = applyMove(board, turn, pickMove(moves, board.points));
    }

    if (board.off[turn] === 15) break;
    turn = (1 - turn) as 0 | 1;
  }

  // A pass is valid but should be rare; flag if suspiciously frequent
  expect(passTurnCount).toBeLessThan(30);
});
