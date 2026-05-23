/**
 * wallet_persistence.spec.ts
 *
 * Auth is now driven by Privy (see app/ConnectButton.tsx + app/providers.tsx).
 * The single "Log in" pill is the entry point to Privy's modal, which offers
 * email, Google, MetaMask (injected), and WalletConnect. Privy owns the
 * connector list; wagmi's `useAccount()` reflects whatever wallet the user
 * authenticates with.
 *
 * These tests verify the auth entry point renders and survives navigation +
 * reload. They do NOT drive a full login: Privy's modal needs a valid
 * NEXT_PUBLIC_PRIVY_APP_ID and live network access to Privy's backend, which
 * the offline test sandbox cannot provide. The connected/disconnected states
 * (network dropdown, profile badge) are exercised by the components that
 * consume `useAccount()` elsewhere; here we lock in that the login button is
 * always reachable (the regression we care about: the auth UI must not vanish
 * when Privy is still initialising).
 *
 * The login button is identified by its data-testid="login-button" (set in
 * ConnectButton). It renders both server-side and client-side, independent of
 * Privy's async `ready` flag.
 *
 * Navigations use `waitUntil: "domcontentloaded"` (not the default "load")
 * because Privy keeps a backend fetch open during init, so the "load" event
 * may never fire in the offline sandbox.
 */

import { test, expect, type Page } from "@playwright/test";

// The dev server compiles each route on first access; with Privy's bundle a
// cold compile of a secondary route can exceed Playwright's 30s default. Give
// navigations a generous budget so a first-hit compile doesn't flake the run.
const NAV_TIMEOUT = 90_000;

async function gotoAndWait(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await expect(page.getByTestId("login-button")).toBeVisible({ timeout: 20_000 });
}

test.describe("Privy auth entry point", () => {
  test.setTimeout(120_000);

  test("home page shows the Log in button", async ({ page }) => {
    await gotoAndWait(page, "/");
    await expect(page.getByTestId("login-button")).toHaveText("Log in");
  });

  test("login button survives client-side navigation to create-agent", async ({ page }) => {
    await gotoAndWait(page, "/");
    await gotoAndWait(page, "/create-agent/");
  });

  test("login button is restored after a full page refresh", async ({ page }) => {
    await gotoAndWait(page, "/");
    await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await expect(page.getByTestId("login-button")).toBeVisible({ timeout: 20_000 });
  });

  test("login button is present after navigating directly to create-agent", async ({ page }) => {
    // Simulate typing /create-agent/ in the address bar (full load, not SPA nav).
    await gotoAndWait(page, "/create-agent/");
  });
});
