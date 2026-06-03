// human_vs_human.spec.ts — E2E test for the Nostr + WebRTC matchmaking flow.
//
// Spins up two browser contexts ("player A" and "player B"), intercepts all
// Nostr relay WebSocket connections with an in-memory relay implemented here,
// and verifies that both players pair and navigate to the same
// /play-human/{matchId} URL after clicking "Play a human".
//
// No live Nostr relay or internet access is required.
// WebRTC runs natively between the two browser contexts (same Chromium process,
// loopback ICE candidates, so no STUN server is needed either).
//
// Timing budget: STABILIZE_MS (3 s) + WebRTC handshake (~3–5 s) + buffer.
// Total timeout per waitForURL: 30 s.

import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";

// ── Minimal in-memory Nostr relay ──────────────────────────────────────────
//
// Implements just enough of NIP-01 to relay ephemeral presence (kind 20100)
// and signal (kind 20101) events between the two browser contexts:
//   REQ  → store subscription, reply EOSE (no persisted events)
//   EVENT → acknowledge OK, broadcast to matching subscriptions
//   CLOSE → remove subscription
//
// Event IDs are deduplicated so the duplicate publications that nostr-tools
// SimplePool sends to multiple relay connections don't fire duplicate messages
// to subscribers.

type NostrFilter = {
  kinds?: number[];
  authors?: string[];
  "#t"?: string[];
  "#p"?: string[];
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
  private clients: { ws: WebSocketRoute; subs: Map<string, NostrFilter[]> }[] =
    [];
  private seen = new Set<string>();

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

  private matchesAny(event: NostrEvent, filters: NostrFilter[]): boolean {
    return filters.some((f) => this.matches(event, f));
  }

  private matches(event: NostrEvent, f: NostrFilter): boolean {
    if (f.kinds && !f.kinds.includes(event.kind)) return false;
    if (f.authors && !f.authors.includes(event.pubkey)) return false;
    if (f["#t"]) {
      const ts = event.tags.filter((t) => t[0] === "t").map((t) => t[1]);
      if (!f["#t"].some((v) => ts.includes(v))) return false;
    }
    if (f["#p"]) {
      const ps = event.tags.filter((t) => t[0] === "p").map((t) => t[1]);
      if (!f["#p"].some((v) => ps.includes(v))) return false;
    }
    return true;
  }
}

// ── Cross-context WebRTC mock ─────────────────────────────────────────────
//
// Native WebRTC UDP is blocked in headless Chromium on this machine.
// Replaces RTCPeerConnection with a mock that routes data-channel messages
// through Playwright's exposeFunction bridge.

const MOCK_RTC_SCRIPT = `
(function () {
  if (!window.__HVH_TEST_MODE) return;
  window.__hvhCallOnMessage = null;
  function makeChannel() {
    var dc = {
      readyState: 'open', onopen: null, onclose: null, _onmessage: null,
      get onmessage() { return this._onmessage; },
      set onmessage(cb) {
        this._onmessage = cb;
        window.__hvhCallOnMessage = function(data) { cb({ data: data }); };
      },
      send: function(s) { if (typeof window.__hvhSend === 'function') window.__hvhSend(s); },
      close: function() {}
    };
    return dc;
  }
  function MockRTCPC() {
    this._isOfferer = false; this._dc = null; this._dcCb = null; this._connectionState = 'new';
  }
  Object.defineProperties(MockRTCPC.prototype, {
    connectionState:         { get: function() { return this._connectionState; } },
    onicecandidate:          { set: function() {}, get: function() { return null; } },
    onconnectionstatechange: { set: function(cb) { this._onCsc = cb; }, get: function() { return this._onCsc; } },
    ondatachannel:           { set: function(cb) { this._dcCb = cb; }, get: function() { return this._dcCb; } },
  });
  MockRTCPC.prototype.createDataChannel = function() {
    this._isOfferer = true; var dc = makeChannel(); dc.readyState = 'connecting'; this._dc = dc; return dc;
  };
  MockRTCPC.prototype.setLocalDescription = function() { return Promise.resolve(); };
  MockRTCPC.prototype.setRemoteDescription = function() {
    var me = this;
    setTimeout(function() {
      if (me._isOfferer) {
        if (me._dc) { me._dc.readyState = 'open'; me._connectionState = 'connected'; if (me._dc.onopen) me._dc.onopen(); }
      } else {
        var dc = makeChannel(); me._connectionState = 'connected';
        if (me._dcCb) me._dcCb({ channel: dc });
        if (dc.onopen) dc.onopen();
      }
    }, 50);
    return Promise.resolve();
  };
  MockRTCPC.prototype.createOffer     = function() { return Promise.resolve({ type: 'offer',  sdp: 'mock-offer'  }); };
  MockRTCPC.prototype.createAnswer    = function() { return Promise.resolve({ type: 'answer', sdp: 'mock-answer' }); };
  MockRTCPC.prototype.addIceCandidate = function() { return Promise.resolve(); };
  MockRTCPC.prototype.close           = function() { this._connectionState = 'closed'; };
  window.RTCPeerConnection = MockRTCPC;
})();
`;

async function setupRtcBridge(page1: Page, page2: Page) {
  await page1.exposeFunction("__hvhSend", async (jsonStr: string) => {
    await page2.evaluate((msg: string) => {
      const fn = (window as Window & { __hvhCallOnMessage?: (s: string) => void }).__hvhCallOnMessage;
      if (fn) fn(msg);
    }, jsonStr);
  });
  await page2.exposeFunction("__hvhSend", async (jsonStr: string) => {
    await page1.evaluate((msg: string) => {
      const fn = (window as Window & { __hvhCallOnMessage?: (s: string) => void }).__hvhCallOnMessage;
      if (fn) fn(msg);
    }, jsonStr);
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe("human-vs-human matchmaking", () => {
  test(
    "two players pair via Nostr and land on the same play-human match",
    async ({ browser }) => {
      test.setTimeout(90_000);
      const relay = new InMemoryNostrRelay();

      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();

      try {
        // Bridge + mock must be set up before goto() so exposeFunction is ready.
        await setupRtcBridge(page1, page2);
        await page1.addInitScript(() => { (window as Window & {__HVH_TEST_MODE?:boolean}).__HVH_TEST_MODE = true; });
        await page2.addInitScript(() => { (window as Window & {__HVH_TEST_MODE?:boolean}).__HVH_TEST_MODE = true; });
        await page1.addInitScript({ content: MOCK_RTC_SCRIPT });
        await page2.addInitScript({ content: MOCK_RTC_SCRIPT });

        // Intercept ALL wss:// connections on both pages and route them
        // through the in-memory relay so no live Nostr network is needed.
        await page1.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
        await page2.routeWebSocket("wss://**", (ws) => relay.addClient(ws));

        // Load the home page on both contexts.
        // AppModeContext defaults to "elo" → EloHome renders, which has
        // a "Play" button that starts Nostr matchmaking.
        await Promise.all([page1.goto("/"), page2.goto("/")]);

        // Both players click the button.
        await Promise.all([
          page1.getByRole("button", { name: "Play" }).click({ timeout: 10_000 }),
          page2.getByRole("button", { name: "Play" }).click({ timeout: 10_000 }),
        ]);

        // UI should flip to "Searching…" on both sides (the button label
        // changes; clicking it again would stop the search).
        await expect(
          page1.getByRole("button", { name: "Searching…" }),
        ).toBeVisible({ timeout: 5_000 });
        await expect(
          page2.getByRole("button", { name: "Searching…" }),
        ).toBeVisible({ timeout: 5_000 });

        // Timing budget:
        //   startPresence re-publishes every 15 s. If one player's initial
        //   publish races ahead of the other's subscription setup, they won't
        //   see each other until the 15 s re-publish (~t=20 s for pairing,
        //   ~t=25 s for navigation). Allow 60 s to cover the worst-case path.
        //
        // matchId moved from path segment to query param (?id=) in commit
        // 09501b1 to fix 404s on GitHub Pages.  The predicate form of
        // waitForURL handles query strings correctly; the glob `**/play-human/**`
        // does not.
        await Promise.all([
          page1.waitForURL(
            (url) => /^\/play-human\/?$/.test(url.pathname) && url.searchParams.has("id"),
            { timeout: 60_000 },
          ),
          page2.waitForURL(
            (url) => /^\/play-human\/?$/.test(url.pathname) && url.searchParams.has("id"),
            { timeout: 60_000 },
          ),
        ]);

        // matchId is keccak256(sorted(pubkeyA + pubkeyB)) — deterministic and
        // identical on both sides.
        const matchId1 = new URL(page1.url()).searchParams.get("id");
        const matchId2 = new URL(page2.url()).searchParams.get("id");
        expect(matchId1).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(matchId1).toBe(matchId2);
      } finally {
        await ctx1.close();
        await ctx2.close();
      }
    },
  );

  test("single player stays in searching state rather than immediately falling back to agent", async ({
    browser,
  }) => {
    // Regression: previously tryConnect navigated to /team-demo on the very
    // first attempt even when no partner had arrived yet (Nostr race).
    // Now it must show a "Searching…" status and only fall back after GIVE_UP_MS.
    const relay = new InMemoryNostrRelay();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await page.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
      await page.goto("/");
      await page.getByRole("button", { name: "Play" }).click({ timeout: 10_000 });

      // After STABILIZE_MS the button label changes to "Searching…" while
      // tryConnect waits for a partner — no navigation yet.
      await expect(
        page.getByRole("button", { name: "Searching…" }),
      ).toBeVisible({ timeout: 8_000 });
      expect(new URL(page.url()).pathname).toBe("/");

      // Clicking "Searching…" stops the search and restores the "Play" button.
      await page.getByRole("button", { name: "Searching…" }).click();
      await expect(
        page.getByRole("button", { name: "Play" }),
      ).toBeVisible({ timeout: 3_000 });
    } finally {
      await ctx.close();
    }
  });
});
