// Phase 35: mobile responsiveness regression tests.
//
// Verifies that the app renders correctly at a typical phone viewport
// (375×667 — iPhone SE) without horizontal overflow. Also checks that
// the desktop sidebar is hidden and the mobile bottom nav is shown at
// small widths, with the reverse holding at desktop width.

import { test, expect } from "@playwright/test";

const PHONE = { width: 375, height: 667 };
const DESKTOP = { width: 1280, height: 800 };

test.describe("Mobile responsiveness — home page", () => {
  test("no horizontal scroll at 375px viewport", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1); // 1px tolerance
  });

  test("sidebar hidden on mobile viewport", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toBeHidden();
  });

  test("mobile nav visible on mobile viewport", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const mobileNav = page.locator('[data-testid="mobile-nav"]');
    await expect(mobileNav).toBeVisible({ timeout: 5000 });

    // All three links must be present.
    await expect(page.locator('[data-testid="mobile-nav-home"]')).toBeVisible();
    await expect(page.locator('[data-testid="mobile-nav-play"]')).toBeVisible();
    await expect(page.locator('[data-testid="mobile-nav-expenses"]')).toBeVisible();
  });

  test("sidebar visible and mobile nav hidden at desktop viewport", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    const mobileNav = page.locator('[data-testid="mobile-nav"]');
    await expect(mobileNav).toBeHidden();
  });
});
