// Phase 27: click-to-move regression coverage.
//
// Drives /match?agentId=1 against mocked gnubg_service endpoints and
// verifies that:
//   1. Clicking a blue checker selects it (data-selected="true").
//   2. Clicking a destination point appends the "from/to" segment to the
//      move input, so the existing Move button can submit the full notation.
//   3. Clicking the same source twice deselects it.
//   4. Multiple click pairs accumulate into a space-separated notation
//      string identical to what a user would type by hand.
//
// The text input and Move button are left unchanged (backward-compatible)
// so all pre-existing tests continue to exercise the same paths.

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

test("two click pairs build '8/5 6/5' in the move input", async ({ page }) => {
  await setupRoutes(page);
  await page.goto("/match?agentId=1");

  await expect(page.locator("[data-point='8']")).toBeVisible({ timeout: 10_000 });

  // First checker: point 8 → point 5.
  await page.locator("[data-point='8']").click();
  await expect(page.locator("[data-point='8']")).toHaveAttribute("data-selected", "true");
  await page.locator("[data-point='5']").click();

  // After the first pair, input shows "8/5" and nothing is selected.
  const moveInput = page.getByPlaceholder('e.g. "8/5 6/5" or "off"');
  await expect(moveInput).toHaveValue("8/5");
  await expect(page.locator("[data-point='8']")).not.toHaveAttribute("data-selected");

  // Second checker: point 6 → point 5.
  await page.locator("[data-point='6']").click();
  await expect(page.locator("[data-point='6']")).toHaveAttribute("data-selected", "true");
  await page.locator("[data-point='5']").click();

  // Input now accumulates "8/5 6/5".
  await expect(moveInput).toHaveValue("8/5 6/5");
});

test("click-built notation is submitted via the Move button to /apply", async ({
  page,
}) => {
  let capturedMove = "";

  await setupRoutes(page, {
    applyCallback: (body) => {
      capturedMove = String(body.move ?? "");
      return makeState(OPENING_BOARD, 1);
    },
  });

  await page.goto("/match?agentId=1");
  await expect(page.locator("[data-point='8']")).toBeVisible({ timeout: 10_000 });

  // Build "8/5 6/5" by clicking.
  await page.locator("[data-point='8']").click();
  await page.locator("[data-point='5']").click();
  await page.locator("[data-point='6']").click();
  await page.locator("[data-point='5']").click();

  const moveInput = page.getByPlaceholder('e.g. "8/5 6/5" or "off"');
  await expect(moveInput).toHaveValue("8/5 6/5");

  // Submit via the Move button.
  await page.getByRole("button", { name: "Move" }).click();

  // /apply must receive the click-assembled notation exactly.
  await expect
    .poll(() => capturedMove, { timeout: 5_000 })
    .toBe("8/5 6/5");
});

test("Reset button clears the assembled notation and deselects any source", async ({
  page,
}) => {
  await setupRoutes(page);
  await page.goto("/match?agentId=1");

  await expect(page.locator("[data-point='8']")).toBeVisible({ timeout: 10_000 });

  // Build one segment.
  await page.locator("[data-point='8']").click();
  await page.locator("[data-point='5']").click();

  const moveInput = page.getByPlaceholder('e.g. "8/5 6/5" or "off"');
  await expect(moveInput).toHaveValue("8/5");

  // Select a second source to leave a pending selection.
  await page.locator("[data-point='6']").click();
  await expect(page.locator("[data-point='6']")).toHaveAttribute("data-selected", "true");

  // Click Reset — both the notation and the selection should clear.
  await page.getByRole("button", { name: "Reset" }).click();

  await expect(moveInput).toHaveValue("");
  await expect(page.locator("[data-point='6']")).not.toHaveAttribute("data-selected");
});
