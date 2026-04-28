// Network dropdown — visual + interaction regression coverage.
//
// Strategy:
//   - The presentational `NetworkDropdownView` is exercised on a fixture
//     page (`/test-network-dropdown`) that renders three controlled
//     variants. No wallet, no wagmi state — pure props.
//   - The wagmi-aware `NetworkDropdown` is exercised by visiting the
//     home page disconnected and asserting the trigger does NOT render.
//     A connected-state e2e would require a wallet stub (Synpress / mock
//     connector); the existing test fixtures don't have one. The view's
//     fixture-page coverage stands in for the rendering side, and the
//     real e2e proves the wrapper renders nothing when disconnected.
//
// Fixture variants (selected via ?variant= query param):
//   ?variant=active     → on 0G Galileo Testnet (chainId 16602)
//   ?variant=wrong      → on mainnet (chainId 1, NOT in registry)
//   ?variant=switching  → switching pending

import { test, expect } from "@playwright/test";

test.describe("NetworkDropdownView (fixture page)", () => {
  test("active variant: shows current chain name and lists selectable chains", async ({ page }) => {
    await page.goto("/test-network-dropdown?variant=active");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByTestId("network-dropdown-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("0G Galileo Testnet");

    // Open the menu.
    await trigger.click();
    const menu = page.getByTestId("network-dropdown-menu");
    await expect(menu).toBeVisible();

    // Three rows in dev mode (0G, Sepolia, Localhost).
    const rows = menu.getByRole("menuitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("0G Galileo Testnet");
    await expect(rows.nth(1)).toContainText("Sepolia");
    await expect(rows.nth(2)).toContainText("Hardhat Localhost");

    // Active row marked.
    await expect(rows.nth(0)).toHaveAttribute("data-active", "true");
    await expect(rows.nth(1)).toHaveAttribute("data-active", "false");
  });

  test("wrong variant: shows 'Wrong network' label", async ({ page }) => {
    await page.goto("/test-network-dropdown?variant=wrong");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByTestId("network-dropdown-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("Wrong network");
  });

  test("switching variant: shows pending state and disables trigger", async ({ page }) => {
    await page.goto("/test-network-dropdown?variant=switching");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByTestId("network-dropdown-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("Switching");
    await expect(trigger).toBeDisabled();
  });

  test("clicking a non-active row records onSwitch with the right chain id", async ({ page }) => {
    await page.goto("/test-network-dropdown?variant=active");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("network-dropdown-trigger").click();
    await page.getByRole("menuitem", { name: /Sepolia/ }).click();

    // The fixture page renders the last-clicked chain id into a
    // <pre data-testid="last-switch">…</pre> for the test to read.
    await expect(page.getByTestId("last-switch")).toHaveText("11155111");
  });

  test("Escape closes the menu", async ({ page }) => {
    await page.goto("/test-network-dropdown?variant=active");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("network-dropdown-trigger").click();
    await expect(page.getByTestId("network-dropdown-menu")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("network-dropdown-menu")).toHaveCount(0);
  });
});

test.describe("NetworkDropdown (wagmi-aware wrapper)", () => {
  test("home page: dropdown is not rendered when disconnected", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The Connect button is visible (no wallet → "Install MetaMask"
    // or "Connect wallet" depending on injection state). The dropdown
    // is gated on isConnected so it must not appear.
    await expect(page.getByTestId("network-dropdown-trigger")).toHaveCount(0);
  });
});
