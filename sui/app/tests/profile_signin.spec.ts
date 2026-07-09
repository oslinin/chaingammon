// profile_signin.spec.ts — Task 5 Step 4: AUTH_MODE=mock sign-in creates a
// HumanProfile on a real local Sui network and the app renders its ELO.
//
// Requires localnet: see tests/localnet_global_setup.ts, which starts `sui
// start --with-faucet --force-regenesis`, publishes the chaingammon
// package, and writes public/localnet-config.json. When the `sui` CLI
// isn't on PATH (this sandbox has none — see sui/README.md), globalSetup
// no-ops and this test skips itself below rather than failing the suite.
// CI's dedicated job for this spec (.github/workflows/sui-ci.yml) installs
// the CLI first, so it actually runs there.
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

const CONFIG_PATH = path.join(__dirname, "..", "public", "localnet-config.json");

test.beforeAll(() => {
  test.skip(!existsSync(CONFIG_PATH), "no `sui` CLI / localnet available in this environment (see localnet_global_setup.ts)");
});

test("mock sign-in creates a HumanProfile on localnet and renders its ELO", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText(/ELO 1500/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/guest-0x/)).toBeVisible();

  // Reloading should reuse the same persisted mock identity and profile —
  // same address, same ELO — rather than creating a second profile.
  // SignInPanel auto-signs-in when a mock identity is already in
  // localStorage, so no button click is needed here; if the app instead
  // tried to create a second profile for the same address,
  // profile::create_profile's EProfileAlreadyExists abort would surface as
  // an error banner instead of the ELO line reappearing.
  await page.reload();
  await expect(page.getByText(/ELO 1500/)).toBeVisible({ timeout: 30_000 });
});
