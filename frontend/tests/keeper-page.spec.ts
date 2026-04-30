// Phase 36: Playwright tests for /keeper/[matchId] — KeeperHub workflow steps.
//
// Verifies:
//   1. The sidebar "KeeperHub steps" entry is visible and links to the keeper route.
//   2. The keeper page renders a step-list container with the expected testid.
//   3. At least one step row renders with a testid following the keeper-step-* pattern.
//   4. "No active match" message appears when the route uses the no-match sentinel.
//
// The keeper page calls the server's /keeper-workflow/{matchId} mock endpoint.
// When the server is not running, the page shows an error state — the step list
// container is still present so the DOM shape assertion passes.

import { test, expect } from "@playwright/test";

const TEST_MATCH_ID = "test-match-deadbeef-36";

test.describe("Keeper page (/keeper/[matchId])", () => {
  test("sidebar has 'KeeperHub steps' entry with correct text and href", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const keeperLink = page.locator('[data-testid="sidebar-keeper"]');
    await expect(keeperLink).toBeVisible({ timeout: 5000 });
    await expect(keeperLink).toContainText("KeeperHub steps");
    await expect(keeperLink).toContainText("Workflow + escrow");

    const href = await keeperLink.getAttribute("href");
    expect(href).toMatch(/^\/keeper\//);
  });

  test("keeper page renders the steps container", async ({ page }) => {
    await page.goto(`/keeper/${TEST_MATCH_ID}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="keeper-steps"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test("keeper page renders at least one step row when server responds", async ({
    page,
  }) => {
    // The mock endpoint at /keeper-workflow/{matchId} is expected to run during
    // the test suite (the dev server starts the Next.js app; the FastAPI server
    // must be up separately for this assertion to pass). If the server is not
    // running, the page falls back to an error state and this test is skipped.
    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";
    let serverUp = false;
    try {
      const res = await page.request.get(`${serverUrl}/keeper-workflow/${TEST_MATCH_ID}`);
      serverUp = res.ok();
    } catch {
      // server not running — skip the step-row check
    }
    if (!serverUp) {
      test.skip();
      return;
    }

    await page.goto(`/keeper/${TEST_MATCH_ID}`);
    await page.waitForLoadState("networkidle");

    const firstStep = page.locator('[data-testid^="keeper-step-"]').first();
    await expect(firstStep).toBeVisible({ timeout: 8000 });
  });

  test("shows 'No active match' when matchId is the no-match sentinel", async ({
    page,
  }) => {
    await page.goto("/keeper/no-match");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="keeper-no-match"]'),
    ).toBeVisible({ timeout: 5000 });
  });
});
