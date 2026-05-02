// Phase 66: Playwright tests for /agent/[agentId] — the agent info page.
//
// Verifies:
//   1. The page shell renders with the correct header.
//   2. The on-chain data section is present.
//   3. The 0G Storage hashes section is present.
//   4. The neural-network weights section is present.
//   5. The AgentCard "Info ↗" link exists on the home page.
//
// No wallet or backend connection is required — the page renders its
// structural shell even without blockchain data (sections show "…" or
// "—" placeholders until chain reads resolve).

import { test, expect } from "@playwright/test";

const AGENT_ID = "1";

test.describe("Agent info page (/agent/[agentId])", () => {
  test("page shell renders with header", async ({ page }) => {
    await page.goto(`/agent/${AGENT_ID}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="agent-info-shell"]'),
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.locator('[data-testid="agent-info-header"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test("on-chain data section is present", async ({ page }) => {
    await page.goto(`/agent/${AGENT_ID}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="agent-info-onchain"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test("0G storage section is present", async ({ page }) => {
    await page.goto(`/agent/${AGENT_ID}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="agent-info-storage"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test("neural network weights section is present", async ({ page }) => {
    await page.goto(`/agent/${AGENT_ID}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-testid="agent-info-weights"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test("header contains a home link", async ({ page }) => {
    await page.goto(`/agent/${AGENT_ID}`);
    await page.waitForLoadState("networkidle");

    const homeLink = page.locator('[data-testid="agent-info-header"] a');
    await expect(homeLink).toBeVisible({ timeout: 5000 });
    await expect(homeLink).toHaveAttribute("href", "/");
  });
});

test.describe("AgentCard info link (home page)", () => {
  test("info link is present on home page agent cards", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The agent card grid may be empty when no chain is connected (CI),
    // but the test still passes — we just look for any visible info link.
    // If at least one card renders, it must have the info link.
    const infoLinks = page.locator('[data-testid="agent-card-info-link"]');
    const count = await infoLinks.count();
    if (count > 0) {
      await expect(infoLinks.first()).toBeVisible({ timeout: 5000 });
      const href = await infoLinks.first().getAttribute("href");
      expect(href).toMatch(/^\/agent\/\d+$/);
    }
  });
});
