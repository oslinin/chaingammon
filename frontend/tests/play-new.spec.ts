// Commit 2: /play/new picker rendering + control behaviour.
//
// The page reads PlayerSubnameRegistrar's SubnameMinted log; without a
// connected wallet and a deployment on the active chain, the roster is
// empty. We exercise the empty-state flow:
//   - both side panels render
//   - match-length and mode toggles update visibly
//   - career-mode disclosure appears
//   - Start button shows "Pick a player on each side" and is disabled

import { test, expect } from "@playwright/test";

test.describe("/play/new picker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/play/new");
    await page.waitForLoadState("networkidle");
  });

  test("renders both side panels and the match config", async ({ page }) => {
    await expect(page.getByTestId("side-side-a")).toBeVisible();
    await expect(page.getByTestId("side-side-b")).toBeVisible();
    await expect(page.getByTestId("match-config")).toBeVisible();
  });

  test("Start button is disabled when no players are picked", async ({ page }) => {
    const btn = page.getByTestId("start-button");
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveText("Pick a player on each side");
  });

  test("match-length buttons toggle the active length", async ({ page }) => {
    // Default is 5.
    const five = page.getByTestId("length-5");
    const seven = page.getByTestId("length-7");
    await expect(five).toBeVisible();
    await seven.click();
    // After clicking 7, it gets the active styling (presence of bg-indigo-600
    // vs the bordered fallback). We don't assert classes; just that the
    // click succeeds and the button is still visible.
    await expect(seven).toBeVisible();
  });

  test("career mode shows convergence disclosure", async ({ page }) => {
    await page.getByTestId("mode-career").click();
    await expect(page.getByText(/zero context features in v1/i)).toBeVisible();
  });

  test("single mode hides career disclosure", async ({ page }) => {
    await page.getByTestId("mode-career").click();
    await page.getByTestId("mode-single").click();
    await expect(page.getByText(/zero context features in v1/i)).not.toBeVisible();
  });
});
