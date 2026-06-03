/**
 * privy-metamask-login.spec.ts
 *
 * Login / onboarding tests across browsers and platforms:
 *   - Desktop Chrome (chromium project) + Desktop Firefox (firefox project)
 *   - Mobile Chrome / Mobile Firefox emulation via test.use()
 *   - Auth methods: email, Google OAuth, MetaMask
 *
 * MetaMask mobile strategy
 * ──────────────────────────────────────────────────────────────────────────
 * Chrome Android and Firefox mobile do not inject window.ethereum.
 * When no injected wallet is detected on a mobile user-agent, the app shows:
 *
 *   <a href="https://metamask.app.link/dapp/<host><pathname>">Open in MetaMask</a>
 *
 * Tapping it opens the current page inside MetaMask Mobile's built-in browser,
 * where window.ethereum IS injected natively. The user then clicks
 * "MetaMask (Basic)" and connects directly — no WalletConnect project ID,
 * no QR scan, works on both Chrome Android and Firefox mobile.
 *
 * When window.ethereum IS present on mobile (i.e. the user is already inside
 * MetaMask Mobile's browser) the regular "MetaMask (Basic)" injected flow
 * is shown instead of the deep link.
 *
 * Run:
 *   pnpm test:e2e tests/privy-metamask-login.spec.ts --project=chromium
 *   pnpm test:e2e tests/privy-metamask-login.spec.ts --project=firefox
 */

import { test, expect, type Page } from "@playwright/test";

const MOCK_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const MOCK_CHAIN_ID = "0x7a69";

// Mobile user-agent strings for emulation.
// Our isMobile detection reads navigator.userAgent, so setting these via
// test.use({ userAgent }) is sufficient — no isMobile:true required.
const MOBILE_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36";
const MOBILE_FIREFOX_UA =
  "Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/109.0 Firefox/118.0";

// ── Mock Ethereum provider ─────────────────────────────────────────────────────

const MOCK_ETHEREUM_SCRIPT = `(() => {
  if (window.__mockEthereumInstalled) return;
  window.__mockEthereumInstalled = true;
  const handlers = {};
  const accounts = ["${MOCK_ADDRESS}"];
  const provider = {
    isMetaMask: true,
    async request({ method }) {
      switch (method) {
        case "eth_requestAccounts":
          this.emit("accountsChanged", accounts);
          return accounts;
        case "eth_accounts": return accounts;
        case "eth_chainId": return "${MOCK_CHAIN_ID}";
        case "net_version": return "31337";
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": return null;
        case "eth_blockNumber": return "0x1";
        case "eth_getBalance": return "0x0";
        case "eth_call": return "0x";
        case "eth_estimateGas": return "0x5208";
        default: return null;
      }
    },
    on(event, handler) {
      (handlers[event] = handlers[event] || []).push(handler);
      return this;
    },
    removeListener(event, handler) {
      if (handlers[event]) handlers[event] = handlers[event].filter(h => h !== handler);
      return this;
    },
    emit(event, ...args) { (handlers[event] || []).forEach(h => h(...args)); },
  };
  window.ethereum = provider;
  Promise.resolve().then(() => provider.emit("connect", { chainId: "${MOCK_CHAIN_ID}" }));
})();`;

async function injectMockEthereum(page: Page) {
  await page.addInitScript({ content: MOCK_ETHEREUM_SCRIPT });
}

// ── Page setup ─────────────────────────────────────────────────────────────────

async function setupPage(page: Page) {
  await page.route("wss://**", () => { /* suppress external WebSocket noise */ });
  await page.route("https://api.drand.sh/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ round: 1000, randomness: "ab".repeat(32) }),
    }),
  );
  // Privy's embedded-wallet iframe may 403 in test env; suppress the noise.
  await page.route("https://auth.privy.io/**", (route) => {
    if (route.request().url().includes("/embedded-wallets")) {
      route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" });
    } else {
      route.continue();
    }
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000);
}

// ── State assertions ───────────────────────────────────────────────────────────

async function waitForConnected(page: Page) {
  await expect(
    page.getByRole("button", { name: "Disconnect" }),
  ).toBeVisible({ timeout: 30_000 });
}

async function waitForLoggedOut(page: Page) {
  await expect(page.getByTestId("login-button")).toBeVisible({ timeout: 10_000 });
}

// ── Modal helpers ──────────────────────────────────────────────────────────────

async function openPrivyModal(page: Page) {
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="login-button"]') as HTMLButtonElement;
    if (btn) btn.click();
  });
  const dialog = page.locator('[role="dialog"]').first();
  try {
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    // Privy may not have been ready on first click — retry once.
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      (document.querySelector('[data-testid="login-button"]') as HTMLButtonElement)?.click();
    });
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
  }
}

async function loginViaMetaMask(page: Page) {
  await waitForLoggedOut(page);
  await openPrivyModal(page);

  const continueBtn = page.getByText("Continue with a wallet");
  await expect(continueBtn).toBeVisible({ timeout: 10_000 });
  await continueBtn.click();
  await page.waitForTimeout(2000);

  const metaMaskBtn = page.getByText("MetaMask", { exact: true }).first();
  if (!(await metaMaskBtn.isVisible().catch(() => false))) {
    const searchInput = page.locator(
      '[role="dialog"] input[type="text"], [role="dialog"] input[placeholder*="search" i]',
    );
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill("MetaMask");
      await page.waitForTimeout(1000);
    }
  }
  await expect(metaMaskBtn).toBeVisible({ timeout: 10_000 });
  await metaMaskBtn.click();
  await waitForConnected(page);
}

// ── 1. Privy modal appearance ──────────────────────────────────────────────────

test.describe("Privy login modal - desktop", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("shows email input", async ({ page }) => {
    await openPrivyModal(page);
    const dialog = page.locator('[role="dialog"]').first();
    await expect(
      dialog
        .locator('input[type="email"], input[placeholder*="email" i]')
        .or(dialog.getByText(/continue with email/i))
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("shows Google login option", async ({ page }) => {
    await openPrivyModal(page);
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog.getByText(/google/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("shows Continue with a wallet option", async ({ page }) => {
    await openPrivyModal(page);
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog.getByText(/continue with a wallet/i)).toBeVisible({ timeout: 10_000 });
  });
});

// ── 2. Email login UI ──────────────────────────────────────────────────────────

test.describe("Email login UI", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("entering an email transitions to OTP entry", async ({ page }) => {
    await openPrivyModal(page);
    const dialog = page.locator('[role="dialog"]').first();

    const emailInput = dialog
      .locator('input[type="email"], input[placeholder*="email" i]')
      .first();
    await expect(emailInput).toBeVisible({ timeout: 10_000 });
    await emailInput.fill("test@example.com");

    const submitBtn = dialog
      .locator('button[type="submit"]')
      .or(dialog.getByRole("button", { name: /continue|send|next/i }))
      .first();
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
    await submitBtn.click();

    // Privy moves to OTP entry — look for a numeric code input or the
    // "check your email" confirmation message.
    await expect(
      dialog
        .locator('input[inputmode="numeric"], input[type="text"][maxlength="6"]')
        .or(dialog.getByText(/check your email|enter.*code|verification code/i))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});

// ── 3. Google login UI ─────────────────────────────────────────────────────────

test.describe("Google login UI", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("Google button is visible in Privy modal", async ({ page }) => {
    await openPrivyModal(page);
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog.getByText(/google/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("Google button is interactive (no crash on click)", async ({ page }) => {
    await openPrivyModal(page);
    const dialog = page.locator('[role="dialog"]').first();
    const googleBtn = dialog.getByText(/google/i).first();
    await expect(googleBtn).toBeVisible({ timeout: 10_000 });
    // Click without asserting redirect — Privy handles OAuth via popup or
    // in-page navigation depending on the app ID configuration.
    await googleBtn.click();
    await page.waitForTimeout(1000);
    // Verify the page hasn't crashed (login button or disconnect is reachable)
    const loginOrDisconnect = page
      .getByTestId("login-button")
      .or(page.getByRole("button", { name: "Disconnect" }));
    // Either state is fine — we just confirm the app still renders
    await loginOrDisconnect.first().waitFor({ state: "attached", timeout: 5_000 });
  });
});

// ── 4. MetaMask desktop ────────────────────────────────────────────────────────

test.describe("MetaMask desktop (window.ethereum)", () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await injectMockEthereum(page);
    await setupPage(page);
  });

  test("MetaMask Basic button is visible on desktop", async ({ page }) => {
    await waitForLoggedOut(page);
    await expect(page.getByTestId("metamask-basic")).toBeVisible();
  });

  test("Open in MetaMask deep link is absent on desktop", async ({ page }) => {
    await waitForLoggedOut(page);
    await expect(page.getByTestId("open-in-metamask")).not.toBeVisible();
  });

  test("connects via injected MetaMask through Privy modal", async ({ page }) => {
    await loginViaMetaMask(page);
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await expect(
      page.getByText(MOCK_ADDRESS.slice(0, 6) + "…" + MOCK_ADDRESS.slice(-4)),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("disconnect returns to logged-out state", async ({ page }) => {
    await loginViaMetaMask(page);
    await page.getByRole("button", { name: "Disconnect" }).click();
    await waitForLoggedOut(page);
  });

  test("session persists across hard refresh", async ({ page }) => {
    await loginViaMetaMask(page);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await waitForConnected(page);
  });

  test("session persists across client-side navigation", async ({ page }) => {
    await loginViaMetaMask(page);
    await page.goto("/stages/");
    await page.waitForLoadState("networkidle");
    await waitForConnected(page);
  });
});

// ── 5. MetaMask mobile — Chrome Android UA (no injected wallet) ───────────────
//
// Simulates Chrome on Android: navigator.userAgent matches the mobile regex
// but window.ethereum is absent.  The app should show the deep link instead
// of the "MetaMask (Basic)" injected-connector button.

test.describe("MetaMask mobile - Chrome Android UA (no window.ethereum)", () => {
  test.setTimeout(60_000);
  test.use({
    viewport: { width: 393, height: 851 },
    userAgent: MOBILE_CHROME_UA,
    hasTouch: true,
  });

  test.beforeEach(async ({ page }) => {
    // No injectMockEthereum — simulates Chrome Android without MetaMask
    await setupPage(page);
  });

  test("shows Open in MetaMask link instead of MetaMask Basic", async ({ page }) => {
    await waitForLoggedOut(page);
    await expect(page.getByTestId("open-in-metamask")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("metamask-basic")).not.toBeVisible();
  });

  test("Open in MetaMask href points to metamask.app.link/dapp/", async ({ page }) => {
    await waitForLoggedOut(page);
    const link = page.getByTestId("open-in-metamask");
    await expect(link).toBeVisible({ timeout: 10_000 });
    const href = await link.getAttribute("href");
    expect(href).toContain("metamask.app.link/dapp/");
    expect(href).toContain("localhost:3000");
  });

  test("Privy modal still shows email and Google options on mobile", async ({ page }) => {
    await waitForLoggedOut(page);
    await openPrivyModal(page);
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog.getByText(/google/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(
      dialog
        .locator('input[type="email"], input[placeholder*="email" i]')
        .or(dialog.getByText(/continue with email/i))
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ── 6. MetaMask mobile — Firefox Android UA (no injected wallet) ──────────────
//
// Simulates Firefox on Android: navigator.userAgent matches mobile regex,
// no window.ethereum (Firefox doesn't have MetaMask extension on Android).
// Same deep-link fallback should appear.

test.describe("MetaMask mobile - Firefox Android UA (no window.ethereum)", () => {
  test.setTimeout(60_000);
  test.use({
    viewport: { width: 393, height: 851 },
    userAgent: MOBILE_FIREFOX_UA,
    // hasTouch intentionally omitted — Firefox mobile support may vary
  });

  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("shows Open in MetaMask link instead of MetaMask Basic", async ({ page }) => {
    await waitForLoggedOut(page);
    await expect(page.getByTestId("open-in-metamask")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("metamask-basic")).not.toBeVisible();
  });

  test("Open in MetaMask href points to metamask.app.link/dapp/", async ({ page }) => {
    await waitForLoggedOut(page);
    const link = page.getByTestId("open-in-metamask");
    await expect(link).toBeVisible({ timeout: 10_000 });
    const href = await link.getAttribute("href");
    expect(href).toContain("metamask.app.link/dapp/");
    expect(href).toContain("localhost:3000");
  });
});

// ── 7. MetaMask mobile — in MetaMask's in-app browser ─────────────────────────
//
// Simulates being inside MetaMask Mobile's built-in browser: mobile UA but
// window.ethereum IS present (MetaMask injects it).  The app should show
// the normal "MetaMask (Basic)" button, not the deep link.

test.describe("MetaMask mobile in-app browser (window.ethereum injected on mobile)", () => {
  test.setTimeout(120_000);
  test.use({
    viewport: { width: 393, height: 851 },
    userAgent: MOBILE_CHROME_UA,
    hasTouch: true,
  });

  test.beforeEach(async ({ page }) => {
    // MetaMask Mobile's browser injects window.ethereum — simulate it.
    await injectMockEthereum(page);
    await setupPage(page);
  });

  test("shows MetaMask Basic (not deep link) when ethereum is injected on mobile", async ({
    page,
  }) => {
    await waitForLoggedOut(page);
    await expect(page.getByTestId("metamask-basic")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("open-in-metamask")).not.toBeVisible();
  });

  test("connects via injected MetaMask when in MetaMask Mobile browser", async ({ page }) => {
    await loginViaMetaMask(page);
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  });
});
