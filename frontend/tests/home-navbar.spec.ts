// Home-page navbar regression coverage.
//
// History (2026-04-28): the network-dropdown spec asserted only that the
// dropdown was ABSENT on the disconnected home page — a vacuous test that
// passed even when the entire <ConnectButton> failed to render (for
// example, when the SSR/client trees disagreed and React hydration
// silently dropped the click handler, or when a `mounted` guard never
// flipped to true).
//
// This spec adds a POSITIVE assertion: the navbar must contain at least
// one of the three legitimate connect-state UIs. If <ConnectButton>
// disappears entirely, this test fails immediately.
//
// We use `toBeVisible` (with a real timeout) rather than `toHaveCount > 0`
// because the SSR pass renders <ConnectButton> as null until the client
// `useEffect` flips `mounted`. `networkidle` can resolve before that
// effect runs; `toBeVisible` reliably waits it out.

import { test, expect } from "@playwright/test";

test.describe("Home-page navbar", () => {
  test("renders one of: Install MetaMask / Connect wallet / ProfileBadge", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Match either of the three UI states. data-testid is the cleanest
    // hook for ProfileBadge (it has multiple internal branches — loading,
    // claim form, named); for the two text-driven states we match the
    // visible label so a future refactor that swaps button → link or
    // adjusts class names does not break the test.
    const states = page
      .locator('[data-testid="profile-badge"]')
      .or(page.getByRole("button", { name: "Connect wallet" }))
      .or(page.getByRole("link", { name: "Install MetaMask" }));

    await expect(states.first()).toBeVisible({ timeout: 5000 });
  });
});
