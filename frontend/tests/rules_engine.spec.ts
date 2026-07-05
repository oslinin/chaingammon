import { test, expect } from "@playwright/test";
import { generateLegalMoves, hasLegalMoves, isLegal, parseMove, OPENING_BOARD, encodeFullBoard, type Board } from "../lib/rules_engine";

test("generateLegalMoves opening board", () => {
    // Player 0 opening roll 3-1
    const moves = generateLegalMoves(OPENING_BOARD, 0, [3, 1]);
    expect(moves.length).toBeGreaterThan(0);
    // Typical 3-1 moves like 8/5 6/5
    expect(moves).toContain("8/5 6/5");
});

test("generateLegalMoves returns [] when bar-danced against a closed home board", () => {
    // Player 0 has a checker on the bar; opponent (player 1) has all six
    // points 19-24 closed (≥2 negative checkers each), so a 6-6 roll
    // leaves no legal entry. Previously this returned [""] (one no-op
    // "move") which made the human-turn auto-skip never fire and the
    // advisor render an empty AGGRESSIVE row.
    const points = new Array(24).fill(0);
    // Close points 19..24 with 2 opponent checkers each. Distribute the
    // remaining 3 opponent checkers safely on point 13.
    for (let p = 19; p <= 24; p++) points[p - 1] = -2;
    points[13 - 1] = -3;
    // Place player 0's other 14 checkers safely on points 1..6.
    for (let p = 1; p <= 6; p++) points[p - 1] = 2;
    points[6 - 1] = 4;
    const board: Board = {
        points,
        bar: [1, 0],
        off: [0, 0],
    };
    expect(generateLegalMoves(board, 0, [6, 6])).toEqual([]);
    expect(hasLegalMoves(board, 0, [6, 6])).toBe(false);
});

test("parseMove expands gnubg (n) repeat notation", () => {
    // generateLegalMoves groups repeated sub-moves on doubles as "9/4(2)";
    // parseMove must expand the repeat or isLegal simulates only one copy
    // and rejects the generator's own move.
    expect(parseMove("9/4(2)", 0)).toEqual([
        { src: 9, dst: 4, hit: false },
        { src: 9, dst: 4, hit: false },
    ]);
    // A blot can only be hit once — only the first copy carries the hit.
    expect(parseMove("13/8*(2)", 0)).toEqual([
        { src: 13, dst: 8, hit: true },
        { src: 13, dst: 8, hit: false },
    ]);
});

test("doubles bear-off move with (n) repeats round-trips through isLegal", () => {
    // Regression: HvH auto-play stalled here — the only legal move for 5-5
    // is "9/4(2) 7/2 4/off" and isLegal used to reject it because the (2)
    // repeat was dropped by parseMove, leaving a checker outside home.
    const board: Board = {
        points: [5, 6, 0, 1, 0, -1, 1, 0, 2, 0, 0, 0, -1, 0, 0, -2, 0, 0, 0, 0, -1, 0, -1, -9],
        bar: [0, 0],
        off: [0, 0],
    };
    const dice: [number, number] = [5, 5];
    const moves = generateLegalMoves(board, 0, dice);
    expect(moves).toContain("9/4(2) 7/2 4/off");
    for (const m of moves) {
        expect(isLegal(board, dice, 0, m), `generated move must be legal: ${m}`).toBe(true);
    }
});

test("grouped repeats never synthesise an unplayable order", () => {
    // Regression: with 1-1 the play 9/8 10/9 9/8 2/1 used to be displayed as
    // "9/8(2) 2/1 10/9" — but point 9 only holds one checker, so both 9/8s
    // can't be played before 10/9 arrives. The generator must fall back to
    // the actual played order when the compact grouping doesn't simulate.
    const board: Board = {
        points: [0, 5, -1, -1, 1, -1, 0, 0, 1, 2, -1, 2, 3, 0, -1, 0, 0, 0, -5, 0, 0, 1, -2, -3],
        bar: [0, 0],
        off: [0, 0],
    };
    const dice: [number, number] = [1, 1];
    const moves = generateLegalMoves(board, 0, dice);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) {
        expect(isLegal(board, dice, 0, m), `generated move must be legal: ${m}`).toBe(true);
    }
});

test("encodeFullBoard produces Float32Array of length 198", () => {
    const feat = encodeFullBoard(OPENING_BOARD, 0);
    expect(feat.length).toBe(198);
    expect(feat).toBeInstanceOf(Float32Array);

    const feat1 = encodeFullBoard(OPENING_BOARD, 1);
    expect(feat1.length).toBe(198);
    expect(feat[196]).toBe(1.0); // side to play is always 1.0 at 196
});
