// Phase 30: Playwright tests for the Expenses page.
//
// Verifies:
//   1. The Expenses sidebar entry is visible and links to /expenses.
//   2. The empty-state card is shown when localStorage has no expense entries.
//   3. A table of entries is shown when localStorage is pre-populated.
//
// No wallet or backend connection is required — the page reads only from
// localStorage and renders entirely client-side.

import { test, expect } from "@playwright/test";

test.describe("Expenses page", () => {
  test("sidebar Expenses entry is visible and links to /expenses", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const expensesLink = page.locator('[data-testid="sidebar-expenses"]');
    await expect(expensesLink).toBeVisible({ timeout: 5000 });
    await expect(expensesLink).toContainText("Expenses");

    const href = await expensesLink.getAttribute("href");
    expect(href).toBe("/expenses");
  });

  test("shows empty state when no expense entries exist", async ({ page }) => {
    // Ensure localStorage is clean before navigating.
    await page.goto("/");
    await page.evaluate(() =>
      window.localStorage.removeItem("chaingammon_expenses"),
    );

    await page.goto("/expenses");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="expenses-empty"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test("shows populated table when localStorage contains expense entries", async ({
    page,
  }) => {
    // Seed a coach-hint expense directly into localStorage before the page loads.
    await page.goto("/");
    await page.evaluate(() => {
      const entries = [
        {
          id: "test-entry-1",
          timestamp: new Date().toISOString(),
          type: "coach_hint",
          description: "Coach hint · Agent #1 · Qwen 2.5 7B via 0G Compute",
        },
      ];
      window.localStorage.setItem(
        "chaingammon_expenses",
        JSON.stringify(entries),
      );
    });

    await page.goto("/expenses");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="expenses-table"]'),
    ).toBeVisible({ timeout: 5000 });
    await expect(page.locator("table")).toContainText(
      "Coach hint · Agent #1 · Qwen 2.5 7B via 0G Compute",
    );
  });
});
