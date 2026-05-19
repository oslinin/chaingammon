import { test, expect } from "@playwright/test";
import { generateLegalMoves, OPENING_BOARD, encodeFullBoard, type Board } from "../lib/rules_engine";
import { hasLegalMoves } from "../lib/match_engine";

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

test("encodeFullBoard produces Float32Array of length 198", () => {
    const feat = encodeFullBoard(OPENING_BOARD, 0);
    expect(feat.length).toBe(198);
    expect(feat).toBeInstanceOf(Float32Array);

    const feat1 = encodeFullBoard(OPENING_BOARD, 1);
    expect(feat1.length).toBe(198);
    expect(feat[196]).toBe(1.0); // side to play is always 1.0 at 196
});
