// Match flow regression — drives /match?agentId=1 against mocked
// gnubg_service endpoints and asserts a complete game can be played
// without any request to the retired FastAPI server (port 8000).
//
// Phase 26 (post-pivot): the match page calls gnubg_service on
// localhost:8001 directly. /new on mount, /apply for every move,
// /move + /apply for the agent's turn, /resign for forfeit.

import { test, expect, type Route } from "@playwright/test";

const OPENING_POSITION_ID = "4HPwATDgc/ABMA";
const OPENING_MATCH_ID = "cAllAAAAAAAE";

// Canned MatchState fixtures. Position/match ids are realistic but the
// browser only inspects turn / game_over / winner / dice for routing,
// so the rest can be coarse.
const OPENING = {
  position_id: OPENING_POSITION_ID,
  match_id: OPENING_MATCH_ID,
  board: [-2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2],
  bar: [0, 0],
  off: [0, 0],
  turn: 0,
  dice: null,
  score: [0, 0],
  match_length: 3,
  game_over: false,
  winner: null,
};

const AFTER_HUMAN_MOVE = { ...OPENING, position_id: "humanmoved", turn: 1, dice: null };
const AFTER_AGENT_MOVE = { ...OPENING, position_id: "agentmoved", turn: 0, dice: null };
const GAME_OVER = {
  ...OPENING,
  position_id: "gameover",
  turn: 0,
  dice: null,
  game_over: true,
  winner: 0,
  score: [3, 0],
};

const fulfill = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

test("match flow walks /new → /apply → /move → /apply through to game over", async ({ page }) => {
  const seen: Record<string, string[]> = {
    new: [],
    apply: [],
    move: [],
    resign: [],
  };

  let applyCount = 0;

  // POST /new — start match.
  await page.route("**/new", async (route) => {
    seen.new.push(route.request().method());
    await fulfill(route, OPENING);
  });

  // POST /apply — three calls: human move, agent move, then game-over.
  await page.route("**/apply", async (route) => {
    seen.apply.push(route.request().method());
    applyCount += 1;
    if (applyCount === 1) await fulfill(route, AFTER_HUMAN_MOVE);
    else if (applyCount === 2) await fulfill(route, AFTER_AGENT_MOVE);
    else await fulfill(route, GAME_OVER);
  });

  // POST /move — agent picks a move once.
  await page.route("**/move", async (route) => {
    seen.move.push(route.request().method());
    await fulfill(route, { move: "13/10 6/3", candidates: [] });
  });

  // POST /resign — exercised by a separate test below; route must exist
  // so a stray call doesn't escape and 404 to a real server.
  await page.route("**/resign", async (route) => {
    seen.resign.push(route.request().method());
    await fulfill(route, GAME_OVER);
  });

  await page.goto("/match?agentId=1");

  // Click "Start Game" on the pre-game landing to launch the match.
  await page.getByTestId("start-game-button").click();

  // /new fires after "Start Game" is clicked.
  await expect.poll(() => seen.new.length, { timeout: 10_000 }).toBe(1);

  // Submit a human move — drives /apply, then auto-cascades agent /move + /apply.
  const moveInput = page.getByPlaceholder('e.g. "8/5 6/5" or "off"');
  await moveInput.fill("8/5 6/5");
  await page.getByRole("button", { name: "Move" }).click();

  await expect.poll(() => seen.apply.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => seen.move.length, { timeout: 5_000 }).toBe(1);

  // Submit the next human move; this one returns game_over.
  await moveInput.fill("24/22 24/23");
  await page.getByRole("button", { name: "Move" }).click();

  await expect(page.getByText("You win!")).toBeVisible({ timeout: 5_000 });

  // Method assertions: every gnubg_service call is POST.
  expect(seen.new).toEqual(["POST"]);
  for (const m of seen.apply) expect(m).toBe("POST");
  for (const m of seen.move) expect(m).toBe("POST");
});

test("fast forward lets the gnubg agent play both sides to game over", async ({ page }) => {
  let moveCount = 0;
  let applyCount = 0;
  let resignCount = 0;
  let hintCount = 0;

  await page.route("**/new", async (route) => {
    await fulfill(route, OPENING);
  });

  // Every /move returns a valid move string.
  await page.route("**/move", async (route) => {
    moveCount += 1;
    await fulfill(route, { move: "13/10", candidates: [] });
  });

  // /apply: first call gives the agent the next turn; second ends the game.
  await page.route("**/apply", async (route) => {
    applyCount += 1;
    if (applyCount === 1) {
      await fulfill(route, { ...OPENING, position_id: "step1", turn: 1, dice: null });
    } else {
      await fulfill(route, GAME_OVER);
    }
  });

  await page.route("**/resign", async (route) => {
    resignCount += 1;
    await fulfill(route, GAME_OVER);
  });

  // Coach /hint must NOT be called during fast-forward — the human is not
  // choosing moves and the extra round-trip only slows the auto-play.
  await page.route("**/hint", async (route) => {
    hintCount += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hint: "", backend: "local" }) });
  });

  await page.goto("/match?agentId=1");

  // Click "Start Game" then let the agent play both sides to completion via fast-forward.
  await page.getByTestId("start-game-button").click();
  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("You win!")).toBeVisible({ timeout: 10_000 });
  expect(resignCount).toBe(0); // forfeit was not called
  expect(moveCount).toBeGreaterThanOrEqual(1);
  expect(hintCount).toBe(0); // coach must be silent during fast-forward
});

test("forfeit posts /resign and shows the game-over banner", async ({ page }) => {
  await page.route("**/new", async (route) => {
    await fulfill(route, OPENING);
  });
  // Apply / move routes shouldn't fire in this test, but leave routes in
  // place so a stray call doesn't escape.
  await page.route("**/apply", async (route) => {
    await fulfill(route, OPENING);
  });
  await page.route("**/move", async (route) => {
    await fulfill(route, { move: null, candidates: [] });
  });

  let resignCalled = false;
  await page.route("**/resign", async (route) => {
    resignCalled = true;
    await fulfill(route, { ...GAME_OVER, winner: 1 });
  });

  await page.goto("/match?agentId=1");

  // Click "Start Game" on the pre-game landing, then forfeit.
  await page.getByTestId("start-game-button").click();

  // Auto-accept the confirm dialog, then click Forfeit.
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Forfeit match" }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 5_000 });
  expect(resignCalled).toBe(true);
});
