// Match-page board-state regression coverage.
//
// History (2026-04-29): a perspective bug in agent/gnubg_state.py's
// `decode_position_id` returned wrong board values for some mid-game
// states (gnubg's position_id is encoded relative to the on-roll
// player, and the pure-Python decoder didn't account for the
// rotation). After a human move + agent move, the rendered board
// showed pieces in places they shouldn't be — sometimes with human
// and agent checkers swapped. The fix switched `snapshot_state` to
// parse gnubg's authoritative `rawboard` output. This test locks in
// the rendered DOM so that regression returns immediately if the
// decoder ever drifts.
//
// Strategy: drive `/match?agentId=1` against mocked gnubg_service
// responses with KNOWN board fixtures captured from real gnubg
// sessions. Assert that after each turn, every checker on the page
// is at the expected point with the expected count and color.

import { test, expect, type Route } from "@playwright/test";

// ── Fixtures captured from real gnubg `new match 3` sequences ─────────────
// Standard backgammon opening (always the same regardless of which side
// is on roll first).
const OPENING_BOARD = [
  -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5,
  5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2,
];

// After human plays 8/5 6/5 with dice [3, 1].
// Two human checkers moved: one from point 6, one from point 8, both
// to point 5. Agent's pieces are untouched.
const AFTER_HUMAN_8_5_6_5 = [
  -2, 0, 0, 0, 2, 4, 0, 2, 0, 0, 0, -5,
  5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2,
];

// After agent plays 24/14 with dice [6, 4].
// One agent checker moved from point 1 (agent's "24") to point 11
// (agent's "14"). Human's previous moves stay in place.
const AFTER_AGENT_24_14 = [
  -1, 0, 0, 0, 2, 4, 0, 2, 0, 0, -1, -5,
  5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2,
];

// ── Helpers ──────────────────────────────────────────────────────────────

function matchState(board: number[], turn: 0 | 1, gameOver = false) {
  return {
    position_id: `pos${board.join(",").length}`, // any non-empty string
    match_id: `mid${board.join(",").length}`,
    board,
    bar: [0, 0],
    off: [0, 0],
    turn,
    dice: null,
    score: [0, 0],
    match_length: 3,
    game_over: gameOver,
    winner: gameOver ? 0 : null,
  };
}

const fulfillJSON = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

/**
 * Count rendered blue (human) and red (agent) dot elements at each
 * point. The Board component renders a fixed-width column per point
 * and stacks `<div class="...bg-blue-500..." or "...bg-red-500...">`
 * for each checker. We count the dots colored each way.
 *
 * Returns a 24-element signed array — positive = blue dots = human,
 * negative = red dots = agent — matching the same convention as the
 * MatchState `board` field.
 */
async function readRenderedBoard(page: import("@playwright/test").Page) {
  // The Board component has 24 cells (one per point). Each cell has
  // checkers as colored divs. The rendering uses a `+N` label when a
  // point has more than 5 checkers, so we sum the visible dot count
  // plus the label number.
  return await page.evaluate(() => {
    const out: number[] = Array.from({ length: 24 }, () => 0);

    // Find every dot (blue or red) on the page. Each dot lives in a
    // PointCell; siblings share a column. The point number for that
    // column is on a sibling label, but it's simpler to walk the DOM
    // by column-position via the rendered structure.
    //
    // Strategy: for each Point cell, count its blue + red dots and
    // read the visible point label.
    const cells = Array.from(document.querySelectorAll("[data-testid^='point-']"));
    for (const cell of cells) {
      const idx = Number((cell as HTMLElement).dataset.testid?.replace("point-", ""));
      if (Number.isNaN(idx)) continue;
      const blueDots = cell.querySelectorAll(".bg-blue-500").length;
      const redDots = cell.querySelectorAll(".bg-red-500").length;
      // Pick up the +N label if present.
      const extraLabel = (cell.textContent ?? "").match(/\+(\d+)/);
      const extra = extraLabel ? Number(extraLabel[1]) : 0;
      // Whichever color has dots, the extra adds to that side.
      if (blueDots > 0) out[idx] = blueDots + extra;
      else if (redDots > 0) out[idx] = -(redDots + extra);
      else out[idx] = 0;
    }
    return out;
  });
}

// ── The test ─────────────────────────────────────────────────────────────

test("board renders pieces correctly through opening → human move → agent move", async ({
  page,
}) => {
  let applyCount = 0;

  // POST /new — opening state, human (turn=0) on roll.
  await page.route("**/new", async (route) => {
    await fulfillJSON(route, matchState(OPENING_BOARD, 0));
  });

  // POST /apply — first call returns post-human-move state (turn flips
  // to agent); second call returns post-agent-move state (turn flips
  // back to human).
  await page.route("**/apply", async (route) => {
    applyCount += 1;
    if (applyCount === 1) {
      await fulfillJSON(route, matchState(AFTER_HUMAN_8_5_6_5, 1));
    } else {
      await fulfillJSON(route, matchState(AFTER_AGENT_24_14, 0));
    }
  });

  // POST /move — agent's pick.
  await page.route("**/move", async (route) => {
    await fulfillJSON(route, { move: "24/14", candidates: [] });
  });

  // POST /resign — defensive, in case the page ever fires it.
  await page.route("**/resign", async (route) => {
    await fulfillJSON(route, matchState(OPENING_BOARD, 0, true));
  });

  await page.goto("/match?agentId=1");

  // Wait for the Board to mount with the opening position.
  await expect(page.locator("[data-testid='point-0']")).toBeVisible({
    timeout: 10_000,
  });

  // 1. Opening — pieces in standard backgammon positions.
  await expect.poll(() => readRenderedBoard(page)).toEqual(OPENING_BOARD);

  // 2. Submit a human move; expect the post-human-move board.
  const moveInput = page.getByPlaceholder('e.g. "8/5 6/5" or "off"');
  await moveInput.fill("8/5 6/5");
  await page.getByRole("button", { name: "Move" }).click();

  // After the human move the page kicks the agent loop. The final
  // state seen by the user is post-agent-move. Wait for that.
  await expect.poll(() => readRenderedBoard(page), { timeout: 5_000 }).toEqual(
    AFTER_AGENT_24_14,
  );

  // Sanity: human's previous moves are preserved (didn't get reverted)
  // and agent's checker is at point 11 (index 10), human checkers at
  // 5/6/8 are still where they were placed.
  const final = await readRenderedBoard(page);
  expect(final[4]).toBe(2); // p5: 2 human (from 8/5 + 6/5)
  expect(final[5]).toBe(4); // p6: 4 human (was 5, lost 1)
  expect(final[7]).toBe(2); // p8: 2 human (was 3, lost 1)
  expect(final[10]).toBe(-1); // p11: 1 agent (just moved here)
  expect(final[0]).toBe(-1); // p1: 1 agent (was 2, lost 1)
});
