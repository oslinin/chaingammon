/**
 * debug-privy-modal.spec.ts — v3
 *
 * Click "Continue with a wallet" and see what wallet options appear.
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

test("debug wallet picker", async ({ page }) => {
  await page.addInitScript({ content: MOCK_ETHEREUM_SCRIPT });
  await page.route("wss://**", () => {});
  await page.route("https://api.drand.sh/**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ round: 1000, randomness: "ab".repeat(32) }) }),
  );

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  // Click login via evaluate
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="login-button"]') as HTMLButtonElement;
    if (btn) btn.click();
  });

  // Wait for modal
  await page.waitForTimeout(3000);

  // Click "Continue with a wallet"
  const continueBtn = page.getByText("Continue with a wallet");
  if (await continueBtn.isVisible()) {
    console.log("Found 'Continue with a wallet' button, clicking...");
    await continueBtn.click();
    await page.waitForTimeout(3000);

    // Dump the modal contents after clicking
    const afterWalletClick = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      return dialogs.map(d => ({
        text: d.innerText,
        buttons: Array.from(d.querySelectorAll("button")).map(b => b.innerText),
        links: Array.from(d.querySelectorAll("a")).map(a => ({ text: a.innerText, href: a.href })),
      }));
    });
    console.log("AFTER WALLET CLICK:", JSON.stringify(afterWalletClick, null, 2));
  } else {
    console.log("'Continue with a wallet' not found");
    // Dump what's visible
    const dialogText = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return d?.innerText;
    });
    console.log("DIALOG TEXT:", dialogText);
  }

  expect(true).toBe(true);
});
