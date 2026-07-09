// unrated_hvh.spec.ts — full unrated P2P E2E: matchmaking → commit-reveal
// dice → a complete game → winner resolution, verified identically on both
// peers.
//
// Unlike frontend/tests/human_vs_human_synpress.spec.ts this app has no
// gnubg backend to cross-check against (server/ is EVM-app-only and out of
// scope here) — the oracle for "did the game resolve correctly" is simply
// that both independently-running peers reach the same winner, score, and
// position_id with no desync, and that the winner actually bore off all 15
// checkers.
//
// Model inference on every turn is slower than first-legal-move play, so
// play a single game (match to 1) rather than a multi-game match.

import { test, expect } from "@playwright/test";
import { setupMatch, readHvhState, type HvhSnapshot } from "./hvh_test_utils";

test.describe("Unrated P2P play — commit-reveal dice, model moves", () => {
  test.setTimeout(420_000);

  test("game played with model moves resolves correctly and identically on both peers", async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await setupMatch(browser, {
      modelMoves: true,
      matchLength: 1,
    });

    try {
      await Promise.all([
        expect(page1.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 300_000 }),
        expect(page2.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 300_000 }),
      ]);

      const p1Text = await page1.getByText(/You win!|Opponent wins/).textContent();
      const p2Text = await page2.getByText(/You win!|Opponent wins/).textContent();
      expect([p1Text, p2Text].sort()).toEqual(["Opponent wins", "You win!"]);

      const s1 = await readHvhState(page1);
      const s2 = await readHvhState(page2);
      console.log("final state p1:", JSON.stringify(s1));
      console.log("final state p2:", JSON.stringify(s2));

      for (const s of [s1, s2]) {
        expect(s.game).not.toBeNull();
        expect(s.game!.game_over).toBe(true);
        expect([0, 1]).toContain(s.game!.winner);
        expect(s.modelMoveCount).toBeGreaterThan(0);
      }

      // The two peers were assigned opposite sides…
      expect([s1.mySide, s2.mySide].sort()).toEqual([0, 1]);

      // …and independently resolved to the identical final state: same
      // winner, same board (position_id — proves no desync), same score.
      expect(s1.game!.winner).toBe(s2.game!.winner);
      expect(s1.game!.position_id).toBe(s2.game!.position_id);
      expect(s1.game!.score).toEqual(s2.game!.score);

      const winner = s1.game!.winner as 0 | 1;
      const loser = (1 - winner) as 0 | 1;

      expect(s1.game!.score[winner]).toBeGreaterThanOrEqual(s1.game!.match_length);
      expect(s1.game!.score[loser]).toBeLessThan(s1.game!.match_length);
      expect(s1.game!.off[winner]).toBe(15);

      const bannerFor = (s: HvhSnapshot) => (s.mySide === winner ? "You win!" : "Opponent wins");
      expect(p1Text).toBe(bannerFor(s1));
      expect(p2Text).toBe(bannerFor(s2));
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});
