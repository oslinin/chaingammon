/**
 * mobile_connect.spec.ts
 *
 * With Privy as the auth layer, mobile wallet handling moves inside Privy's
 * modal: when a user on a phone taps "Log in" and chooses MetaMask or
 * WalletConnect, Privy deep-links into the mobile wallet (or shows a QR).
 * The app no longer renders its own "Open in MetaMask" deep link — Privy
 * owns that flow.
 *
 * This test therefore just verifies that the Privy "Log in" entry point
 * renders on a mobile viewport (iPhone 12) without an injected wallet, so a
 * phone user can reach the login options. The wallet selection itself is
 * Privy's responsibility and needs live network access to test end-to-end.
 *
 * NOTE: `test.use()` for a device profile must be top-level (not inside a
 * describe block) because the device's `defaultBrowserType` forces a new
 * worker — Playwright rejects it inside describe().
 */

import { test, expect } from "@playwright/test";
import { devices } from "@playwright/test";

const iPhone = devices["iPhone 12"];

test.use({ ...iPhone });

// Cold compile of a route with Privy's bundle can exceed the 30s default.
const NAV_TIMEOUT = 90_000;

test("mobile: Privy Log in button renders without an injected wallet", async ({ page }) => {
  test.setTimeout(120_000);
  // No mock window.ethereum injected — simulates a regular mobile browser.
  // `domcontentloaded` (not the default "load") because Privy keeps a
  // backend fetch open during init, so the "load" event may never fire.
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

  const loginButton = page.getByTestId("login-button");
  await expect(loginButton).toBeVisible({ timeout: 20_000 });
  await expect(loginButton).toHaveText("Log in");
});

test("mobile: Log in button is present on a deep-linked page", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/help", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

  const loginButton = page.getByTestId("login-button");
  await expect(loginButton).toBeVisible({ timeout: 20_000 });
});
