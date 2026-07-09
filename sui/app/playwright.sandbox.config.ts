// Sandbox-only Playwright config: identical to playwright.config.ts but
// launches the pre-installed Chromium at /opt/pw-browsers/chromium instead of
// downloading the browser build pinned by @playwright/test (network-blocked
// in the CI sandbox). Run with:
//   pnpm exec playwright test --config playwright.sandbox.config.ts …
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  retries: 1,
  use: {
    baseURL: "http://localhost:3000",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
        launchOptions: { executablePath: "/opt/pw-browsers/chromium" },
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
