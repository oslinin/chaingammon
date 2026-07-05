// human_vs_human_synpress.spec.ts
//
// Full HvH E2E: matchmaking → game → gnubg evaluation → winner verification.
// Shared harness (WebRTC mock, message bridge, in-memory Nostr relay, mock
// wallets, match setup) lives in hvh_test_utils.ts.
//
// Test 1 (first-legal-move auto-play + gnubg oracle):
//   1. Start the backend FastAPI server (for /evaluate and /play_to_end).
//   2. Matchmake two players via the shared harness.
//   3. Verify gnubg /evaluate returns candidate moves.
//   4. Verify gnubg /play_to_end returns game_over=true and a winner.
//   5. testMode auto-plays both sides; wait for game-over banner on both pages.
//   6. Assert exactly one player wins.
//
// Test 2 (model moves + resolution correctness):
//   Same matchmaking, but with window.__HVH_MODEL_MOVES set so every turn is
//   played with the highest-equity candidate from the BackgammonNet ONNX
//   evaluator (the model that powers the in-game move advisor). After the
//   game-over banner appears the test reads both peers' authoritative
//   MatchState (exposed as window.__HVH_GAME_STATE in testMode) and asserts
//   the game resolved correctly and identically on both sides: same winner,
//   same final position_id (no desync), same score, winner bore off all 15
//   checkers, and the model actually decided the moves on both pages.

import { test, expect } from "@playwright/test";
import { exec } from "child_process";
import { setupMatch, readHvhState, type HvhSnapshot } from "./hvh_test_utils";

// ── Backend server lifecycle ──────────────────────────────────────────────────

let backendProcess: ReturnType<typeof exec> | null = null;

test.beforeAll(async () => {
  exec("kill $(lsof -t -i :8000) 2>/dev/null || true");
  await new Promise((r) => setTimeout(r, 500));
  backendProcess = exec("cd ../server && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000");
  await new Promise((r) => setTimeout(r, 5000));
});

test.afterAll(async () => {
  if (backendProcess) backendProcess.kill();
  exec("kill $(lsof -t -i :8000) 2>/dev/null || true");
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Human vs Human - ENS, Turn Sync, and Rules Engine UI Regression", () => {
  // matchmaking (60s) + game play (up to 240s under load) + backend calls + overhead
  test.setTimeout(360_000);

  test(
    "two players match, gnubg evaluator validates moves and winner, game plays to completion",
    async ({ browser }) => {
      const { ctx1, ctx2, page1, page2 } = await setupMatch(browser);

      try {
        // 1. gnubg move evaluation — server-side gnubg ranks legal moves.
        const evalResponse = await page1.request.post("http://127.0.0.1:8000/evaluate", {
          data: { position_id: "4HPwATDgc/ABMA", match_id: "cAgAAAAAAAAA", dice: [3, 1] },
        });
        expect(evalResponse.ok()).toBe(true);
        const evalData = await evalResponse.json();
        expect(Array.isArray(evalData.candidates)).toBe(true);
        expect(evalData.candidates.length).toBeGreaterThan(0);
        expect(typeof evalData.candidates[0].move).toBe("string");
        expect(typeof evalData.candidates[0].equity).toBe("number");

        // 2. gnubg play-to-end — gnubg plays a full game and names the winner.
        const playEndResponse = await page1.request.post("http://127.0.0.1:8000/play_to_end", {
          data: { position_id: "4HPwATDgc/ABMA", match_id: "cAgAAAAAAAAA" },
        });
        expect(playEndResponse.ok()).toBe(true);
        const playEndData = await playEndResponse.json();
        expect(playEndData.game_over).toBe(true);
        expect(playEndData.winner).toBeDefined();
        expect([0, 1]).toContain(playEndData.winner);

        // 3. testMode drives both sides to completion via auto-play.
        await Promise.all([
          expect(page1.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 240_000 }),
          expect(page2.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 240_000 }),
        ]);

        // Exactly one player wins and the other loses.
        const p1Text = await page1.getByText(/You win!|Opponent wins/).textContent();
        const p2Text = await page2.getByText(/You win!|Opponent wins/).textContent();
        expect([p1Text, p2Text].sort()).toEqual(["Opponent wins", "You win!"]);
      } finally {
        await ctx1.close();
        await ctx2.close();
      }
    },
  );

  test(
    "game played with model moves resolves correctly and identically on both peers",
    async ({ browser }) => {
      // Model inference on every turn is slower than first-legal-move play
      // (~1.5 s per ply), so play a single game (match to 1) rather than the
      // default 3-point match.
      test.setTimeout(420_000);
      const { ctx1, ctx2, page1, page2 } = await setupMatch(browser, {
        modelMoves: true,
        matchLength: 1,
      });

      try {
        // Auto-play both sides with the ONNX model's top-ranked move until
        // the game-over banner appears on both pages.
        await Promise.all([
          expect(page1.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 300_000 }),
          expect(page2.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 300_000 }),
        ]);

        // Exactly one player wins and the other loses.
        const p1Text = await page1.getByText(/You win!|Opponent wins/).textContent();
        const p2Text = await page2.getByText(/You win!|Opponent wins/).textContent();
        expect([p1Text, p2Text].sort()).toEqual(["Opponent wins", "You win!"]);

        // Read each peer's authoritative final MatchState.
        const s1 = await readHvhState(page1);
        const s2 = await readHvhState(page2);
        console.log("final state p1:", JSON.stringify(s1));
        console.log("final state p2:", JSON.stringify(s2));

        for (const s of [s1, s2]) {
          expect(s.game).not.toBeNull();
          expect(s.game!.game_over).toBe(true);
          expect([0, 1]).toContain(s.game!.winner);
          // The model (not the legal-move fallback) must have decided moves.
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

        // Resolution correctness: the winner reached match_length points and
        // ended the game by bearing off all 15 checkers; the loser did not.
        expect(s1.game!.score[winner]).toBeGreaterThanOrEqual(s1.game!.match_length);
        expect(s1.game!.score[loser]).toBeLessThan(s1.game!.match_length);
        expect(s1.game!.off[winner]).toBe(15);

        // The banner on each page must agree with that page's side.
        const bannerFor = (s: HvhSnapshot) =>
          s.mySide === winner ? "You win!" : "Opponent wins";
        expect(p1Text).toBe(bannerFor(s1));
        expect(p2Text).toBe(bannerFor(s2));
      } finally {
        await ctx1.close();
        await ctx2.close();
      }
    },
  );
});
