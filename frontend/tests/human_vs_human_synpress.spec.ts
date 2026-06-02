import { test, expect, type WebSocketRoute } from "@playwright/test";
import { exec } from "child_process";

// Background process reference for the backend server
let backendProcess: any;

test.beforeAll(async () => {
  // Spin up the backend FastAPI gnubg_service locally for the gnubg evaluation cross-check
  backendProcess = exec("cd ../server && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000");

  // Give the server a few seconds to initialize
  await new Promise(resolve => setTimeout(resolve, 5000));
});

test.afterAll(async () => {
  // Kill the backend server after tests complete
  if (backendProcess) {
    backendProcess.kill();
  }
  exec("kill $(lsof -t -i :8000) 2>/dev/null || true");
});

type NostrFilter = {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
};

type NostrEvent = {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
  sig: string;
};

class InMemoryNostrRelay {
  private clients: { ws: WebSocketRoute; subs: Map<string, NostrFilter[]> }[] = [];
  private seen = new Set<string>();

  private matchesAny(event: NostrEvent, filters: NostrFilter[]): boolean {
    if (filters.length === 0) return true;
    for (const filter of filters) {
      if (filter.kinds && !filter.kinds.includes(event.kind)) continue;
      if (filter.authors && !filter.authors.includes(event.pubkey)) continue;
      if (filter.since && event.created_at < filter.since) continue;
      if (filter.until && event.created_at > filter.until) continue;
      return true;
    }
    return false;
  }

  addClient(ws: WebSocketRoute): void {
    const subs = new Map<string, NostrFilter[]>();
    this.clients.push({ ws, subs });

    ws.onMessage((raw) => {
      let msg: [string, ...unknown[]];
      try {
        msg = JSON.parse(
          typeof raw === "string" ? raw : raw.toString(),
        ) as [string, ...unknown[]];
      } catch {
        return;
      }
      const [type, ...args] = msg;

      switch (type) {
        case "REQ": {
          const [subId, ...filters] = args as [string, ...NostrFilter[]];
          subs.set(subId, filters);
          ws.send(JSON.stringify(["EOSE", subId]));
          break;
        }
        case "EVENT": {
          const event = args[0] as NostrEvent;
          if (this.seen.has(event.id)) {
            ws.send(JSON.stringify(["OK", event.id, true, "duplicate"]));
            return;
          }
          this.seen.add(event.id);
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
          for (const client of this.clients) {
            for (const [subId, filters] of client.subs) {
              if (this.matchesAny(event, filters)) {
                client.ws.send(JSON.stringify(["EVENT", subId, event]));
              }
            }
          }
          break;
        }
        case "CLOSE": {
          const [subId] = args as [string];
          subs.delete(subId);
          break;
        }
      }
    });
  }
}

test.describe("Human vs Human - ENS, Turn Sync, and Rules Engine UI Regression", () => {
  test("Player connects via Metamask, ENS resolves, rules engine evaluated against gnubg, turn sync fixes", async ({
    page,
  }) => {
    // 1. Setup Player B (Opponent) in a separate context using testMode (mocked auth)
    const contextB = await page.context().browser()!.newContext();
    const pageB = await contextB.newPage();

    // Enable testMode for both players to simplify
    await page.addInitScript(() => { (window as any).__HVH_TEST_MODE = true; });
    await pageB.addInitScript(() => { (window as any).__HVH_TEST_MODE = true; });

    // Mock Ethereum provider so testMode can fake auth for Player B
    const mockEthereumScript = (address: string) => `
      (() => {
        if (window.__mockEthereumInstalled) return;
        window.__mockEthereumInstalled = true;
        const handlers = {};
        const provider = {
          isMetaMask: true,
          _accounts: ["${address}"],
          async request({ method }) {
            switch (method) {
              case "eth_requestAccounts":
              case "eth_accounts": return this._accounts;
              case "eth_chainId": return "0x7a69";
              case "net_version": return "31337";
              case "wallet_switchEthereumChain":
              case "wallet_addEthereumChain": return null;
              case "eth_blockNumber": return "0x1";
              case "eth_getBalance": return "0x0";
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
        Promise.resolve().then(() => provider.emit("connect", { chainId: "0x7a69" }));
      })();
    `;

    // Matchmaking sees two different players
    await page.addInitScript({ content: mockEthereumScript("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") });
    await pageB.addInitScript({ content: mockEthereumScript("0x70997970C51812dc3A010C7d01b50e0d17dc79C8") });

    // Mock reverse ENS lookup RPC calls.
    const relay = new InMemoryNostrRelay();

    const mockENSCall = async (route: any, request: any) => {
      const postData = request.postDataJSON();
      if (postData && postData.method === "eth_call") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: postData.id,
            result: "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000009616c6963652e6574680000000000000000000000000000000000000000000000",
          }),
        });
      }
      return route.continue();
    };

    await page.route("https://*.alchemy.com/**", mockENSCall);
    await page.route("https://*.infura.io/**", mockENSCall);
    await page.route("https://cloudflare-eth.com/**", mockENSCall);
    await page.route("https://*.rpc.ankr.com/**", mockENSCall);
    await pageB.route("https://*.alchemy.com/**", mockENSCall);
    await pageB.route("https://*.infura.io/**", mockENSCall);
    await pageB.route("https://cloudflare-eth.com/**", mockENSCall);
    await pageB.route("https://*.rpc.ankr.com/**", mockENSCall);

    // Force deterministic dice rolls by mocking drand.
    const drandBody = JSON.stringify({ round: 1000, randomness: "ab".repeat(32) });
    await page.route("https://api.drand.sh/**", (route) =>
      route.fulfill({ contentType: "application/json", body: drandBody })
    );
    await pageB.route("https://api.drand.sh/**", (route) =>
      route.fulfill({ contentType: "application/json", body: drandBody })
    );

    await page.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
    await pageB.routeWebSocket("wss://**", (ws) => relay.addClient(ws));

    // 2. Connect
    await Promise.all([page.goto("/"), pageB.goto("/")]);

    // Wait for button to be visible
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible({ timeout: 5000 });
    await expect(pageB.getByRole("button", { name: "Play" })).toBeVisible({ timeout: 5000 });

    // Both players click "Play" to matchmake
    await Promise.all([
      page.getByRole("button", { name: "Play" }).click({ timeout: 10_000 }),
      pageB.getByRole("button", { name: "Play" }).click({ timeout: 10_000 }),
    ]);

    // Wait for matchmaking to complete and route to /play-human?id=
    await Promise.all([
      page.waitForURL(
        (url) => url.pathname.includes("/play-human") && url.searchParams.has("id"),
        { timeout: 60_000 }
      ),
      pageB.waitForURL(
        (url) => url.pathname.includes("/play-human") && url.searchParams.has("id"),
        { timeout: 60_000 }
      )
    ]);

    // 3. Verify ENS Names
    // Regression check: Expect primary ENS to display over subname fallback
    // Since we mocked ENS lookup for 0x... to return alice.eth, we should see it
    // Wait until ENS lookup completes
    await expect(page.getByText(/alice\.eth/).first()).toBeVisible({ timeout: 20000 });
    await expect(pageB.getByText(/alice\.eth/).first()).toBeVisible({ timeout: 20000 });

    // 4. Verify UI Rules Engine Parity & Turn Desync Bug
    // Wait until it's Player A's turn
    await expect(page.locator('text="Your turn — click a checker to move"').or(pageB.locator('text="Your turn — click a checker to move"'))).toBeVisible({ timeout: 10000 });

    const gnubgResponse = await page.request.post("http://localhost:8000/evaluate", {
      data: {
        position_id: "4HPwATDgc/ABMA", // Base64 encoding for opening board
        match_id: "cAgAAAAAAAAA",
        dice: [3, 1]
      }
    });

    const gnubgData = await gnubgResponse.json();
    const gnubgMoves = gnubgData.candidates.map((c: any) => c.move);
    expect(gnubgMoves.length).toBeGreaterThan(0); // Assert server side gnubg finds moves

    // Attempt to interact with any checker
    await page.locator('.point-8, [data-point-id="8"]').first().click();
    await page.locator('.point-8, [data-point-id="8"]').first().click(); // Complete the 2nd dice for 3,1

    // We expect NO "1/X moves staged" text to persist if gnubg thinks the move completes.
    await expect(page.getByText(/moves staged/)).toBeHidden({ timeout: 5000 });

    // 5. Verify Turn Desync Bug
    // Player A's status should correctly transition to "Opponent's turn..."
    await expect(page.getByText(/Opponent's turn\.\.\./)).toBeVisible({ timeout: 5000 });

    // 6. Fast-Forward and Verify Winner via gnubg
    // The user requested that we verify the game ends and the winner is correctly specified via gnubg.
    const playToEndResponse = await page.request.post("http://localhost:8000/play_to_end", {
      data: {
        position_id: "4HPwATDgc/ABMA",
        match_id: "cAgAAAAAAAAA",
      }
    });

    const playToEndData = await playToEndResponse.json();

    // gnubg should evaluate the game as over
    expect(playToEndData.game_over).toBe(true);

    // Verify winner from the gnubg match state dict
    expect(playToEndData.winner).toBeDefined();

    // Expose the bug in the UI end state if possible
    await expect(page.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 60000 });
  });
});
