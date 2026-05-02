// Full-game winner regression coverage.
//
// History (2026-04-29): a perspective bug in agent/gnubg_state.py
// `decode_match_id` returned scores from the on-roll player's
// perspective instead of canonical [human, agent]. After a turn flip
// at game-end, the scores were rotated and snapshot_state's winner
// determination labelled the loser as the winner. The user observed
// this as "I bore off 15 / 15 but the banner said 'Agent wins.'"
//
// Fix: snapshot_state now reads score from rawboard's authoritative
// [score_X, score_O] fields. game_over also now triggers when one
// side has borne off 15, regardless of what match_id's game_state bit
// claims.
//
// This spec drives /match?agentId=1 against mocked gnubg_service
// responses through to a HUMAN-WINS game-over state and asserts the
// banner says "You win!" with the correct score. A second test
// asserts the symmetric AGENT-WINS case.

import { test, expect, type Route } from "@playwright/test";

const fulfillJSON = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

// Standard backgammon opening, human on roll.
const OPENING_BOARD = [
  -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5,
  5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2,
];

function matchState(opts: {
  board?: number[];
  bar?: [number, number];
  off?: [number, number];
  turn?: 0 | 1;
  score?: [number, number];
  game_over?: boolean;
  winner?: 0 | 1 | null;
}) {
  return {
    position_id: `pos${Math.random()}`,
    match_id: `mid${Math.random()}`,
    board: opts.board ?? OPENING_BOARD,
    bar: opts.bar ?? [0, 0],
    off: opts.off ?? [0, 0],
    turn: opts.turn ?? 0,
    dice: null,
    score: opts.score ?? [0, 0],
    match_length: 3,
    game_over: opts.game_over ?? false,
    winner: opts.winner ?? null,
  };
}

test("game ends with human winning — banner says 'You win!' with score 1-0", async ({
  page,
}) => {
  let applyCount = 0;

  await page.route("**/new", async (route) => {
    await fulfillJSON(route, matchState({ board: OPENING_BOARD, turn: 0 }));
  });

  // Sequence: human moves once, agent moves once, then human's next move
  // is the bear-off that ends the game with human winning.
  await page.route("**/apply", async (route) => {
    applyCount += 1;
    if (applyCount === 1) {
      // After human's first move — turn flips to agent.
      await fulfillJSON(
        route,
        matchState({
          board: [-2, 0, 0, 0, 2, 4, 0, 2, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2],
          turn: 1,
        }),
      );
    } else if (applyCount === 2) {
      // After agent's first move — back to human.
      await fulfillJSON(
        route,
        matchState({
          board: [-1, 0, 0, 0, 2, 4, 0, 2, 0, 0, -1, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2],
          turn: 0,
        }),
      );
    } else {
      // Human bears off the last checker → game ends, human wins.
      // Synthesised end state: human has 15 off, agent has 8 off (7 still
      // on the board), score [1, 0], winner 0.
      await fulfillJSON(
        route,
        matchState({
          board: [-3, -2, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          off: [15, 8],
          turn: 0,
          score: [1, 0],
          game_over: true,
          winner: 0,
        }),
      );
    }
  });

  await page.route("**/move", async (route) => {
    await fulfillJSON(route, { move: "24/14", candidates: [] });
  });

  // Catch-all so a stray /resign call doesn't escape during the test.
  await page.route("**/resign", async (route) => {
    await fulfillJSON(
      route,
      matchState({ game_over: true, winner: 1, score: [0, 1] }),
    );
  });

  await page.goto("/match?agentId=1");

  // Click "Start Game" on the pre-game landing.
  await page.getByTestId("start-game-button").click();

  // Submit the first human move.
  const moveInput = page.getByPlaceholder('e.g. "8/5 6/5" or "off"');
  await moveInput.fill("8/5 6/5");
  await page.getByRole("button", { name: "Move" }).click();

  // After human + agent cascade, we're back to human's turn.
  await expect(moveInput).toBeVisible({ timeout: 5_000 });

  // Submit the winning move.
  await moveInput.fill("6/off 5/off");
  await page.getByRole("button", { name: "Move" }).click();

  // ── Critical assertions ────────────────────────────────────────────────
  // Banner must say "You win!" — NOT "Agent wins." The bug we fixed had
  // this exact banner showing the wrong winner.
  await expect(page.getByText("You win!")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Agent wins.")).toHaveCount(0);

  // Final score line shows 1 – 0 (human – agent).
  await expect(page.getByText(/Final score:\s*1\s*[–-]\s*0/)).toBeVisible();
});

test("game ends with agent winning — banner says 'Agent wins.' with score 0-1", async ({
  page,
}) => {
  let applyCount = 0;

  await page.route("**/new", async (route) => {
    await fulfillJSON(route, matchState({ board: OPENING_BOARD, turn: 0 }));
  });

  await page.route("**/apply", async (route) => {
    applyCount += 1;
    if (applyCount === 1) {
      // Human's move; turn flips to agent.
      await fulfillJSON(
        route,
        matchState({
          board: [-2, 0, 0, 0, 2, 4, 0, 2, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2],
          turn: 1,
        }),
      );
    } else {
      // Agent bears off last checker → game ends, agent wins.
      await fulfillJSON(
        route,
        matchState({
          board: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 3],
          off: [8, 15],
          turn: 1,
          score: [0, 1],
          game_over: true,
          winner: 1,
        }),
      );
    }
  });

  await page.route("**/move", async (route) => {
    await fulfillJSON(route, { move: "6/off 5/off", candidates: [] });
  });

  await page.route("**/resign", async (route) => {
    await fulfillJSON(
      route,
      matchState({ game_over: true, winner: 1, score: [0, 1] }),
    );
  });

  await page.goto("/match?agentId=1");

  // Click "Start Game" on the pre-game landing.
  await page.getByTestId("start-game-button").click();

  // One human move triggers the agent's winning move.
  await page.getByPlaceholder('e.g. "8/5 6/5" or "off"').fill("8/5 6/5");
  await page.getByRole("button", { name: "Move" }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("You win!")).toHaveCount(0);
  await expect(page.getByText(/Final score:\s*0\s*[–-]\s*1/)).toBeVisible();
});
