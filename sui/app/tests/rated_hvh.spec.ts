// rated_hvh.spec.ts — Task 6 Step 4: the plan's hardest test. A full rated
// match on a real local Sui network, played end to end with model moves:
// stakes locked at open/join, every roll sourced from an on-chain
// DiceRolled event (sui::random via chaingammon::game_match::roll, not
// commit-reveal), settlement pays the winner, and both players' HumanProfile
// ELO moves (winner up, loser down).
//
// Requires localnet: see tests/localnet_global_setup.ts (same globalSetup as
// profile_signin.spec.ts, reused per the plan's Step 4 note). Skips itself
// when no `sui` CLI / localnet config is available, same pattern as
// profile_signin.spec.ts.
//
// Unlike unrated_hvh.spec.ts, this game has TWO oracles to check: the P2P
// game state (both peers agree on winner/score/position_id, same as
// unrated) AND the chain (Match object reaches SETTLED, both HumanProfiles'
// ELO actually moved). Either oracle disagreeing is a real bug.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { setupMatch, readRatedHvhState, type RatedHvhSnapshot } from "./hvh_test_utils";
import { hasProfile, profileIdFor, fetchProfile, type LocalnetConfig } from "../lib/sui_client";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const CONFIG_PATH = path.join(__dirname, "..", "public", "localnet-config.json");

test.beforeAll(() => {
  test.skip(!existsSync(CONFIG_PATH), "no `sui` CLI / localnet available in this environment (see localnet_global_setup.ts)");
});

test.describe("Rated P2P play — staked match, on-chain dice, cosigned settle", () => {
  test.setTimeout(600_000);

  test("full rated match resolves identically on both peers, pays the winner, and moves both ELOs", async ({ browser }) => {
    const config: LocalnetConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

    const { ctx1, ctx2, page1, page2 } = await setupMatch(browser, {
      modelMoves: true,
      matchLength: 1,
      rated: true,
    });

    try {
      await Promise.all([
        expect(page1.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 480_000 }),
        expect(page2.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 480_000 }),
      ]);

      // Game-over doesn't mean settled yet — wait for both pages' post-game
      // sig exchange + settle attempt to finish (phase -> "over").
      await Promise.all([
        page1.waitForFunction(() => (window as Window & { __HVH_PHASE?: string }).__HVH_PHASE === "over", { timeout: 60_000 }),
        page2.waitForFunction(() => (window as Window & { __HVH_PHASE?: string }).__HVH_PHASE === "over", { timeout: 60_000 }),
      ]);

      const s1 = await readRatedHvhState(page1);
      const s2 = await readRatedHvhState(page2);
      console.log("final rated state p1:", JSON.stringify(s1));
      console.log("final rated state p2:", JSON.stringify(s2));

      for (const s of [s1, s2] as RatedHvhSnapshot[]) {
        expect(s.game).not.toBeNull();
        expect(s.game!.game_over).toBe(true);
        expect([0, 1]).toContain(s.game!.winner);
        expect(s.modelMoveCount).toBeGreaterThan(0);
        expect(s.matchObjectId).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(s.mySuiAddress).toMatch(/^0x[0-9a-f]{64}$/i);
      }

      // Both peers independently resolved to the identical final state —
      // same oracle as unrated_hvh.spec.ts, proves no desync.
      expect(s1.game!.winner).toBe(s2.game!.winner);
      expect(s1.game!.position_id).toBe(s2.game!.position_id);
      expect(s1.game!.score).toEqual(s2.game!.score);
      expect([s1.mySide, s2.mySide].sort()).toEqual([0, 1]);
      expect(s1.matchObjectId).toBe(s2.matchObjectId);

      const winner = s1.game!.winner as 0 | 1;
      const loser = (1 - winner) as 0 | 1;
      expect(s1.game!.score[winner]).toBeGreaterThanOrEqual(s1.game!.match_length);
      expect(s1.game!.off[winner]).toBe(15);

      // At least one side must have actually landed the on-chain settle
      // (double-settle from the other side is an acceptable race, not a
      // failure — settle_cosigned's second call simply aborts on
      // EWrongState and the app treats that as "already settled").
      const settledOk = (n: string | null) => !!n && n.startsWith("Settled on-chain");
      expect(settledOk(s1.settledNote) || settledOk(s2.settledNote)).toBe(true);

      // ── Chain oracle: the Match object actually reached SETTLED ──────────
      const client = new SuiJsonRpcClient({ url: config.rpcUrl, network: "localnet" });
      const matchObj = await client.getObject({ id: s1.matchObjectId!, options: { showContent: true } });
      const content = matchObj.data?.content;
      if (!content || content.dataType !== "moveObject") throw new Error("Match object has no content");
      const fields = content.fields as Record<string, unknown>;
      expect(Number(fields.state)).toBe(2); // STATE_SETTLED — see game_match.move
      expect(Number(fields.turn_index)).toBeGreaterThan(0); // dice actually came from on-chain rolls

      // ── Chain oracle: both HumanProfiles' ELO actually moved ─────────────
      // Each browser context is fresh (new mock identity, new profile) so
      // both start at the default 1500 — no "before" snapshot needed.
      const winnerAddr = winner === s1.mySide ? s1.mySuiAddress! : s2.mySuiAddress!;
      const loserAddr = winner === s1.mySide ? s2.mySuiAddress! : s1.mySuiAddress!;

      expect(await hasProfile(config, winnerAddr)).toBe(true);
      expect(await hasProfile(config, loserAddr)).toBe(true);
      const winnerProfile = await fetchProfile(config, await profileIdFor(config, winnerAddr));
      const loserProfile = await fetchProfile(config, await profileIdFor(config, loserAddr));
      console.log("winner profile:", JSON.stringify(winnerProfile), "loser profile:", JSON.stringify(loserProfile));

      expect(winnerProfile.elo).toBeGreaterThan(1500);
      expect(loserProfile.elo).toBeLessThan(1500);
      expect(winnerProfile.matchCount).toBe(1);
      expect(loserProfile.matchCount).toBe(1);

      const bannerFor = (s: RatedHvhSnapshot) => (s.mySide === winner ? "You win!" : "Opponent wins");
      const p1Text = await page1.getByText(/You win!|Opponent wins/).textContent();
      const p2Text = await page2.getByText(/You win!|Opponent wins/).textContent();
      expect(p1Text).toBe(bannerFor(s1));
      expect(p2Text).toBe(bannerFor(s2));
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});
