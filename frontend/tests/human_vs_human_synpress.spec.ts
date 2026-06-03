// human_vs_human_synpress.spec.ts
//
// Full HvH E2E: matchmaking → game → gnubg evaluation → winner verification.
//
// Problem: Playwright's browser.newContext() creates isolated storage
// partitions, so BroadcastChannel / SharedWorker cannot cross between the two
// player contexts.  Real WebRTC UDP is also blocked in headless Chromium on
// this machine.
//
// Solution: replace RTCPeerConnection with a thin mock that routes data-channel
// messages through Playwright's exposeFunction bridge (Node.js → browser →
// Node.js), which works across any two Playwright pages regardless of
// storage partition.
//
// Test flow:
//   1. Start the backend FastAPI server (for /evaluate and /play_to_end).
//   2. Expose cross-page message bridge functions in both contexts.
//   3. Install mock RTCPeerConnection (uses window.__hvhSend for sends,
//      window.__hvhCallOnMessage for receives).
//   4. Mock Ethereum wallets, drand, and Nostr relay.
//   5. Both players click "Play", pair via Nostr, land on /play-human?id=.
//   6. Verify gnubg /evaluate returns candidate moves.
//   7. Verify gnubg /play_to_end returns game_over=true and a winner.
//   8. testMode auto-plays both sides; wait for game-over banner on both pages.
//   9. Assert exactly one player wins.

import { test, expect, type WebSocketRoute, type Page } from "@playwright/test";
import { exec } from "child_process";

// ── Cross-context WebRTC mock ─────────────────────────────────────────────────
//
// Replaces RTCPeerConnection with a mock that uses window.__hvhSend (an
// exposeFunction bridge) to forward data-channel messages to the other page.
// The other page receives via window.__hvhCallOnMessage, which is wired up
// by wireChannel when it sets dc.onmessage.

const MOCK_RTC_SCRIPT = `
(function () {
  if (!window.__HVH_TEST_MODE) return;

  // Receives a data-channel message from the other page.
  // Set automatically by the mock whenever wireChannel() calls dc.onmessage=…
  window.__hvhCallOnMessage = null;

  function makeChannel() {
    var dc = {
      readyState: 'open',
      onopen: null, onclose: null,
      _onmessage: null,
      get onmessage() { return this._onmessage; },
      set onmessage(cb) {
        this._onmessage = cb;
        // Register the receiver so the bridge can deliver inbound messages.
        window.__hvhCallOnMessage = function(data) { cb({ data: data }); };
      },
      send: function(s) {
        // Route outbound messages through the Playwright bridge.
        if (typeof window.__hvhSend === 'function') window.__hvhSend(s);
      },
      close: function() {}
    };
    return dc;
  }

  function MockRTCPC() {
    this._isOfferer = false; this._dc = null; this._dcCb = null;
    this._connectionState = 'new';
  }
  Object.defineProperties(MockRTCPC.prototype, {
    connectionState:         { get: function() { return this._connectionState; } },
    onicecandidate:          { set: function() {}, get: function() { return null; } },
    onconnectionstatechange: { set: function(cb) { this._onCsc = cb; }, get: function() { return this._onCsc; } },
    ondatachannel:           { set: function(cb) { this._dcCb = cb; }, get: function() { return this._dcCb; } },
  });

  MockRTCPC.prototype.createDataChannel = function() {
    this._isOfferer = true;
    var dc = makeChannel();
    dc.readyState = 'connecting'; // not open until setRemoteDescription
    this._dc = dc;
    return dc;
  };

  MockRTCPC.prototype.setLocalDescription = function() { return Promise.resolve(); };

  MockRTCPC.prototype.setRemoteDescription = function() {
    var me = this;
    // Fire 50 ms after signaling — gives the page time to navigate and mount
    // PlayHumanClient, which registers its onState/onMessage callbacks.
    setTimeout(function() {
      if (me._isOfferer) {
        // Received answer → open the offerer's data channel.
        if (me._dc) {
          me._dc.readyState = 'open';
          me._connectionState = 'connected';
          if (me._dc.onopen) me._dc.onopen();
        }
      } else {
        // Received offer → create the answerer's data channel and fire ondatachannel.
        var dc = makeChannel();
        me._connectionState = 'connected';
        if (me._dcCb) me._dcCb({ channel: dc });
        if (dc.onopen) dc.onopen();
      }
    }, 50);
    return Promise.resolve();
  };

  MockRTCPC.prototype.createOffer      = function() { return Promise.resolve({ type: 'offer',  sdp: 'mock-offer'  }); };
  MockRTCPC.prototype.createAnswer     = function() { return Promise.resolve({ type: 'answer', sdp: 'mock-answer' }); };
  MockRTCPC.prototype.addIceCandidate  = function() { return Promise.resolve(); };
  MockRTCPC.prototype.close            = function() { this._connectionState = 'closed'; };

  window.RTCPeerConnection = MockRTCPC;
})();
`;

// ── Cross-context message bridge ──────────────────────────────────────────────
//
// Exposed via page.exposeFunction before any page.goto() calls.
// When page A's mock sends a game message, it calls window.__hvhSend(jsonStr).
// Playwright routes that to this Node.js callback, which calls page.evaluate
// on the OTHER page to deliver the message to window.__hvhCallOnMessage.

let p1SentCount = 0, p2SentCount = 0;
let page2Ref: Page | null = null;

async function setupBridge(page1: Page, page2: Page) {
  await page1.exposeFunction("__hvhSend", async (jsonStr: string) => {
    p1SentCount++;
    if (p1SentCount <= 5 || p1SentCount % 50 === 0) console.log(`bridge p1→p2 #${p1SentCount}:`, jsonStr.slice(0, 80));
    await page2.evaluate((msg: string) => {
      const fn = (window as Window & { __hvhCallOnMessage?: ((s: string) => void) })
        .__hvhCallOnMessage;
      if (fn) fn(msg);
    }, jsonStr);
  });
  await page2.exposeFunction("__hvhSend", async (jsonStr: string) => {
    p2SentCount++;
    if (p2SentCount <= 10) console.log(`bridge p2→p1 #${p2SentCount}:`, jsonStr.slice(0, 80));
    if (p2SentCount === 2) {
      // Roll just sent — check page2's bridge connectivity
      setTimeout(async () => {
        if (!page2Ref) return;
        try {
          // Directly call __hvhSend to verify bridge works
          const testResult = await page2Ref.evaluate(() => {
            const hasSend = typeof (window as any).__hvhSend === "function";
            if (hasSend) {
              (window as any).__hvhSend(JSON.stringify({type: "__test__"}));
            }
            return hasSend;
          });
          console.log("bridge test (p2→p1) works:", testResult, "p2→p1 count will be #" + (p2SentCount + 1));
        } catch (e) {
          console.log("bridge test error:", e);
        }
      }, 1000);
    }
    await page1.evaluate((msg: string) => {
      const fn = (window as Window & { __hvhCallOnMessage?: ((s: string) => void) })
        .__hvhCallOnMessage;
      if (fn) fn(msg);
    }, jsonStr);
  });
}

// ── In-memory Nostr relay (NIP-01 minimal) ────────────────────────────────────

type NostrFilter = { kinds?: number[]; authors?: string[]; "#t"?: string[]; "#p"?: string[] };
type NostrEvent  = { id: string; pubkey: string; kind: number; tags: string[][]; content: string; created_at: number; sig: string };

class InMemoryNostrRelay {
  private clients: { ws: WebSocketRoute; subs: Map<string, NostrFilter[]> }[] = [];
  private seen = new Set<string>();

  addClient(ws: WebSocketRoute): void {
    const subs = new Map<string, NostrFilter[]>();
    this.clients.push({ ws, subs });

    ws.onMessage((raw) => {
      let msg: [string, ...unknown[]];
      try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as [string, ...unknown[]]; }
      catch { return; }
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
          if (this.seen.has(event.id)) { ws.send(JSON.stringify(["OK", event.id, true, "dup"])); return; }
          this.seen.add(event.id);
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
          for (const c of this.clients)
            for (const [subId, filters] of c.subs)
              if (filters.some((f) => this.matches(event, f)))
                c.ws.send(JSON.stringify(["EVENT", subId, event]));
          break;
        }
        case "CLOSE": { subs.delete((args as [string])[0]); break; }
      }
    });
  }

  private matches(ev: NostrEvent, f: NostrFilter): boolean {
    if (f.kinds && !f.kinds.includes(ev.kind)) return false;
    if (f["#t"]) { const ts = ev.tags.filter((t) => t[0] === "t").map((t) => t[1]); if (!f["#t"].some((v) => ts.includes(v))) return false; }
    if (f["#p"]) { const ps = ev.tags.filter((t) => t[0] === "p").map((t) => t[1]); if (!f["#p"].some((v) => ps.includes(v))) return false; }
    return true;
  }
}

// ── Mock Ethereum wallet ──────────────────────────────────────────────────────

function mockEthereumScript(address: string): string {
  return `(() => {
    if (window.__mockEthereumInstalled) return;
    window.__mockEthereumInstalled = true;
    const handlers = {};
    const provider = {
      isMetaMask: true,
      _accounts: ["${address}"],
      async request({ method }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return this._accounts;
        if (method === "eth_chainId") return "0x7a69";
        if (method === "net_version") return "31337";
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "eth_blockNumber") return "0x1";
        if (method === "eth_getBalance") return "0x0";
        return null;
      },
      on(event, handler) { (handlers[event] = handlers[event] || []).push(handler); return this; },
      removeListener(event, handler) { if (handlers[event]) handlers[event] = handlers[event].filter(h => h !== handler); return this; },
      emit(event, ...args) { (handlers[event] || []).forEach(h => h(...args)); },
    };
    window.ethereum = provider;
    Promise.resolve().then(() => provider.emit("connect", { chainId: "0x7a69" }));
  })();`;
}

// ── Backend server lifecycle ──────────────────────────────────────────────────

let backendProcess: ReturnType<typeof exec> | null = null;

test.beforeAll(async () => {
  exec("kill $(lsof -t -i :8000) 2>/dev/null || true");
  await new Promise((r) => setTimeout(r, 500));
  backendProcess = exec("cd ../server && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000");
  await new Promise((r) => setTimeout(r, 5000));
});

test.afterAll(async () => {
  if (backendProcess) backendProcess.kill();
  exec("kill $(lsof -t -i :8000) 2>/dev/null || true");
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Human vs Human - ENS, Turn Sync, and Rules Engine UI Regression", () => {
  // matchmaking (60s) + game play (up to 240s under load) + backend calls + overhead
  test.setTimeout(360_000);

  test(
    "two players match, gnubg evaluator validates moves and winner, game plays to completion",
    async ({ browser }) => {
      const relay = new InMemoryNostrRelay();
      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();

      try {
        // Bridge must be set up before goto() so exposeFunction is available.
        page2Ref = page2;
        await setupBridge(page1, page2);

        // testMode: skip wallet auth and enable move auto-play.
        await page1.addInitScript(() => {
          (window as Window & { __HVH_TEST_MODE?: boolean }).__HVH_TEST_MODE = true;
        });
        await page2.addInitScript(() => {
          (window as Window & { __HVH_TEST_MODE?: boolean }).__HVH_TEST_MODE = true;
        });

        // RTCPeerConnection mock — uses window.__hvhSend (bridge) for cross-context delivery.
        await page1.addInitScript({ content: MOCK_RTC_SCRIPT });
        await page2.addInitScript({ content: MOCK_RTC_SCRIPT });

        // Mock wallets: distinct addresses so side 0/1 are assigned correctly.
        // 0xf39F > 0x7099 → page2 (lower) is side 0 (moves first).
        await page1.addInitScript({ content: mockEthereumScript("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") });
        await page2.addInitScript({ content: mockEthereumScript("0x70997970C51812dc3A010C7d01b50e0d17dc79C8") });

        // Deterministic dice — no drand network required.
        const drandBody = JSON.stringify({ round: 1000, randomness: "ab".repeat(32) });
        await page1.route("https://api.drand.sh/**", (r) => r.fulfill({ contentType: "application/json", body: drandBody }));
        await page2.route("https://api.drand.sh/**", (r) => r.fulfill({ contentType: "application/json", body: drandBody }));

        // In-memory Nostr relay — no live relay network required.
        await page1.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
        await page2.routeWebSocket("wss://**", (ws) => relay.addClient(ws));

        await Promise.all([page1.goto("/"), page2.goto("/")]);

        await Promise.all([
          page1.getByRole("button", { name: "Play" }).click({ timeout: 10_000 }),
          page2.getByRole("button", { name: "Play" }).click({ timeout: 10_000 }),
        ]);

        // Next.js app router may add a trailing slash to the path.
        const isPlayHuman = (url: URL) =>
          /^\/play-human\/?$/.test(url.pathname) && url.searchParams.has("id");
        await Promise.all([
          page1.waitForURL(isPlayHuman, { timeout: 60_000 }),
          page2.waitForURL(isPlayHuman, { timeout: 60_000 }),
        ]);

        // Both pages must land on the same match.
        const id1 = new URL(page1.url()).searchParams.get("id");
        const id2 = new URL(page2.url()).searchParams.get("id");
        expect(id1).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(id1).toBe(id2);

        // 1. gnubg move evaluation — server-side gnubg ranks legal moves.
        const evalResponse = await page1.request.post("http://127.0.0.1:8000/evaluate", {
          data: { position_id: "4HPwATDgc/ABMA", match_id: "cAgAAAAAAAAA", dice: [3, 1] },
        });
        expect(evalResponse.ok()).toBe(true);
        const evalData = await evalResponse.json();
        expect(Array.isArray(evalData.candidates)).toBe(true);
        expect(evalData.candidates.length).toBeGreaterThan(0);
        expect(typeof evalData.candidates[0].move).toBe("string");
        expect(typeof evalData.candidates[0].equity).toBe("number");

        // 2. gnubg play-to-end — gnubg plays a full game and names the winner.
        const playEndResponse = await page1.request.post("http://127.0.0.1:8000/play_to_end", {
          data: { position_id: "4HPwATDgc/ABMA", match_id: "cAgAAAAAAAAA" },
        });
        expect(playEndResponse.ok()).toBe(true);
        const playEndData = await playEndResponse.json();
        expect(playEndData.game_over).toBe(true);
        expect(playEndData.winner).toBeDefined();
        expect([0, 1]).toContain(playEndData.winner);

        // Diagnostic: check phase 5s after matchmaking
        await new Promise((r) => setTimeout(r, 5000));
        const d1 = await page1.evaluate(() => ({
          text: document.querySelector("main")?.innerText?.slice(0, 150) ?? "",
          hasRecv: typeof (window as any).__hvhCallOnMessage === "function",
        }));
        const d2 = await page2.evaluate(() => ({
          text: document.querySelector("main")?.innerText?.slice(0, 150) ?? "",
          hasRecv: typeof (window as any).__hvhCallOnMessage === "function",
        }));
        console.log("P1:", JSON.stringify(d1));
        console.log("P2:", JSON.stringify(d2));


        // 3. testMode drives both sides to completion via auto-play.
        await Promise.all([
          expect(page1.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 240_000 }),
          expect(page2.getByText(/You win!|Opponent wins/)).toBeVisible({ timeout: 240_000 }),
        ]);

        // Exactly one player wins and the other loses.
        const p1Text = await page1.getByText(/You win!|Opponent wins/).textContent();
        const p2Text = await page2.getByText(/You win!|Opponent wins/).textContent();
        expect([p1Text, p2Text].sort()).toEqual(["Opponent wins", "You win!"]);
      } finally {
        await ctx1.close();
        await ctx2.close();
      }
    },
  );
});
