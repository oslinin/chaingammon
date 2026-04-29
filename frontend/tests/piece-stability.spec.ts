// Regression test: pieces must not jump to wrong points across multiple moves.
//
// Drives /match?agentId=1 with mocked gnubg_service endpoints through a
// four-move sequence (two human + two agent turns). After each completed round
// the test reads the [data-point]/[data-count] attributes that Board.tsx stamps
// on every PointCell and asserts:
//   1. Every point's count matches the board array returned by the last /apply.
//   2. Total piece count for each player equals 15 (conservation invariant).
//
// Board states are hand-crafted to stay ≤ 5 checkers per point (no "+N" label)
// so the attribute-based count is the full picture. Bar and borne-off counts are
// kept at zero throughout, meaning all 15 pieces per player appear on the board.

import { test, expect, type Page, type Route } from "@playwright/test";

// ── API mock helpers ──────────────────────────────────────────────────────────

const fulfill = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

function makeState(
  board: number[],
  turn: 0 | 1 = 0,
  extra: Record<string, unknown> = {},
) {
  return {
    position_id: "test_pos",
    match_id: "cAllAAAAAAAE",
    board,
    bar: [0, 0],
    off: [0, 0],
    turn,
    dice: null,
    score: [0, 0],
    match_length: 3,
    game_over: false,
    winner: null,
    ...extra,
  };
}

// ── Board state sequence ──────────────────────────────────────────────────────
//
// Standard backgammon opening.  Blue (player 0) occupies positive counts,
// red (player 1) negative.  board[i] = signed checker count at point (i+1).

const OPENING_BOARD = [
  -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2,
];
// Blue: pts 6,8,13,24 → 5+3+5+2=15. Red: pts 1,12,17,19 → 2+5+3+5=15.

// Round 1 human: two checkers from pt 24 → pt 21 and pt 22 (dice [3,2]).
//   board[23] 2→0, board[20] 0→1 (pt 21), board[21] 0→1 (pt 22).
const AFTER_HUMAN_1 = [
  -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 1, 1, 0, 0,
];
// Blue 5+3+5+1+1=15. Red unchanged=15.

// Round 1 agent: two checkers from pt 19 → pt 14 and pt 15 (dice [5,4]).
//   board[18] -5→-3, board[13] 0→-1 (pt 14), board[14] 0→-1 (pt 15).
const AFTER_AGENT_1 = [
  -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, -1, -1, 0, -3, 0, -3, 0, 1, 1, 0, 0,
];
// Blue 5+3+5+1+1=15. Red 2+5+1+1+3+3=15.

// Round 2 human: two checkers from pt 13 → pt 10 and pt 11 (dice [3,2]).
//   board[12] 5→3, board[9] 0→1 (pt 10), board[10] 0→1 (pt 11).
const AFTER_HUMAN_2 = [
  -2, 0, 0, 0, 0, 5, 0, 3, 0, 1, 1, -5, 3, -1, -1, 0, -3, 0, -3, 0, 1, 1, 0, 0,
];
// Blue 5+3+1+1+3+1+1=15. Red unchanged=15.

// Round 2 agent: two checkers from pt 12 → pt 7 and pt 9 (dice [5,3]).
//   board[11] -5→-3, board[6] 0→-1 (pt 7), board[8] 0→-1 (pt 9).
const AFTER_AGENT_2 = [
  -2, 0, 0, 0, 0, 5, -1, 3, -1, 1, 1, -3, 3, -1, -1, 0, -3, 0, -3, 0, 1, 1, 0, 0,
];
// Blue 5+3+1+1+3+1+1=15. Red 2+1+1+3+1+1+3+3=15.

// ── DOM helpers ───────────────────────────────────────────────────────────────

// Reads the data-point / data-count attributes added by Board.tsx's PointCell.
// Returns a Map<point (1-indexed), count (signed)>.
async function readBoardDOM(page: Page): Promise<Map<number, number>> {
  const cells = page.locator("[data-point]");
  const n = await cells.count();
  const map = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const pt = Number(await cells.nth(i).getAttribute("data-point"));
    const cnt = Number(await cells.nth(i).getAttribute("data-count"));
    map.set(pt, cnt);
  }
  return map;
}

// Polls until the board DOM matches expectedBoard exactly, then checks the
// conservation invariant: 15 pieces per player on the board (bar/off = 0).
async function waitForBoard(page: Page, expectedBoard: number[]) {
  await expect
    .poll(
      async () => {
        const dom = await readBoardDOM(page);
        if (dom.size < 24) return "not-rendered";
        for (let i = 0; i < 24; i++) {
          const got = dom.get(i + 1) ?? 0;
          if (got !== expectedBoard[i])
            return `point ${i + 1}: expected ${expectedBoard[i]}, got ${got}`;
        }
        return "ok";
      },
      { timeout: 8_000, message: "board DOM did not converge to expected state" },
    )
    .toBe("ok");

  // Conservation: 15 pieces per player must be present on the board.
  const dom = await readBoardDOM(page);
  let blue = 0;
  let red = 0;
  for (const c of dom.values()) {
    if (c > 0) blue += c;
    else red -= c;
  }
  expect(blue, "blue (player 0) piece count on board").toBe(15);
  expect(red, "red (player 1) piece count on board").toBe(15);
}

// ── Test ──────────────────────────────────────────────────────────────────────

test("pieces are not displaced across multiple moves", async ({ page }) => {
  let applyCount = 0;
  let moveCount = 0;

  // POST /new — return the opening position.
  await page.route("**/new", async (route) => {
    await fulfill(route, makeState(OPENING_BOARD, 0));
  });

  // POST /apply — cycle through the four-step move sequence.
  await page.route("**/apply", async (route) => {
    applyCount += 1;
    if (applyCount === 1) await fulfill(route, makeState(AFTER_HUMAN_1, 1));
    else if (applyCount === 2) await fulfill(route, makeState(AFTER_AGENT_1, 0));
    else if (applyCount === 3) await fulfill(route, makeState(AFTER_HUMAN_2, 1));
    else await fulfill(route, makeState(AFTER_AGENT_2, 0));
  });

  // POST /move — provide a legal move string for each agent turn.
  await page.route("**/move", async (route) => {
    moveCount += 1;
    const moves = ["19/14 19/15", "12/7 12/9"];
    await fulfill(route, {
      move: moves[(moveCount - 1) % moves.length],
      candidates: [],
    });
  });

  // POST /resign — intercepted so stray calls don't escape to a real server.
  await page.route("**/resign", async (route) => {
    await fulfill(route, makeState(OPENING_BOARD, 0));
  });

  await page.goto("/match?agentId=1");

  // Opening position must render correctly before any input.
  await waitForBoard(page, OPENING_BOARD);

  // ── Round 1: human move ───────────────────────────────────────────────────
  const moveInput = page.getByPlaceholder('e.g. "8/5 6/5" or "off"');
  await expect(moveInput).toBeVisible({ timeout: 5_000 });
  await moveInput.fill("24/21 24/22");
  await page.getByRole("button", { name: "Move" }).click();

  // Wait for both the human /apply and the auto-triggered agent /move + /apply.
  await expect
    .poll(() => applyCount, { timeout: 8_000 })
    .toBeGreaterThanOrEqual(2);

  // Board must show AFTER_AGENT_1 with no displaced pieces.
  await waitForBoard(page, AFTER_AGENT_1);

  // ── Round 2: human move ───────────────────────────────────────────────────
  await expect(moveInput).toBeVisible({ timeout: 5_000 });
  await moveInput.fill("13/10 13/11");
  await page.getByRole("button", { name: "Move" }).click();

  // Wait for both the human /apply and the agent's second auto-move.
  await expect
    .poll(() => applyCount, { timeout: 8_000 })
    .toBeGreaterThanOrEqual(4);

  // Board must show AFTER_AGENT_2 with no displaced pieces.
  await waitForBoard(page, AFTER_AGENT_2);
});
