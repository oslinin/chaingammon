// Phase 28: sidebar regression coverage.
//
// Asserts that the global sidebar renders on the home page with both
// required navigation entries, and that clicking "Create new agent"
// reveals the inline creation form.
//
// The sidebar is a client component that uses wagmi hooks — all reads
// degrade gracefully when no wallet is connected, so these tests run
// without MetaMask.

import { test, expect } from "@playwright/test";

test.describe("Sidebar", () => {
  test("renders both navigation entries on the home page", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    // Entry 1: "Play with agent"
    const playLink = page.locator('[data-testid="sidebar-play"]');
    await expect(playLink).toBeVisible({ timeout: 5000 });
    await expect(playLink).toContainText("Play with agent");

    // Entry 2: "Create new agent"
    const createButton = page.locator('[data-testid="sidebar-create-agent"]');
    await expect(createButton).toBeVisible({ timeout: 5000 });
    await expect(createButton).toContainText("Create new agent");
  });

  test("clicking Create new agent reveals the inline form", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Form must not be visible before the toggle.
    const form = page.locator('[data-testid="create-agent-form"]');
    await expect(form).not.toBeVisible();

    // Click the toggle button.
    await page.locator('[data-testid="sidebar-create-agent"]').click();

    // Form should now be visible with label input, tier select, and submit.
    await expect(form).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="agent-label-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="agent-tier-select"]')).toBeVisible();
    await expect(page.locator('[data-testid="create-agent-submit"]')).toBeVisible();
  });

  test("Play with agent link points to /match route", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const playLink = page.locator('[data-testid="sidebar-play"]');
    await expect(playLink).toBeVisible({ timeout: 5000 });

    const href = await playLink.getAttribute("href");
    expect(href).toMatch(/^\/match\?agentId=/);
  });
});
