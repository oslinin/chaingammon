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

    // Headers hidden in landscape, so wait on the landscape-only advisor toggle.
    const toggle = page.getByTestId("advisor-toggle-landscape");
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    // Global layout header (Chain·Gammon brand bar) and MobileNav bottom bar
    // are both hidden so the board can fill the viewport. Scope to the global
    // header via the sticky-positioned <header> in app/layout.tsx; the
    // team-demo page header is scoped via main header.
    await expect(page.locator("body > div header").first()).toBeHidden();
    await expect(page.locator("main header")).toBeHidden();
    await expect(page.getByTestId("mobile-nav")).toBeHidden();

    // Fullscreen toggle is also rendered alongside the advisor toggle.
    await expect(page.getByTestId("fullscreen-toggle-landscape")).toBeVisible();

    // Advisor panel is hidden by default. The panel is the element wrapping
    // the AgentTeammatePanel; its drag handle has `title="Drag to move panel"`.
    const panel = page.locator("[title='Drag to move panel']").locator("..");
    await expect(panel).toBeHidden();

    // Tapping the toggle reveals the panel as a fixed overlay.
    // dispatchEvent bypasses the Next.js dev-mode portal at this position.
    await toggle.dispatchEvent("click");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("position", "fixed");

    // Tapping again hides it.
    await toggle.dispatchEvent("click");
    await expect(panel).toBeHidden();
  });

  test("move cycler previews gnubg-ranked turns and commits on confirm", async ({ page }) => {
    await mockAgentList(page);
    await page.goto("/team-demo?opponents=1");

    // Wait for the game to render (advisor toggle is the landscape canary).
    await expect(page.getByTestId("advisor-toggle-landscape")).toBeVisible({ timeout: 10_000 });

    // The cycler needs the ONNX evaluator to have produced candidates for the
    // first ply. The model ships in /public/backgammon_net.onnx and is
    // warmed up at app startup, so this is the expected path.
    const cycler = page.getByTestId("move-cycler-landscape");
    await expect(cycler).toBeVisible({ timeout: 30_000 });

    const prev = page.getByTestId("move-cycler-prev");
    const next = page.getByTestId("move-cycler-next");
    const confirm = page.getByTestId("move-cycler-confirm");
    const label = page.getByTestId("move-cycler-label");
    await expect(prev).toBeVisible();
    await expect(next).toBeVisible();
    await expect(confirm).toBeVisible();

    // Label shape: <TagBadge> <equity> <i/total>[ · best]
    await expect(label).toContainText(/(Safe|Aggressive|Priming|Anchor|Blitz)/);
    await expect(label).toContainText("/");
    await expect(label).toContainText(/[+-]?\d\.\d{3}/);
    await expect(label).toContainText("best");

    // Cycling to the next candidate updates the label.
    const firstText = await label.innerText();
    await next.click();
    await expect(label).not.toHaveText(firstText, { timeout: 5_000 });

    // Opening the advisor overlay hides the cycler; closing restores it.
    // dispatchEvent bypasses the Next.js dev-mode portal that intercepts
    // pointer events at this viewport position after the ONNX evaluator fires.
    const toggle = page.getByTestId("advisor-toggle-landscape");
    await toggle.dispatchEvent("click");
    await expect(cycler).toBeHidden();
    await toggle.dispatchEvent("click");
    await expect(cycler).toBeVisible();

    // ✓ commits the previewed turn → human ply ends → cycler hides
    // (either the agent is now on roll, advisorDisabled flips true, or the
    // page is transiently in a loading state). Either way, cycler should
    // disappear within a few seconds.
    await confirm.click();
    await expect(cycler).toBeHidden({ timeout: 15_000 });
  });
});

test.describe("game layout — phone portrait", () => {
  const { defaultBrowserType: _2, ...iphone } = devices["iPhone 12"];
  test.use(iphone);

  test("layout stays stacked and shows player status cards", async ({ page }) => {
    await mockAgentList(page);
    await page.goto("/team-demo?opponents=1");

    await expect(
      page.locator("h1", { hasText: "Off-chain game" })
    ).toBeVisible({ timeout: 10_000 });

    const main = page.locator("main.max-w-5xl");
    await expect(main).toHaveCSS("flex-direction", "column");

    // Player status cards render above the board in portrait + desktop.
    await expect(page.getByTestId("player-card-0")).toBeVisible();
    await expect(page.getByTestId("player-card-1")).toBeVisible();
    await expect(page.getByTestId("player-card-0")).toContainText("You");
    await expect(page.getByTestId("player-card-1")).toContainText("Agent #1");
  });
});
