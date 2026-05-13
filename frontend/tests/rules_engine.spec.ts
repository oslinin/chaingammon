import { test, expect } from "@playwright/test";
import { generateLegalMoves, OPENING_BOARD, encodeFullBoard } from "../lib/rules_engine";

test("generateLegalMoves opening board", () => {
    // Player 0 opening roll 3-1
    const moves = generateLegalMoves(OPENING_BOARD, 0, [3, 1]);
    expect(moves.length).toBeGreaterThan(0);
    // Typical 3-1 moves like 8/5 6/5
    expect(moves).toContain("8/5 6/5");
});

test("encodeFullBoard produces Float32Array of length 198", () => {
    const feat = encodeFullBoard(OPENING_BOARD, 0);
    expect(feat.length).toBe(198);
    expect(feat).toBeInstanceOf(Float32Array);

    const feat1 = encodeFullBoard(OPENING_BOARD, 1);
    expect(feat1.length).toBe(198);
    expect(feat[196]).toBe(1.0); // side to play is always 1.0 at 196
});
