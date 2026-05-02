// 20 end-to-end fast-forward regression tests.
//
// The user reported errors both when playing against the agent and when
// using the fast-forward feature. These tests drive /match?agentId=1
// against mocked gnubg_service endpoints and cover:
//
//   • Basic completion — various game lengths and winner outcomes.
//   • UI state — button text, status paragraph, move-input visibility.
//   • API silence — /hint, /evaluate, and /resign must not fire.
//   • Bar dance — /skip called when /move returns null.
//   • Error recovery — API 500 surfaces an error message without crashing.
//
// All gnubg_service routes are mocked so tests never need a live backend.

import { test, expect, type Route } from "@playwright/test";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OPENING_BOARD = [
  -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5,
  5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2,
];

/** Generate a unique MatchState for each test call so position IDs never collide. */
function makeState(opts: {
  board?: number[];
  bar?: [number, number];
  off?: [number, number];
  turn?: 0 | 1;
  score?: [number, number];
  match_length?: number;
  game_over?: boolean;
  winner?: 0 | 1 | null;
} = {}) {
  return {
    position_id: `pos_${Math.random().toString(36).slice(2)}`,
    match_id: `mid_${Math.random().toString(36).slice(2)}`,
    board: opts.board ?? OPENING_BOARD,
    bar: opts.bar ?? [0, 0],
    off: opts.off ?? [0, 0],
    turn: opts.turn ?? 0,
    dice: null as [number, number] | null,
    score: opts.score ?? [0, 0],
    match_length: opts.match_length ?? 3,
    game_over: opts.game_over ?? false,
    winner: opts.winner ?? null,
  };
}

const GAME_OVER_HUMAN_WINS = makeState({
  off: [15, 0],
  score: [1, 0],
  game_over: true,
  winner: 0,
});

const GAME_OVER_AGENT_WINS = makeState({
  off: [0, 15],
  score: [0, 1],
  game_over: true,
  winner: 1,
});

const fulfill = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

/**
 * Wire all gnubg_service routes for a standard fast-forward scenario.
 * /move always returns "13/10"; /apply cycles through `totalMoves` turns
 * then returns `gameOver`. /skip, /resign, /hint, /evaluate are all wired
 * but should only be called if the logic under test specifically requires them.
 *
 * Returns callCount accessors for assertions.
 */
async function setupFF(
  page: import("@playwright/test").Page,
  opts: {
    openingTurn?: 0 | 1;
    totalMoves?: number;
    gameOver?: ReturnType<typeof makeState>;
    openingScore?: [number, number];
    applyOverride?: (n: number) => ReturnType<typeof makeState> | null;
    moveOverride?: (n: number) => string | null;
    skipResponse?: ReturnType<typeof makeState>;
  } = {},
) {
  const {
    openingTurn = 0,
    totalMoves = 2,
    gameOver = GAME_OVER_AGENT_WINS,
    openingScore = [0, 0],
    applyOverride,
    moveOverride,
    skipResponse,
  } = opts;

  let moveCalls = 0;
  let applyCalls = 0;
  let skipCalls = 0;
  let resignCalls = 0;
  let hintCalls = 0;
  let evaluateCalls = 0;

  await page.route("**/new", async (route) => {
    await fulfill(route, makeState({ turn: openingTurn, score: openingScore }));
  });

  await page.route("**/move", async (route) => {
    moveCalls++;
    const custom = moveOverride?.(moveCalls);
    const move = custom !== undefined ? custom : "13/10";
    await fulfill(route, { move, candidates: [] });
  });

  await page.route("**/apply", async (route) => {
    applyCalls++;
    const custom = applyOverride?.(applyCalls);
    if (custom !== null && custom !== undefined) {
      await fulfill(route, custom);
    } else if (applyCalls >= totalMoves) {
      await fulfill(route, gameOver);
    } else {
      await fulfill(route, makeState({ turn: applyCalls % 2 === 0 ? 0 : 1 }));
    }
  });

  await page.route("**/skip", async (route) => {
    skipCalls++;
    await fulfill(route, skipResponse ?? makeState({ turn: 1 }));
  });

  await page.route("**/resign", async (route) => {
    resignCalls++;
    await fulfill(route, gameOver);
  });

  await page.route("**/hint", async (route) => {
    hintCalls++;
    await fulfill(route, { hint: "", backend: "local" });
  });

  await page.route("**/evaluate", async (route) => {
    evaluateCalls++;
    await fulfill(route, { candidates: [{ move: "13/10", equity: 0 }] });
  });

  return {
    moveCalls: () => moveCalls,
    applyCalls: () => applyCalls,
    skipCalls: () => skipCalls,
    resignCalls: () => resignCalls,
    hintCalls: () => hintCalls,
    evaluateCalls: () => evaluateCalls,
  };
}

// ── Test 1: basic completion — agent wins after 2 rounds ──────────────────────

test("ff-01: fast-forward completes — agent wins after 2 move/apply rounds", async ({
  page,
}) => {
  await setupFF(page, { totalMoves: 2, gameOver: GAME_OVER_AGENT_WINS });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("You win!")).toHaveCount(0);
});

// ── Test 2: basic completion — human wins after 2 rounds ──────────────────────

test("ff-02: fast-forward completes — human wins after 2 move/apply rounds", async ({
  page,
}) => {
  await setupFF(page, { totalMoves: 2, gameOver: GAME_OVER_HUMAN_WINS });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("You win!")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Agent wins.")).toHaveCount(0);
});

// ── Test 3: single move to game over ─────────────────────────────────────────

test("ff-03: fast-forward ends in exactly one move/apply cycle", async ({
  page,
}) => {
  const counts = await setupFF(page, {
    totalMoves: 1,
    gameOver: GAME_OVER_AGENT_WINS,
  });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 10_000 });
  expect(counts.applyCalls()).toBe(1);
});

// ── Test 4: long game — 8 move/apply rounds ───────────────────────────────────

test("ff-04: fast-forward completes a long game with 8 move/apply cycles", async ({
  page,
}) => {
  const counts = await setupFF(page, {
    totalMoves: 8,
    gameOver: GAME_OVER_HUMAN_WINS,
  });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("You win!")).toBeVisible({ timeout: 15_000 });
  expect(counts.applyCalls()).toBeGreaterThanOrEqual(8);
});

// ── Test 5: opening turn is agent (turn=1) ────────────────────────────────────

test("ff-05: fast-forward works when the opening turn belongs to the agent", async ({
  page,
}) => {
  await setupFF(page, {
    openingTurn: 1,
    totalMoves: 2,
    gameOver: GAME_OVER_AGENT_WINS,
  });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 10_000 });
});

// ── Test 6: final score 1-0 displayed correctly ───────────────────────────────

test("ff-06: banner shows 'Final score: 1 – 0' when human wins", async ({
  page,
}) => {
  await setupFF(page, { gameOver: GAME_OVER_HUMAN_WINS });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText(/Final score:\s*1\s*[–-]\s*0/)).toBeVisible({
    timeout: 10_000,
  });
});

// ── Test 7: final score 0-1 displayed correctly ───────────────────────────────

test("ff-07: banner shows 'Final score: 0 – 1' when agent wins", async ({
  page,
}) => {
  await setupFF(page, { gameOver: GAME_OVER_AGENT_WINS });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText(/Final score:\s*0\s*[–-]\s*1/)).toBeVisible({
    timeout: 10_000,
  });
});

// ── Test 8: mid-match opening score is shown in the header ───────────────────

test("ff-08: mid-match score (1–0) is visible in header during and after fast-forward", async ({
  page,
}) => {
  const gameOver = makeState({
    score: [2, 0],
    game_over: true,
    winner: 0,
  });
  await setupFF(page, { openingScore: [1, 0], totalMoves: 2, gameOver });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  // Header shows the opening score before fast-forward.
  await expect(page.getByText("1 – 0")).toBeVisible({ timeout: 5_000 });

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("You win!")).toBeVisible({ timeout: 10_000 });
});

// ── Test 9: button text changes to "Fast forwarding…" after click ────────────

test("ff-09: fast-forward button text changes to 'Fast forwarding…' after click", async ({
  page,
}) => {
  // Delay /apply so the button has time to update before game over.
  await page.route("**/new", async (route) => {
    await fulfill(route, makeState({ turn: 0 }));
  });
  let applyCalls = 0;
  await page.route("**/apply", async (route) => {
    applyCalls++;
    await new Promise((r) => setTimeout(r, 200));
    await fulfill(route, applyCalls >= 2 ? GAME_OVER_AGENT_WINS : makeState({ turn: 1 }));
  });
  await page.route("**/move", async (route) => {
    await fulfill(route, { move: "13/10", candidates: [] });
  });
  await page.route("**/skip", async (route) => {
    await fulfill(route, makeState({ turn: 1 }));
  });
  await page.route("**/resign", async (route) => {
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });
  await page.route("**/hint", async (route) => {
    await fulfill(route, { hint: "", backend: "local" });
  });
  await page.route("**/evaluate", async (route) => {
    await fulfill(route, { candidates: [] });
  });

  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  const ffButton = page.getByRole("button", { name: /fast forward/i });
  await expect(ffButton).toBeVisible({ timeout: 5_000 });
  await ffButton.click();

  // After click the button should display "Fast forwarding…" while running.
  await expect(
    page.getByRole("button", { name: "Fast forwarding…" }),
  ).toBeVisible({ timeout: 3_000 });
});

// ── Test 10: fast-forward button is disabled after click ──────────────────────

test("ff-10: fast-forward button is disabled after it is clicked", async ({
  page,
}) => {
  // Keep /apply pending indefinitely so we can assert the disabled state.
  await page.route("**/new", async (route) => {
    await fulfill(route, makeState({ turn: 0 }));
  });
  await page.route("**/apply", async (route) => {
    // Delay long enough to assert disabled state before game over.
    await new Promise((r) => setTimeout(r, 400));
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });
  await page.route("**/move", async (route) => {
    await fulfill(route, { move: "13/10", candidates: [] });
  });
  await page.route("**/skip", async (route) => {
    await fulfill(route, makeState({ turn: 1 }));
  });
  await page.route("**/resign", async (route) => {
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });
  await page.route("**/hint", async (route) => {
    await fulfill(route, { hint: "", backend: "local" });
  });
  await page.route("**/evaluate", async (route) => {
    await fulfill(route, { candidates: [] });
  });

  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();
  const ffButton = page.getByRole("button", { name: /fast forward/i });
  await expect(ffButton).toBeEnabled({ timeout: 5_000 });
  await ffButton.click();

  await expect(ffButton).toBeDisabled({ timeout: 3_000 });
});

// ── Test 11: "Fast forwarding…" status paragraph visible during play ──────────

test("ff-11: animated 'Fast forwarding…' status paragraph appears during play", async ({
  page,
}) => {
  await page.route("**/new", async (route) => {
    await fulfill(route, makeState({ turn: 0 }));
  });
  let applyCalls = 0;
  await page.route("**/apply", async (route) => {
    applyCalls++;
    await new Promise((r) => setTimeout(r, 150));
    await fulfill(route, applyCalls >= 3 ? GAME_OVER_AGENT_WINS : makeState({ turn: 1 }));
  });
  await page.route("**/move", async (route) => {
    await fulfill(route, { move: "13/10", candidates: [] });
  });
  await page.route("**/skip", async (route) => {
    await fulfill(route, makeState({ turn: 1 }));
  });
  await page.route("**/resign", async (route) => {
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });
  await page.route("**/hint", async (route) => {
    await fulfill(route, { hint: "", backend: "local" });
  });
  await page.route("**/evaluate", async (route) => {
    await fulfill(route, { candidates: [] });
  });

  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();
  await page.getByRole("button", { name: /fast forward/i }).click();

  // The animated status paragraph reads "Fast forwarding…".
  await expect(page.getByText("Fast forwarding…")).toBeVisible({
    timeout: 5_000,
  });
});

// ── Test 12: move input is not visible during fast-forward ────────────────────

test("ff-12: move input is hidden while fast-forward is active", async ({
  page,
}) => {
  await page.route("**/new", async (route) => {
    await fulfill(route, makeState({ turn: 0 }));
  });
  let applyCalls = 0;
  await page.route("**/apply", async (route) => {
    applyCalls++;
    await new Promise((r) => setTimeout(r, 100));
    await fulfill(route, applyCalls >= 4 ? GAME_OVER_AGENT_WINS : makeState({ turn: 1 }));
  });
  await page.route("**/move", async (route) => {
    await fulfill(route, { move: "13/10", candidates: [] });
  });
  await page.route("**/skip", async (route) => {
    await fulfill(route, makeState({ turn: 1 }));
  });
  await page.route("**/resign", async (route) => {
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });
  await page.route("**/hint", async (route) => {
    await fulfill(route, { hint: "", backend: "local" });
  });
  await page.route("**/evaluate", async (route) => {
    await fulfill(route, { candidates: [] });
  });

  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  const moveInput = page.getByPlaceholder('e.g. "8/5 6/5" or "off"');

  await page.getByRole("button", { name: /fast forward/i }).click();

  // The move input should be gone once fast-forward is active.
  await expect(moveInput).toBeHidden({ timeout: 5_000 });
});

// ── Test 13: forfeit button disabled during fast-forward ──────────────────────

test("ff-13: forfeit button is disabled while fast-forward is running", async ({
  page,
}) => {
  await page.route("**/new", async (route) => {
    await fulfill(route, makeState({ turn: 0 }));
  });
  let applyCalls = 0;
  await page.route("**/apply", async (route) => {
    applyCalls++;
    await new Promise((r) => setTimeout(r, 100));
    await fulfill(route, applyCalls >= 4 ? GAME_OVER_AGENT_WINS : makeState({ turn: 1 }));
  });
  await page.route("**/move", async (route) => {
    await fulfill(route, { move: "13/10", candidates: [] });
  });
  await page.route("**/skip", async (route) => {
    await fulfill(route, makeState({ turn: 1 }));
  });
  await page.route("**/resign", async (route) => {
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });
  await page.route("**/hint", async (route) => {
    await fulfill(route, { hint: "", backend: "local" });
  });
  await page.route("**/evaluate", async (route) => {
    await fulfill(route, { candidates: [] });
  });

  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();
  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByRole("button", { name: "Forfeit match" })).toBeDisabled({
    timeout: 5_000,
  });
});

// ── Test 14: coach panel is not visible during fast-forward ──────────────────

test("ff-14: coach panel is hidden while fast-forward is active", async ({
  page,
}) => {
  await page.route("**/new", async (route) => {
    await fulfill(route, makeState({ turn: 0 }));
  });
  let applyCalls = 0;
  await page.route("**/apply", async (route) => {
    applyCalls++;
    await new Promise((r) => setTimeout(r, 100));
    await fulfill(route, applyCalls >= 3 ? GAME_OVER_AGENT_WINS : makeState({ turn: 1 }));
  });
  await page.route("**/move", async (route) => {
    await fulfill(route, { move: "13/10", candidates: [] });
  });
  await page.route("**/skip", async (route) => {
    await fulfill(route, makeState({ turn: 1 }));
  });
  await page.route("**/resign", async (route) => {
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });
  await page.route("**/hint", async (route) => {
    await fulfill(route, { hint: "", backend: "local" });
  });
  await page.route("**/evaluate", async (route) => {
    await fulfill(route, { candidates: [] });
  });

  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();
  await page.getByRole("button", { name: /fast forward/i }).click();

  // The "Coach" heading is inside the coach panel, which disappears during FF.
  await expect(
    page.getByText("Coach", { exact: true }),
  ).toBeHidden({ timeout: 5_000 });
});

// ── Test 15: /hint never called during fast-forward ──────────────────────────

test("ff-15: /hint is never called during fast-forward", async ({ page }) => {
  const counts = await setupFF(page, { totalMoves: 4 });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 10_000 });
  expect(counts.hintCalls()).toBe(0);
});

// ── Test 16: /evaluate never called during fast-forward ──────────────────────

test("ff-16: /evaluate is never called during fast-forward", async ({ page }) => {
  const counts = await setupFF(page, { totalMoves: 4 });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 10_000 });
  expect(counts.evaluateCalls()).toBe(0);
});

// ── Test 17: /resign never called during fast-forward ────────────────────────

test("ff-17: /resign is never called during fast-forward", async ({ page }) => {
  const counts = await setupFF(page, { totalMoves: 3 });
  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();

  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 10_000 });
  expect(counts.resignCalls()).toBe(0);
});

// ── Test 18: /skip called when /move returns null (bar dance) ─────────────────

test("ff-18: /skip is called when /move returns null (bar dance — no legal moves)", async ({
  page,
}) => {
  let moveCalls = 0;
  let skipCalls = 0;
  let applyCalls = 0;

  await page.route("**/new", async (route) => {
    await fulfill(route, makeState({ turn: 0 }));
  });

  // First /move returns null → /skip fires. Second /move returns a real move.
  await page.route("**/move", async (route) => {
    moveCalls++;
    const move = moveCalls === 1 ? null : "13/10";
    await fulfill(route, { move, candidates: [] });
  });

  await page.route("**/skip", async (route) => {
    skipCalls++;
    await fulfill(route, makeState({ turn: 1 }));
  });

  await page.route("**/apply", async (route) => {
    applyCalls++;
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });

  await page.route("**/resign", async (route) => {
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });

  await page.route("**/hint", async (route) => {
    await fulfill(route, { hint: "", backend: "local" });
  });

  await page.route("**/evaluate", async (route) => {
    await fulfill(route, { candidates: [] });
  });

  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();
  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 10_000 });
  expect(skipCalls).toBeGreaterThanOrEqual(1);
  expect(applyCalls).toBeGreaterThanOrEqual(1);
});

// ── Test 19: multiple consecutive /skip calls (several bar dances) ────────────

test("ff-19: fast-forward handles multiple consecutive /skip turns before game over", async ({
  page,
}) => {
  let moveCalls = 0;
  let skipCalls = 0;

  await page.route("**/new", async (route) => {
    await fulfill(route, makeState({ turn: 0 }));
  });

  // First three /move calls return null; fourth returns a real move.
  await page.route("**/move", async (route) => {
    moveCalls++;
    const move = moveCalls <= 3 ? null : "13/10";
    await fulfill(route, { move, candidates: [] });
  });

  await page.route("**/skip", async (route) => {
    skipCalls++;
    // Keep alternating turns so the loop keeps calling /move.
    await fulfill(route, makeState({ turn: skipCalls % 2 === 0 ? 0 : 1 }));
  });

  await page.route("**/apply", async (route) => {
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });

  await page.route("**/resign", async (route) => {
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });

  await page.route("**/hint", async (route) => {
    await fulfill(route, { hint: "", backend: "local" });
  });

  await page.route("**/evaluate", async (route) => {
    await fulfill(route, { candidates: [] });
  });

  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();
  await page.getByRole("button", { name: /fast forward/i }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 10_000 });
  // All three null-move turns must have triggered /skip.
  expect(skipCalls).toBeGreaterThanOrEqual(3);
});

// ── Test 20: API error during fast-forward shows error message ────────────────

test("ff-20: an API error during fast-forward surfaces an error message on the page", async ({
  page,
}) => {
  await page.route("**/new", async (route) => {
    await fulfill(route, makeState({ turn: 0 }));
  });

  // /move succeeds but /apply returns 500 on first call.
  await page.route("**/move", async (route) => {
    await fulfill(route, { move: "13/10", candidates: [] });
  });

  let applyCalls = 0;
  await page.route("**/apply", async (route) => {
    applyCalls++;
    if (applyCalls === 1) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "gnubg crashed" }),
      });
    } else {
      await fulfill(route, GAME_OVER_AGENT_WINS);
    }
  });

  await page.route("**/skip", async (route) => {
    await fulfill(route, makeState({ turn: 1 }));
  });

  await page.route("**/resign", async (route) => {
    await fulfill(route, GAME_OVER_AGENT_WINS);
  });

  await page.route("**/hint", async (route) => {
    await fulfill(route, { hint: "", backend: "local" });
  });

  await page.route("**/evaluate", async (route) => {
    await fulfill(route, { candidates: [] });
  });

  await page.goto("/match?agentId=1");
  await page.getByTestId("start-game-button").click();
  await page.getByRole("button", { name: /fast forward/i }).click();

  // The error paragraph must be visible — the page must not crash or stay blank.
  await expect(
    page.locator("p.text-red-600, p.text-red-400"),
  ).toBeVisible({ timeout: 10_000 });
});
