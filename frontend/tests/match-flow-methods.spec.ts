// Regression test: the match flow's `apiFetch` helper must POST every
// game endpoint, never GET.
//
// History: a previous version of `apiFetch` in `frontend/app/match/page.tsx`
// defaulted to GET when no body was provided. The match endpoints
// (/games, /games/:id/move, /games/:id/roll, /games/:id/agent-move,
// /games/:id/finalize) are all POST-only on FastAPI, so calls without
// a body — `/roll` and `/agent-move` — silently 405 with
// `{"detail":"Method Not Allowed"}` and the auto-drive stalled
// immediately after the first human Move.
//
// This spec drives the live-play page (`/match?agentId=1`), intercepts
// every game fetch with `page.route`, and asserts every recorded HTTP
// method is POST. If apiFetch ever regresses to GET on no-body calls,
// the assertions on /roll and /agent-move fail with a clear diff.

import { test, expect, type Route } from "@playwright/test";

const GAME_ID = "test-game-id";

// Opening position with both players visible (the Phase 24 decode_position_id
// fix). The frontend never inspects these values for routing — it only
// uses game.game_id and game.turn — but realistic mock data keeps the UI
// from rendering a degenerate empty board.
const INITIAL_STATE = {
  game_id: GAME_ID,
  match_id: "MAEAAAAAAAAE",
  position_id: "4HPwATDgc/ABMA",
  board: [-2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2],
  bar: [0, 0],
  off: [0, 0],
  turn: 0,                   // human's turn
  dice: [3, 1],              // dice already rolled (server auto-rolls on /games)
  cube: 1,
  cube_owner: -1,
  match_length: 1,
  score: [0, 0],
  game_over: false,
  winner: null,
};

const AFTER_HUMAN_MOVE = {
  ...INITIAL_STATE,
  turn: 1,                   // agent's turn — triggers auto-drive
  dice: null,                // no dice yet → frontend will call /roll first
};

const AFTER_AGENT_ROLL = {
  ...AFTER_HUMAN_MOVE,
  dice: [5, 5],
};

const AFTER_AGENT_MOVE = {
  ...AFTER_AGENT_ROLL,
  turn: 0,                   // back to human
  dice: null,
};

test("match flow POSTs every game endpoint (no GET regression)", async ({ page }) => {
  const methods: Record<string, string[]> = {
    create: [],
    move: [],
    roll: [],
    agentMove: [],
  };

  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  // POST /games — create new game
  await page.route("**/games", async (route) => {
    methods.create.push(route.request().method());
    await fulfill(route, INITIAL_STATE);
  });

  // POST /games/<id>/move — submit human move
  await page.route(`**/games/${GAME_ID}/move`, async (route) => {
    methods.move.push(route.request().method());
    await fulfill(route, AFTER_HUMAN_MOVE);
  });

  // POST /games/<id>/roll — agent's roll (auto-drive, no body)
  await page.route(`**/games/${GAME_ID}/roll`, async (route) => {
    methods.roll.push(route.request().method());
    await fulfill(route, AFTER_AGENT_ROLL);
  });

  // POST /games/<id>/agent-move — agent's checker move (auto-drive, no body)
  await page.route(`**/games/${GAME_ID}/agent-move`, async (route) => {
    methods.agentMove.push(route.request().method());
    await fulfill(route, AFTER_AGENT_MOVE);
  });

  await page.goto("/match?agentId=1");

  // Wait for the initial POST /games to land.
  await expect.poll(() => methods.create.length, { timeout: 10_000 }).toBe(1);

  // The page should now show the human-controls row with a move input
  // and the Move button. Submit any move notation — the mock returns a
  // canned response regardless.
  const moveInput = page.getByPlaceholder('e.g. "8/5 6/5" or "off"');
  await moveInput.fill("13/10 8/5");
  await page.getByRole("button", { name: "Move" }).click();

  // After submission, the auto-drive cascade should fire:
  //   /move → state.turn=1, dice=null → /roll → /agent-move
  // All three must be POST.
  await expect.poll(() => methods.move.length, { timeout: 5_000 }).toBe(1);
  await expect.poll(() => methods.roll.length, { timeout: 5_000 }).toBe(1);
  await expect.poll(() => methods.agentMove.length, { timeout: 5_000 }).toBe(1);

  expect(methods.create).toEqual(["POST"]);
  expect(methods.move).toEqual(["POST"]);
  // These two are the regression — they fire with no body, so an apiFetch
  // that defaults to GET-on-no-body would record "GET" here and fail.
  expect(methods.roll).toEqual(["POST"]);
  expect(methods.agentMove).toEqual(["POST"]);
});
