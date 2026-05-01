// Phase 21: ENS name-claim form validation tests.
//
// Renders ClaimForm via the /test-ens-claim fixture page (no wallet / no
// blockchain connection needed) and asserts:
//   - the input + ".backgammon.eth" suffix + Claim button are all visible
//   - the Claim button is disabled when the input is empty
//   - inline validation messages fire for invalid labels
//   - the Claim button becomes enabled for a valid label

import { test, expect } from "@playwright/test";

test.describe("ENS name-claim form", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/test-ens-claim");
    await page.waitForLoadState("networkidle");
  });

  test("renders input, suffix, and Claim button", async ({ page }) => {
    await expect(page.getByTestId("ens-claim-input")).toBeVisible();
    await expect(page.getByTestId("ens-suffix")).toBeVisible();
    await expect(page.getByTestId("ens-suffix")).toHaveText(".backgammon.eth");
    await expect(page.getByTestId("ens-claim-button")).toBeVisible();
  });

  test("Claim button is disabled when input is empty", async ({ page }) => {
    await expect(page.getByTestId("ens-claim-button")).toBeDisabled();
  });

  test("shows validation error for label starting with hyphen", async ({ page }) => {
    await page.getByTestId("ens-claim-input").fill("-bad");
    await expect(page.getByTestId("ens-validation-error")).toBeVisible();
    await expect(page.getByTestId("ens-claim-button")).toBeDisabled();
  });

  test("shows validation error for label ending with hyphen", async ({ page }) => {
    await page.getByTestId("ens-claim-input").fill("bad-");
    await expect(page.getByTestId("ens-validation-error")).toBeVisible();
    await expect(page.getByTestId("ens-claim-button")).toBeDisabled();
  });

  test("shows validation error for label with special characters", async ({
    page,
  }) => {
    await page.getByTestId("ens-claim-input").fill("bad_name");
    await expect(page.getByTestId("ens-validation-error")).toBeVisible();
    await expect(page.getByTestId("ens-claim-button")).toBeDisabled();
  });

  test("auto-lowercases input", async ({ page }) => {
    await page.getByTestId("ens-claim-input").fill("Alice");
    await expect(page.getByTestId("ens-claim-input")).toHaveValue("alice");
  });

  test("enables Claim button for a valid label", async ({ page }) => {
    await page.getByTestId("ens-claim-input").fill("alice");
    await expect(page.getByTestId("ens-validation-error")).not.toBeVisible();
    await expect(page.getByTestId("ens-claim-button")).toBeEnabled();
  });

  test("enables Claim button for a label with hyphens", async ({ page }) => {
    await page.getByTestId("ens-claim-input").fill("alice-bob");
    await expect(page.getByTestId("ens-claim-button")).toBeEnabled();
  });
});
