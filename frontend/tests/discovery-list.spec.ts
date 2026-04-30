// Phase 31: discovery list — unified view of humans and agents from
// PlayerSubnameRegistrar.
//
// Uses the /test-discovery fixture page which renders hardcoded mock entries
// (1 human + 2 agents) so no blockchain connection is needed.

import { test, expect } from "@playwright/test";

test.describe("Discovery list", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/test-discovery");
    await page.waitForLoadState("networkidle");
  });

  test("separate headers for humans and agents are rendered", async ({ page }) => {
    await expect(page.getByTestId("discovery-humans-header")).toBeVisible();
    await expect(page.getByTestId("discovery-agents-header")).toBeVisible();
  });

  test("exactly one Play button is shown (only gnubg-1 has an endpoint)", async ({
    page,
  }) => {
    const playButtons = page.getByTestId("discovery-play-button");
    await expect(playButtons).toHaveCount(1);
  });

  test("agents section contains at least one discovery entry", async ({ page }) => {
    const agentsSection = page.getByTestId("discovery-agents-section");
    await expect(agentsSection).toBeVisible();
    const entries = agentsSection.getByTestId("discovery-entry");
    await expect(entries.first()).toBeVisible();
  });

  test("players section contains at least one discovery entry", async ({ page }) => {
    const humansSection = page.getByTestId("discovery-humans-section");
    await expect(humansSection).toBeVisible();
    const entries = humansSection.getByTestId("discovery-entry");
    await expect(entries.first()).toBeVisible();
  });

  test("humans section has zero Play buttons", async ({ page }) => {
    const humansSection = page.getByTestId("discovery-humans-section");
    const playButtons = humansSection.getByTestId("discovery-play-button");
    await expect(playButtons).toHaveCount(0);
  });
});
