/**
 * mobile_connect.spec.ts
 *
 * Verifies that on a mobile browser without window.ethereum (i.e. no injected
 * MetaMask extension), ConnectButton renders an "Open in MetaMask" deep link
 * whose href uses the metamask.app.link/dapp/ scheme.
 *
 * MetaMask Mobile does not inject window.ethereum in a regular mobile browser
 * (Chrome/Safari on iOS or Android) — it only does so inside its own in-app
 * browser. The deep link sends the user there, where the normal "Browser
 * wallet" flow then works.
 *
 * We use a Playwright mobile viewport + user-agent (iPhone 12) and
 * deliberately do NOT inject a mock window.ethereum so the injected connector
 * is absent, triggering the mobile-fallback branch in ConnectButton.
 */

import { test, expect } from "@playwright/test";
import { devices } from "@playwright/test";

const { defaultBrowserType: _dbt, ...iPhone } = devices["iPhone 12"];

test.describe("mobile connect — no injected wallet", () => {
  test.use({ ...iPhone });

  test('shows "Open in MetaMask" deep link on mobile without window.ethereum', async ({
    page,
  }) => {
    // No mock ethereum injected — simulates a regular mobile browser.
    await page.goto("/");

    const link = page.getByTestId("open-in-metamask");
    await expect(link).toBeVisible({ timeout: 8000 });

    const href = await link.getAttribute("href");
    expect(href).toMatch(/^https:\/\/metamask\.app\.link\/dapp\//);
    // href must include the current hostname
    expect(href).toContain("localhost");
  });

  test("deep link href contains the current path", async ({ page }) => {
    await page.goto("/help");

    const link = page.getByTestId("open-in-metamask");
    await expect(link).toBeVisible({ timeout: 8000 });

    const href = await link.getAttribute("href");
    expect(href).toContain("/help");
  });
});
