/**
 * metamask-login.spec.ts
 *
 * Verifies MetaMask login across browsers (Chromium and Firefox) using a
 * mock window.ethereum EIP-1193 provider injected before page load. No real
 * MetaMask extension is needed — wagmi's injected connector calls
 * window.ethereum.request(), which the mock intercepts.
 *
 * The mock provider starts DISCONNECTED (empty _accounts list). When the
 * "Log in" button is clicked wagmi calls eth_requestAccounts; the mock then
 * populates _accounts and emits accountsChanged so wagmi transitions to the
 * connected state.
 *
 * The Sepolia RPC endpoint is intercepted via page.route() so no live node
 * is required. All eth_call / eth_getLogs responses return safe empty values;
 * the tests only assert on wallet connection state, not ENS resolution.
 *
 * Tests:
 *   - login button visible when wallet disconnected (chromium + firefox)
 *   - clicking login connects wallet and shows profile badge (chromium + firefox)
 *   - disconnect button resets UI back to login state (chromium + firefox)
 */

import { test, expect, type Page, type Route } from "@playwright/test";

// ── Mock window.ethereum ───────────────────────────────────────────────────
// EIP-1193 minimal provider.  Starts disconnected; connecting happens when
// eth_requestAccounts is called (simulating the MetaMask approval popup).

const MOCK_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const MOCK_CHAIN_HEX = "0xaa36a7"; // Sepolia (11155111)

const MOCK_ETHEREUM_SCRIPT = `
  (() => {
    if (window.__mockEthereumInstalled) return;
    window.__mockEthereumInstalled = true;
    const handlers = {};
    const provider = {
      isMetaMask: true,
      _accounts: [],
      _chainId: "${MOCK_CHAIN_HEX}",
      async request({ method, params }) {
        if (method === "eth_requestAccounts") {
          // Simulate user clicking "Connect" in MetaMask popup.
          this._accounts = ["${MOCK_ADDRESS}"];
          Promise.resolve().then(() =>
            provider.emit("accountsChanged", this._accounts)
          );
          return this._accounts;
        }
        if (method === "eth_accounts")  return this._accounts;
        if (method === "eth_chainId")   return this._chainId;
        if (method === "net_version")   return "11155111";
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "wallet_addEthereumChain")    return null;
        return null;
      },
      on(event, handler) {
        (handlers[event] = handlers[event] || []).push(handler);
        return this;
      },
      removeListener(event, handler) {
        if (handlers[event])
          handlers[event] = handlers[event].filter(h => h !== handler);
        return this;
      },
      emit(event, ...args) {
        (handlers[event] || []).forEach(h => h(...args));
      },
    };
    window.ethereum = provider;
    // Emit connect so wagmi's reconnect on mount succeeds for a previously
    // stored session. On first visit _accounts is empty so no account is
    // restored — the login button appears.
    Promise.resolve().then(() =>
      provider.emit("connect", { chainId: "${MOCK_CHAIN_HEX}" })
    );
  })();
`;

// ── RPC mock ───────────────────────────────────────────────────────────────
// All Sepolia RPC calls return safe empty/zero values. The tests only check
// wallet connection state, not ENS name resolution or balance reads.

type RpcRequest = { method: string; id: number | string; params?: unknown[] };

function rpcResult(method: string): unknown {
  if (method === "eth_blockNumber")  return "0x5F5E100";
  if (method === "eth_chainId")      return MOCK_CHAIN_HEX;
  if (method === "net_version")      return "11155111";
  if (method === "eth_getBalance")   return "0x0";
  if (method === "eth_getLogs")      return [];
  // eth_call: return 32 zero bytes (safe default for any view call)
  if (method === "eth_call")         return "0x" + "0".repeat(64);
  return null;
}

async function mockRpc(route: Route) {
  const raw = route.request().postDataJSON() as RpcRequest | RpcRequest[];
  const isBatch = Array.isArray(raw);
  const requests: RpcRequest[] = isBatch ? raw : [raw];
  const responses = requests.map(({ method, id }) => ({
    jsonrpc: "2.0",
    id,
    result: rpcResult(method),
  }));
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(isBatch ? responses : responses[0]),
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function injectMockWallet(page: Page) {
  await page.addInitScript({ content: MOCK_ETHEREUM_SCRIPT });
}

async function mockSepoliaRpc(page: Page) {
  // publicnode Sepolia is the default transport; intercept all HTTPS requests
  // to any ethereum-sepolia.publicnode.com path.
  await page.route("https://ethereum-sepolia.publicnode.com/**", mockRpc);
  // Also intercept the root path (some viem versions omit the trailing slash).
  await page.route("https://ethereum-sepolia.publicnode.com", mockRpc);
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe("MetaMask login — injected wallet", () => {
  test.beforeEach(async ({ page }) => {
    await injectMockWallet(page);
    await mockSepoliaRpc(page);
  });

  test("shows login button when wallet is not connected", async ({ page }) => {
    await page.goto("/");
    // The "Log in" button (data-testid="login-button") must be visible in
    // both Chrome and Firefox before any connection attempt.
    const loginBtn = page.getByTestId("login-button");
    await expect(loginBtn).toBeVisible({ timeout: 10_000 });
  });

  test("clicking login button connects wallet and shows profile badge", async ({
    page,
  }) => {
    await page.goto("/");

    // Confirm the login button is present before clicking.
    const loginBtn = page.getByTestId("login-button");
    await expect(loginBtn).toBeVisible({ timeout: 10_000 });

    // Click triggers eth_requestAccounts; the mock approves immediately.
    await loginBtn.click();

    // After wagmi receives the address the profile badge appears.  The badge
    // renders either the shortened address (no ENS name on localhost/mocked
    // chain) or the ENS name itself.
    const badge = page.getByTestId("profile-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });

    // Login button should no longer be visible once connected.
    await expect(loginBtn).not.toBeVisible();
  });

  test("disconnect button returns UI to login state", async ({ page }) => {
    await page.goto("/");

    // Connect first.
    const loginBtn = page.getByTestId("login-button");
    await expect(loginBtn).toBeVisible({ timeout: 20_000 });
    await loginBtn.click();
    await expect(page.getByTestId("profile-badge")).toBeVisible({
      timeout: 20_000,
    });

    // Disconnect.
    await page.getByRole("button", { name: /disconnect/i }).click();

    // Login button should reappear.
    await expect(page.getByTestId("login-button")).toBeVisible({
      timeout: 20_000,
    });
  });

  test("connected address is shown in the profile badge", async ({ page }) => {
    await page.goto("/");

    const loginBtn = page.getByTestId("login-button");
    await expect(loginBtn).toBeVisible({ timeout: 20_000 });
    await loginBtn.click();

    // The badge shows at minimum the shortened address (0x7099…9C8).
    const badge = page.getByTestId("profile-badge");
    await expect(badge).toBeVisible({ timeout: 20_000 });
    // The mock address starts with 0x7099 and ends with 9C8.
    await expect(badge).toContainText(/0x70.{2,4}…/i);
  });
});

test.describe("MetaMask login — no injected wallet (mobile / no extension)", () => {
  // Intentionally do NOT inject window.ethereum — simulates a regular mobile
  // browser or a desktop browser without MetaMask installed.
  test("shows Open in MetaMask deep link", async ({ page }) => {
    await page.goto("/");

    const link = page.getByTestId("open-in-metamask");
    await expect(link).toBeVisible({ timeout: 8_000 });

    const href = await link.getAttribute("href");
    expect(href).toMatch(/^https:\/\/metamask\.app\.link\/dapp\//);
    expect(href).toContain("localhost");
  });
});
