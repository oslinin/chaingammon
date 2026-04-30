// Phase 27: click-to-move regression coverage.
// Phase 31: updated for drag-and-drop + optimistic board display + auto-submit + undo.
//
// Drives /match?agentId=1 against mocked gnubg_service endpoints and
// verifies that:
//   1. Clicking a blue checker selects it (data-selected="true").
//   2. Clicking the same source twice deselects it.
//   3. Clicking source then destination moves the checker immediately on
//      the display board (data-count changes optimistically).
//   4. Two click pairs auto-submit to /apply when both dice are used.
//   5. Undo button resets the board to the start-of-turn position.
//
// The text input and Move button are unchanged — all pre-existing tests
// that type notation and click Move continue to exercise those paths.

import { test, expect, type Route } from "@playwright/test";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Standard backgammon opening position.
// Blue (player 0) at points 6(5), 8(3), 13(5), 24(2).
// Red  (player 1) at points 1(2), 12(5), 17(3), 19(5).
const OPENING_BOARD = [
  -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5,
  5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2,
];

function makeState(
  board: number[],
  turn: 0 | 1 = 0,
  extra: Record<string, unknown> = {},
) {
  return {
    position_id: "click_pos",
    match_id: "click_mid",
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

const fulfill = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

// ── Shared route setup ────────────────────────────────────────────────────────

/** Wire up the four gnubg_service routes that every match-page test needs. */
async function setupRoutes(
  page: import("@playwright/test").Page,
  opts: {
    applyCallback?: (body: Record<string, unknown>) => unknown;
  } = {},
) {
  await page.route("**/new", async (route) => {
    await fulfill(route, makeState(OPENING_BOARD, 0));
  });

  await page.route("**/apply", async (route) => {
    const raw = route.request().postData() ?? "{}";
    const body = JSON.parse(raw) as Record<string, unknown>;
    const responseBody = opts.applyCallback
      ? opts.applyCallback(body)
      : makeState(OPENING_BOARD, 1);
    await fulfill(route, responseBody);
  });

  await page.route("**/move", async (route) => {
    await fulfill(route, { move: "13/10 13/11", candidates: [] });
  });

  await page.route("**/resign", async (route) => {
    await fulfill(route, makeState(OPENING_BOARD, 0, { game_over: true, winner: 1 }));
  });
}

/**
 * Override crypto.getRandomValues so rollDice() always returns [3, 2]
 * (non-doubles → diceCount = 2). Must be called via page.addInitScript
 * before page.goto so it runs before the module initialises.
 *
 * Values: floor(buf / 2^32 * 6) + 1 = die face.
 *   1431655765 / 2^32 * 6 ≈ 2.000 → face 3
 *   715827883  / 2^32 * 6 ≈ 1.000 → face 2
 */
function deterministicDiceScript() {
  return `
    (function() {
      var _orig = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = function(arr) {
        if (arr instanceof Uint32Array && arr.length === 2) {
          arr[0] = 1431655765;
          arr[1] = 715827883;
          return arr;
        }
        return _orig(arr);
      };
    })();
  `;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("clicking a blue checker selects it (amber highlight via data-selected)", async ({
  page,
}) => {
  await setupRoutes(page);
  await page.goto("/match?agentId=1");

  // Wait for the board to render the opening position.
  await expect(page.locator("[data-point='8']")).toBeVisible({ timeout: 10_000 });

  // Point 8 has 3 blue checkers in the opening — it should be clickable.
  await page.locator("[data-point='8']").click();

  // The PointCell sets data-selected="true" when it is the selected source.
  await expect(page.locator("[data-point='8']")).toHaveAttribute(
    "data-selected",
    "true",
  );
});

test("clicking same point twice deselects it", async ({ page }) => {
  await setupRoutes(page);
  await page.goto("/match?agentId=1");

  await expect(page.locator("[data-point='8']")).toBeVisible({ timeout: 10_000 });

  // First click: select.
  await page.locator("[data-point='8']").click();
  await expect(page.locator("[data-point='8']")).toHaveAttribute("data-selected", "true");

  // Second click: deselect.
  await page.locator("[data-point='8']").click();
  await expect(page.locator("[data-point='8']")).not.toHaveAttribute("data-selected");
});

test("click pair moves checker to destination on the display board immediately", async ({
  page,
}) => {
  await setupRoutes(page);
  await page.goto("/match?agentId=1");

  await expect(page.locator("[data-point='8']")).toBeVisible({ timeout: 10_000 });

  // Opening: point 8 has 3 blue checkers, point 5 is empty.
  await expect(page.locator("[data-point='8']")).toHaveAttribute("data-count", "3");
  await expect(page.locator("[data-point='5']")).toHaveAttribute("data-count", "0");

  // First pair: click source (8) then destination (5).
  await page.locator("[data-point='8']").click();
  await page.locator("[data-point='5']").click();

  // After staging 8/5, the board reflects the move immediately.
  await expect(page.locator("[data-point='8']")).toHaveAttribute("data-count", "2");
  await expect(page.locator("[data-point='5']")).toHaveAttribute("data-count", "1");

  // Point 8 is no longer selected (selection cleared after staging).
  await expect(page.locator("[data-point='8']")).not.toHaveAttribute("data-selected");
});

test("two click pairs auto-submit to /apply when both dice are used", async ({
  page,
}) => {
  // Force dice to [3, 2] (non-doubles) so diceCount = 2 — exactly two click
  // pairs trigger auto-submit without any manual Move button press.
  await page.addInitScript(deterministicDiceScript());

  let capturedMove = "";
  await setupRoutes(page, {
    applyCallback: (body) => {
      capturedMove = String(body.move ?? "");
      return makeState(OPENING_BOARD, 1);
    },
  });

  await page.goto("/match?agentId=1");
  await expect(page.locator("[data-point='8']")).toBeVisible({ timeout: 10_000 });

  // Two click pairs: 8 → 5, then 6 → 5.
  await page.locator("[data-point='8']").click();
  await page.locator("[data-point='5']").click();
  await page.locator("[data-point='6']").click();
  await page.locator("[data-point='5']").click();

  // Auto-submit fires after the second pair — /apply receives "8/5 6/5".
  await expect
    .poll(() => capturedMove, { timeout: 5_000 })
    .toBe("8/5 6/5");
});

test("Undo button resets the board to start-of-turn position", async ({
  page,
}) => {
  await setupRoutes(page);
  await page.goto("/match?agentId=1");

  await expect(page.locator("[data-point='8']")).toBeVisible({ timeout: 10_000 });

  // Stage one move: 8 → 5. One staged move is always < diceCount (2 or 4),
  // so auto-submit does not fire regardless of the dice value.
  await page.locator("[data-point='8']").click();
  await page.locator("[data-point='5']").click();

  // Optimistic display: point 8 shows 2, point 5 shows 1.
  await expect(page.locator("[data-point='8']")).toHaveAttribute("data-count", "2");
  await expect(page.locator("[data-point='5']")).toHaveAttribute("data-count", "1");

  // Click Undo — staged moves discarded and board resets to opening.
  await page.getByRole("button", { name: "Undo" }).click();

  await expect(page.locator("[data-point='8']")).toHaveAttribute("data-count", "3");
  await expect(page.locator("[data-point='5']")).toHaveAttribute("data-count", "0");
});
