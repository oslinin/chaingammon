// Regression test: dice must not be oversized relative to the surrounding UI.
// Uses the /test-dice fixture page which renders DiceRoll without blockchain deps.
//
// The Die SVG is sized via Tailwind's h-* / w-* classes. This test measures
// the rendered bounding box and fails if any die exceeds 32px in either
// dimension, catching accidental upgrades back to h-10/w-10 (40px).

import { test, expect } from "@playwright/test";

const MAX_DIE_PX = 32;

test("dice are not oversized", async ({ page }) => {
  await page.goto("/test-dice");
  await page.waitForLoadState("networkidle");

  // Wait for the dice SVGs to appear and for CSS to be applied.
  const dice = page.locator('[aria-label^="Die showing"]');
  await expect(dice.first()).toBeVisible();
  // Give styles a tick to compute after visibility.
  await page.waitForTimeout(200);

  const count = await dice.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const box = await dice.nth(i).boundingBox();
    expect(box, `die ${i} has no bounding box`).not.toBeNull();
    expect(
      box!.width,
      `die ${i} width ${box!.width}px exceeds ${MAX_DIE_PX}px`
    ).toBeLessThanOrEqual(MAX_DIE_PX);
    expect(
      box!.height,
      `die ${i} height ${box!.height}px exceeds ${MAX_DIE_PX}px`
    ).toBeLessThanOrEqual(MAX_DIE_PX);
  }
});
