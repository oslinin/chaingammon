// Phase 65: homepage discover-subnet button — toggle behaviour.
//
// Tests run against the live homepage (localhost:3000). No blockchain
// connection is needed because the button and subtitle are static HTML;
// the expanded DiscoveryList is not asserted on (it needs a chain).
import { test, expect } from "@playwright/test";

test.describe("Discover subnet section", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("button is visible and labelled correctly when collapsed", async ({
    page,
  }) => {
    const btn = page.getByTestId("discover-subnet-button");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText("Discover Chaingammon subnet →");
  });

  test("ENS subtitle *.chaingammon.eth is always visible", async ({ page }) => {
    await expect(page.getByTestId("discover-ens-subtitle")).toBeVisible();
  });

  test("discovery description is hidden before clicking", async ({ page }) => {
    await expect(
      page.getByTestId("discover-expanded-description"),
    ).not.toBeVisible();
  });

  test("clicking button expands the subnet list", async ({ page }) => {
    await page.getByTestId("discover-subnet-button").click();
    await expect(
      page.getByTestId("discover-expanded-description"),
    ).toBeVisible();
    await expect(page.getByTestId("discover-subnet-button")).toHaveText(
      "Hide subnet ↑",
    );
  });

  test("clicking button again collapses the list", async ({ page }) => {
    await page.getByTestId("discover-subnet-button").click();
    await page.getByTestId("discover-subnet-button").click();
    await expect(
      page.getByTestId("discover-expanded-description"),
    ).not.toBeVisible();
    await expect(page.getByTestId("discover-subnet-button")).toHaveText(
      "Discover Chaingammon subnet →",
    );
  });
});
