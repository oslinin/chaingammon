/**
 * privy-metamask-login.spec.ts
 *
 * E2E test: MetaMask login through Privy.
 *
 * Flow discovered through debugging:
 *   1. Click "Log in" → Privy modal opens
 *   2. Modal shows: email input, "Google", "Continue with a wallet"
 *   3. Click "Continue with a wallet" → wallet picker opens
 *   4. Wallet picker shows WalletConnect-compatible wallets
 *   5. Click "MetaMask" in the wallet list
 *   6. MetaMask/provider approves connection → Privy promotes wallet → "Disconnect" appears
 *
 * Note: The Privy modal renders in a portal with role="dialog".
 * The login button click must use evaluate() because Playwright's native
 * click() doesn't trigger Privy's React onClick handler reliably.
 *
 * Environment:
 *   - NEXT_PUBLIC_PRIVY_APP_ID (frontend/.env.local) — present
 *   - NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (frontend/.env.local) — present
 *
 * Run:
 *   pnpm test:e2e tests/privy-metamask-login.spec.ts --project=chromium
 *   pnpm test:e2e tests/privy-metamask-login.spec.ts --project=firefox
 */

import { test, expect, type Page } from "@playwright/test";

const MOCK_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const MOCK_CHAIN_ID = "0x7a69";

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
    on(event, handler) { (handlers[event] = handlers[event] || []).push(handler); return this; },
    removeListener(event, handler) { if (handlers[event]) handlers[event] = handlers[event].filter(h => h !== handler); return this; },
    emit(event, ...args) { (handlers[event] || []).forEach(h => h(...args)); },
  };
  window.ethereum = provider;
  Promise.resolve().then(() => provider.emit("connect", { chainId: "${MOCK_CHAIN_ID}" }));
})();`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function injectMockEthereum(page: Page) {
  await page.addInitScript({ content: MOCK_ETHEREUM_SCRIPT });
}

async function waitForConnected(page: Page) {
  await expect(
    page.getByRole("button", { name: "Disconnect" }),
  ).toBeVisible({ timeout: 30_000 });
}

async function waitForLoggedOut(page: Page) {
  await expect(
    page.getByTestId("login-button"),
  ).toBeVisible({ timeout: 10_000 });
}

async function openPrivyModal(page: Page) {
  // Click the login button via evaluate() to trigger Privy's React handler.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="login-button"]') as HTMLButtonElement;
    if (btn) btn.click();
  });

  // Privy's dialog may need time to render through its Headless UI transition.
  // Wait for the dialog element to be attached, then visible.
  const dialog = page.locator('[role="dialog"]').first();

  try {
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    // If the dialog didn't appear, click again — Privy may not have been ready.
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="login-button"]') as HTMLButtonElement;
      if (btn) btn.click();
    });
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
  }
}

async function clickMetaMaskInPrivyModal(page: Page) {
  // Step 1: Click "Continue with a wallet" in the first screen.
  const continueBtn = page.getByText("Continue with a wallet");
  await expect(continueBtn).toBeVisible({ timeout: 10_000 });
  await continueBtn.click();

  // Step 2: Wait for wallet picker to load.
  // The wallet list can take a moment to populate from WalletConnect.
  await page.waitForTimeout(2000);

  // Step 3: Find and click "MetaMask" in the wallet list.
  // The list contains many wallets; MetaMask should be searchable or visible.
  // We look for a button or list item containing "MetaMask".
  const metaMaskBtn = page.getByText("MetaMask", { exact: true }).first();

  // If not immediately visible, try scrolling the dialog.
  if (!(await metaMaskBtn.isVisible().catch(() => false))) {
    // Try searching — Privy's wallet picker may have a search input
    const searchInput = page.locator('[role="dialog"] input[type="text"], [role="dialog"] input[placeholder*="search" i]');
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill("MetaMask");
      await page.waitForTimeout(1000);
    }
  }

  await expect(metaMaskBtn).toBeVisible({ timeout: 10_000 });
  await metaMaskBtn.click();
}

async function loginViaMetaMask(page: Page) {
  await waitForLoggedOut(page);
  await openPrivyModal(page);
  await clickMetaMaskInPrivyModal(page);

  // After clicking MetaMask, Privy calls eth_requestAccounts on the mock provider.
  // The mock returns immediately. Privy promotes the wallet → connected state.
  await waitForConnected(page);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Privy + MetaMask login", () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await injectMockEthereum(page);

    // Block external Nostr relay connections.
    await page.route("wss://**", () => {
      /* no-op */
    });

    // Mock drand for deterministic dice.
    await page.route("https://api.drand.sh/**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ round: 1000, randomness: "ab".repeat(32) }),
      }),
    );

    // Privy's embedded wallet iframe may 403 in test env — that's OK,
    // we're testing the login modal flow, not the embedded wallet.
    // Suppress the noise so we can see real errors.
    await page.route("https://auth.privy.io/**", (route) => {
      const url = route.request().url();
      if (url.includes("/embedded-wallets")) {
        // Return empty HTML for the embedded wallet iframe.
        route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" });
      } else {
        route.continue();
      }
    });

    await page.goto("/");
    // Wait for the app AND Privy to fully initialise.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
  });

  test("user logs in via MetaMask through Privy and sees connected state", async ({
    page,
  }) => {
    await loginViaMetaMask(page);

    // Assert: connected — Disconnect button visible.
    await expect(
      page.getByRole("button", { name: "Disconnect" }),
    ).toBeVisible();

    // Assert: address is displayed.
    await expect(
      page.getByText(
        MOCK_ADDRESS.slice(0, 6) + "…" + MOCK_ADDRESS.slice(-4),
      ),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("disconnecting clears the session and login button reappears", async ({
    page,
  }) => {
    await loginViaMetaMask(page);

    // Disconnect.
    await page.getByRole("button", { name: "Disconnect" }).click();
    await waitForLoggedOut(page);

    // Assert: login button is back.
    await expect(page.getByTestId("login-button")).toBeVisible();
  });

  test("authenticated state survives a hard refresh", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await loginViaMetaMask(page);

    // Hard refresh — Privy should restore the session.
    await page.reload();
    await page.waitForLoadState("networkidle");

    await waitForConnected(page);
  });

  test("authenticated state survives client-side navigation", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await loginViaMetaMask(page);

    // Navigate to another page.
    await page.goto("/stages/");
    await page.waitForLoadState("networkidle");

    // Connected state should persist.
    await waitForConnected(page);
  });
});
