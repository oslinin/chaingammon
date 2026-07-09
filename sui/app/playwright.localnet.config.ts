// playwright.localnet.config.ts — runs ONLY tests/profile_signin.spec.ts,
// against a real local Sui network (see tests/localnet_global_setup.ts).
// Kept separate from playwright.config.ts (the unrated-P2P suite, which
// needs no chain at all) so a missing/slow `sui` CLI never affects that
// suite's own CI job. Run with:
//   pnpm exec playwright test --config playwright.localnet.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "profile_signin.spec.ts",
  globalSetup: "./tests/localnet_global_setup.ts",
  globalTeardown: "./tests/localnet_global_teardown.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: {
    baseURL: "http://localhost:3000",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
      },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
