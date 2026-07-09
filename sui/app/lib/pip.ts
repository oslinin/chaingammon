// Pip count for a side, matching rules_engine orientation:
// board[i] > 0 → side 0's checkers on point i+1; side 0 bears off past point 1.
// board[i] < 0 → side 1's checkers; side 1 bears off past point 24.
// Bar checkers always cost 25 pips (must re-enter the opponent's home).
export function pipCount(
  board: number[],
  bar: [number, number],
  side: 0 | 1,
): number {
  let pips = bar[side] * 25;
  for (let i = 0; i < 24; i++) {
    const n = board[i];
    if (side === 0 && n > 0) pips += (i + 1) * n;
    else if (side === 1 && n < 0) pips += (24 - i) * -n;
  }
  return pips;
}
