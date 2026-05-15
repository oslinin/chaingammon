/**
 * wallet_persistence.spec.ts
 *
 * Verifies that a browser-wallet (injected provider / MetaMask-compatible)
 * connection survives client-side navigation and full page refreshes.
 *
 * A lightweight mock window.ethereum is injected before each page load via
 * addInitScript so no real MetaMask extension is required. The mock:
 *   - responds to eth_requestAccounts / eth_accounts with a fixed address
 *   - responds to eth_chainId with Hardhat local (0x7a69 = 31337), which is
 *     always registered in the app's chain registry
 *   - fires the EIP-1193 "connect" event so wagmi's provider listeners fire
 *
 * The connected-state indicator used in assertions is the "Disconnect" button
 * that ConnectButton renders only when isConnected is true.
 */

import { test, expect, type Page } from "@playwright/test";

const MOCK_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // Hardhat account 0
const MOCK_CHAIN_HEX = "0x7a69"; // 31337 decimal — Hardhat local

// ── Mock provider script ───────────────────────────────────────────────────
// Injected before any page script runs. Implements the EIP-1193 subset that
// wagmi's injected connector needs: eth_requestAccounts, eth_accounts,
// eth_chainId, and the event-emitter shape (on / removeListener / emit).

const MOCK_ETHEREUM_SCRIPT = `
  (() => {
    if (window.__mockEthereumInstalled) return;
    window.__mockEthereumInstalled = true;

    const handlers = {};
    const provider = {
      isMetaMask: true,
      _accounts: ["${MOCK_ADDRESS}"],
      _chainId: "${MOCK_CHAIN_HEX}",

      async request({ method }) {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return this._accounts;
          case "eth_chainId":
            return this._chainId;
          case "net_version":
            return "31337";
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          case "eth_blockNumber":
            return "0x1";
          case "eth_getBalance":
            return "0x0";
          default:
            // Return a safe default rather than throw so wagmi's
            // capability-probing calls don't reject the connection.
            return null;
        }
      },

      on(event, handler) {
        (handlers[event] = handlers[event] || []).push(handler);
        return this;
      },
      removeListener(event, handler) {
        if (handlers[event]) {
          handlers[event] = handlers[event].filter(h => h !== handler);
        }
        return this;
      },
      emit(event, ...args) {
        (handlers[event] || []).forEach(h => h(...args));
      },
    };

    window.ethereum = provider;

    // Fire the EIP-1193 "connect" event after the script settles so wagmi's
    // provider listeners that register in the same tick still catch it.
    Promise.resolve().then(() =>
      provider.emit("connect", { chainId: "${MOCK_CHAIN_HEX}" })
    );
  })();
`;

// ── Helpers ────────────────────────────────────────────────────────────────

async function injectMockEthereum(page: Page) {
  await page.addInitScript({ content: MOCK_ETHEREUM_SCRIPT });
}

async function waitForConnected(page: Page) {
  await expect(
    page.getByRole("button", { name: "Disconnect" }),
  ).toBeVisible({ timeout: 8000 });
}

async function waitForDisconnected(page: Page) {
  await expect(
    page.getByRole("button", { name: "Browser wallet" }),
  ).toBeVisible({ timeout: 8000 });
}

async function clickConnect(page: Page) {
  await page.getByRole("button", { name: "Browser wallet" }).click();
  await waitForConnected(page);
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe("wallet connection persistence", () => {
  test.beforeEach(async ({ page }) => {
    await injectMockEthereum(page);
  });

  test("connecting shows Disconnect button and hides Browser wallet", async ({ page }) => {
    await page.goto("/");
    await waitForDisconnected(page);
    await clickConnect(page);

    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Browser wallet" })).not.toBeVisible();
  });

  test("connection survives client-side navigation to create-agent", async ({ page }) => {
    await page.goto("/");
    await clickConnect(page);

    // Client-side navigation (no page reload — wagmi state lives in React memory)
    await page.goto("/create-agent/");
    await page.waitForLoadState("domcontentloaded");

    await waitForConnected(page);
  });

  test("connection is restored after full page refresh", async ({ page }) => {
    await page.goto("/");
    await clickConnect(page);

    // Hard refresh — wagmi must rehydrate from localStorage and call eth_accounts
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    await waitForConnected(page);
  });

  test("connection is restored after navigating directly to create-agent", async ({ page }) => {
    await page.goto("/");
    await clickConnect(page);

    // Simulate: user types /create-agent/ in the address bar (full load, not SPA nav)
    await page.goto("/create-agent/");
    await page.waitForLoadState("domcontentloaded");

    await waitForConnected(page);
  });

  test("disconnecting clears the connection and does not reconnect on reload", async ({ page }) => {
    await page.goto("/");
    await clickConnect(page);

    await page.getByRole("button", { name: "Disconnect" }).click();
    await waitForDisconnected(page);

    // After explicit disconnect, reload should NOT auto-reconnect
    // (wagmi marks the connector as intentionally disconnected)
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    await waitForDisconnected(page);
  });
});
