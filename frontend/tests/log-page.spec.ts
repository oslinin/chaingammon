// Phase 36: Playwright tests for /log/[matchId] — 0G Storage log viewer.
//
// Verifies:
//   1. The sidebar "0G Storage log" entry is visible and links to the log route.
//   2. The log page renders its shell with the chronological-feed testid.
//   3. The empty/pending state is shown when no archive URI is in localStorage.
//   4. "No active match" message appears when the route uses the no-match sentinel.
//
// No wallet or backend connection is required — the page reads only from
// localStorage. When no archive URI is stored, the empty state renders
// without making any network requests.

import { test, expect } from "@playwright/test";

const TEST_MATCH_ID = "test-match-deadbeef-36";

test.describe("Log page (/log/[matchId])", () => {
  test("sidebar has '0G Storage log' entry with correct text and href", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const logLink = page.locator('[data-testid="sidebar-log"]');
    await expect(logLink).toBeVisible({ timeout: 5000 });
    await expect(logLink).toContainText("0G Storage log");
    await expect(logLink).toContainText("Live match record");

    const href = await logLink.getAttribute("href");
    expect(href).toMatch(/^\/log\//);
  });

  test("log page renders the feed container", async ({ page }) => {
    await page.goto(`/log/${TEST_MATCH_ID}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="log-feed"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test("shows pending empty state when no archive URI is in localStorage", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() =>
      window.localStorage.removeItem("currentMatchArchiveUri"),
    );

    await page.goto(`/log/${TEST_MATCH_ID}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="log-empty"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test("shows 'No active match' when matchId is the no-match sentinel", async ({
    page,
  }) => {
    await page.goto("/log/no-match");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="log-no-match"]'),
    ).toBeVisible({ timeout: 5000 });
  });
});
