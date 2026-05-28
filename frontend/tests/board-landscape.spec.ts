// board-landscape.spec.ts
//
// Verifies the team-demo game layout in mobile landscape: the board fills the
// screen (header hidden, padding removed) and the advisor panel is hidden by
// default but reachable via a floating toggle that opens it as a fixed
// overlay. Portrait stays stacked.
//
// Mechanism: pure CSS via Tailwind's `landscape:max-lg:` variant, plus one
// piece of React state (`showPanelInLandscape`) to flip the panel between
// hidden and fixed-overlay when the toggle is tapped.
//
// Like game-flow.spec.ts we use `?opponents=1` so the page skips the agent-
// picker setup screen and renders the game `<main>` immediately. The agents
// fetch is mocked because no backend server is running in tests.

import { test, expect, devices, type Page } from "@playwright/test";

async function mockAgentList(page: Page): Promise<void> {
  await page.route("http://localhost:8000/agents", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { agent_id: 1, weights_hash: "0xabc", match_count: 0, tier: 1 },
      ]),
    })
  );
}

test.describe("game layout — phone landscape", () => {
  const { defaultBrowserType: _1, ...iphoneLandscape } = devices["iPhone 12 landscape"];
  test.use(iphoneLandscape);

  test("board takes the whole screen; advisor panel is a toggleable overlay", async ({ page }) => {
    await mockAgentList(page);
    await page.goto("/team-demo?opponents=1");

    // The header is hidden in landscape, so wait on the landscape-only toggle.
    const toggle = page.getByTestId("advisor-toggle-landscape");
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    // Page header is hidden — gives the board the full viewport height.
    await expect(page.locator("header")).not.toBeVisible();

    // Advisor panel is hidden by default. The panel is the element wrapping
    // the AgentTeammatePanel; its drag handle has `title="Drag to move panel"`.
    const panel = page.locator("[title='Drag to move panel']").locator("..");
    await expect(panel).toBeHidden();

    // Tapping the toggle reveals the panel as a fixed overlay.
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("position", "fixed");

    // Tapping again hides it.
    await toggle.click();
    await expect(panel).toBeHidden();
  });
});

test.describe("game layout — phone portrait", () => {
  const { defaultBrowserType: _2, ...iphone } = devices["iPhone 12"];
  test.use(iphone);

  test("layout stays stacked", async ({ page }) => {
    await mockAgentList(page);
    await page.goto("/team-demo?opponents=1");

    await expect(
      page.locator("h1", { hasText: "Off-chain game" })
    ).toBeVisible({ timeout: 10_000 });

    const main = page.locator("main.max-w-5xl");
    await expect(main).toHaveCSS("flex-direction", "column");
  });
});
