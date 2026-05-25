// board-landscape.spec.ts
//
// Verifies that the team-demo game layout flips to a horizontal (board left,
// advisor panel right) arrangement when the device is in landscape orientation
// — even on phone-sized viewports below the desktop `lg` breakpoint.
//
// The mechanism under test is pure CSS: Tailwind's `landscape:max-lg:flex-row`
// modifier stacked on the main page wrapper in app/team-demo/page.tsx. No JS
// orientation hook is involved.
//
// Layout matrix being pinned:
//   - landscape + viewport < 1024px  → flex-direction: row     (new behavior)
//   - portrait  + viewport < 1024px  → flex-direction: column  (existing)
//   - landscape + viewport ≥ 1024px  → flex-direction: row     (existing lg)
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

  test("board and advisor panel sit side-by-side", async ({ page }) => {
    await mockAgentList(page);
    await page.goto("/team-demo?opponents=1");

    // Wait for the game screen to render (header is unique to it).
    await expect(
      page.locator("h1", { hasText: "Off-chain game" })
    ).toBeVisible({ timeout: 10_000 });

    // The game-screen <main> is the only one carrying `max-w-5xl`.
    const main = page.locator("main.max-w-5xl");
    await expect(main).toHaveCSS("flex-direction", "row");
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
