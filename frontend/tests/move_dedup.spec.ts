import { test, expect } from "@playwright/test";
import { generateLegalMoves, OPENING_BOARD } from "../lib/rules_engine";

test("dedup: reorderings collapse to one play", () => {
  const moves = generateLegalMoves(OPENING_BOARD, 0, [3, 1]);
  // existing expectation preserved
  expect(moves).toContain("8/5 6/5");
  // the reordering must NOT also appear
  expect(moves).not.toContain("6/5 8/5");
  // no two entries should be permutations of each other
  const keys = moves.map((m) => m.split(/\s+/).sort().join(" "));
  expect(new Set(keys).size).toBe(keys.length);
});
