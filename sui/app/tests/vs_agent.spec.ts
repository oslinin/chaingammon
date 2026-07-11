// vs_agent.spec.ts — Task 7 Step 4's app-side bullet: "play vs agent" runs
// a full local game against the onnx_eval worker's model.
//
// Chain-agnostic and single-browser: no localnet, no Nostr relay mock, no
// WebRTC bridge — the agent side runs in-process via the ONNX worker and
// testMode auto-plays the human side (same __HVH_* hook contract as /play).
// This intentionally exercises the same worker path (`evaluateMoves` /
// `getBestMove`) a decrypted fetch_weights.ts model goes through after
// `loadAgentModel` swaps it in — the only thing not covered here is the
// file-picker byte hand-off itself, since a real decrypted agent .onnx
// requires the Seal/Walrus network path this environment can't reach (the
// bundled base model is byte-for-byte the same *format*, so the load path
// is identical).
import { test, expect } from "@playwright/test";
import type { HvhSnapshot } from "./hvh_test_utils";

test.describe("Play vs agent — local game against the ONNX worker", () => {
  test.setTimeout(420_000);

  test("full game vs the agent resolves with a winner and 15 checkers off", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as Window & {
        __HVH_TEST_MODE?: boolean;
        __HVH_MODEL_MOVES?: boolean;
        __HVH_MATCH_LENGTH?: number;
      };
      w.__HVH_TEST_MODE = true;
      w.__HVH_MODEL_MOVES = true;
      w.__HVH_MATCH_LENGTH = 1;
    });

    await page.goto("/play-agent");

    await expect(page.getByText(/You win!|Agent wins/)).toBeVisible({ timeout: 300_000 });

    const s = await page.evaluate(() => {
      const w = window as Window & {
        __HVH_GAME_STATE?: HvhSnapshot["game"];
        __HVH_MODEL_MOVE_COUNT?: number;
      };
      return { game: w.__HVH_GAME_STATE ?? null, modelMoveCount: w.__HVH_MODEL_MOVE_COUNT ?? 0 };
    });
    console.log("final vs-agent state:", JSON.stringify(s));

    expect(s.game).not.toBeNull();
    expect(s.game!.game_over).toBe(true);
    expect([0, 1]).toContain(s.game!.winner);
    // The ONNX worker actually decided moves — this is the assertion that
    // makes the test mean "the agent model played", not "the fallback
    // legal-move order played". Requires public/js/'s WASM assets (see
    // package.json's copy:wasm postinstall step); without them the worker
    // fails init and every side silently degrades to fallback moves.
    expect(s.modelMoveCount).toBeGreaterThan(0);

    const winner = s.game!.winner as 0 | 1;
    expect(s.game!.off[winner]).toBe(15);
    expect(s.game!.score[winner]).toBeGreaterThanOrEqual(s.game!.match_length);

    const banner = await page.getByText(/You win!|Agent wins/).textContent();
    expect(banner).toBe(winner === 0 ? "You win!" : "Agent wins");
  });
});
