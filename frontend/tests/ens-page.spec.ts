// Phase 36: Playwright tests for /ens/[matchId] — ENS text record viewer.
//
// Verifies:
//   1. The sidebar "ENS updates" entry is visible and links to the ENS route.
//   2. The ENS page renders the text-records shell container.
//   3. The pre-settlement pending banner is visible when no wallet is connected.
//   4. "No active match" message appears when the route uses the no-match sentinel.
//
// No wallet or backend connection is required — the pending state renders
// client-side without RPC calls when no wallet is connected.

import { test, expect } from "@playwright/test";

const TEST_MATCH_ID = "test-match-deadbeef-36";

test.describe("ENS page (/ens/[matchId])", () => {
  test("sidebar has 'ENS updates' entry with correct text and href", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const ensLink = page.locator('[data-testid="sidebar-ens"]');
    await expect(ensLink).toBeVisible({ timeout: 5000 });
    await expect(ensLink).toContainText("ENS updates");
    await expect(ensLink).toContainText("Reputation writes");

    const href = await ensLink.getAttribute("href");
    expect(href).toMatch(/^\/ens\//);
  });

  test("ENS page renders the records shell container", async ({ page }) => {
    await page.goto(`/ens/${TEST_MATCH_ID}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="ens-records"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test("shows pending banner when no wallet is connected", async ({ page }) => {
    await page.goto(`/ens/${TEST_MATCH_ID}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="ens-pending"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test("shows 'No active match' when matchId is the no-match sentinel", async ({
    page,
  }) => {
    await page.goto("/ens/no-match");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="ens-no-match"]'),
    ).toBeVisible({ timeout: 5000 });
  });
});
