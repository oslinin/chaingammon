// hvh_test_utils.ts — shared harness for unrated-play Playwright tests.
//
// Adapted from frontend/tests/hvh_test_utils.ts for this standalone app:
//   - No wallet mock (this app has no wallet at all — identity is a Nostr
//     keypair generated in the browser).
//   - No drand mock (dice are commit-reveal, exchanged entirely over the
//     mocked WebRTC bridge below — no external network call to fake).
//   - Matchmaking still needs the RTC mock + in-memory Nostr relay for the
//     same reason as the original: Playwright's newContext() isolates
//     storage per page, and headless CI has no real WebRTC/UDP path.
//
// Problem: Playwright's browser.newContext() creates isolated storage
// partitions, so BroadcastChannel / SharedWorker cannot cross between the two
// player contexts. Real WebRTC UDP is also blocked in headless Chromium on
// CI machines.
//
// Solution: replace RTCPeerConnection with a thin mock that routes data-channel
// messages through Playwright's exposeFunction bridge (Node.js → browser →
// Node.js), which works across any two Playwright pages regardless of
// storage partition. Matchmaking runs against an in-memory Nostr relay so no
// external network is needed.

import { expect, type WebSocketRoute, type Page, type Browser, type BrowserContext } from "@playwright/test";

// ── Cross-context WebRTC mock (identical mechanism to frontend/'s) ─────────

export const MOCK_RTC_SCRIPT = `
(function () {
  if (!window.__HVH_TEST_MODE) return;

  window.__hvhCallOnMessage = null;

  function makeChannel() {
    var dc = {
      readyState: 'open',
      onopen: null, onclose: null,
      _onmessage: null,
      get onmessage() { return this._onmessage; },
      set onmessage(cb) {
        this._onmessage = cb;
        window.__hvhCallOnMessage = function(data) { cb({ data: data }); };
      },
      send: function(s) {
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
    dc.readyState = 'connecting';
    this._dc = dc;
    return dc;
  };

  MockRTCPC.prototype.setLocalDescription = function() { return Promise.resolve(); };

  MockRTCPC.prototype.setRemoteDescription = function() {
    var me = this;
    setTimeout(function() {
      if (me._isOfferer) {
        if (me._dc) {
          me._dc.readyState = 'open';
          me._connectionState = 'connected';
          if (me._dc.onopen) me._dc.onopen();
        }
      } else {
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

// ── Cross-context message bridge ──────────────────────────────────────────

export async function setupBridge(page1: Page, page2: Page) {
  let p1SentCount = 0, p2SentCount = 0;
  const deliver = async (target: Page, jsonStr: string) => {
    await target.evaluate((msg: string) => {
      const fn = (window as Window & { __hvhCallOnMessage?: ((s: string) => void) })
        .__hvhCallOnMessage;
      if (fn) fn(msg);
    }, jsonStr);
  };
  await page1.exposeFunction("__hvhSend", async (jsonStr: string) => {
    p1SentCount++;
    if (p1SentCount <= 5 || p1SentCount % 50 === 0) console.log(`bridge p1→p2 #${p1SentCount}:`, jsonStr.slice(0, 80));
    await deliver(page2, jsonStr);
  });
  await page2.exposeFunction("__hvhSend", async (jsonStr: string) => {
    p2SentCount++;
    if (p2SentCount <= 5 || p2SentCount % 50 === 0) console.log(`bridge p2→p1 #${p2SentCount}:`, jsonStr.slice(0, 80));
    await deliver(page1, jsonStr);
  });
}

// ── In-memory Nostr relay (NIP-01 minimal) ────────────────────────────────

type NostrFilter = { kinds?: number[]; authors?: string[]; "#t"?: string[]; "#p"?: string[] };
type NostrEvent  = { id: string; pubkey: string; kind: number; tags: string[][]; content: string; created_at: number; sig: string };

export class InMemoryNostrRelay {
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

// ── Shared match setup ─────────────────────────────────────────────────────
//
// Creates two isolated player contexts, wires the message bridge, installs
// the RTC mock and in-memory Nostr relay, runs matchmaking from the home
// page, and waits until both pages land on the same /play?id=… match.

export interface MatchSetup {
  ctx1: BrowserContext;
  ctx2: BrowserContext;
  page1: Page;
  page2: Page;
}

export async function setupMatch(
  browser: Browser,
  opts: { modelMoves?: boolean; matchLength?: number } = {},
): Promise<MatchSetup> {
  const relay = new InMemoryNostrRelay();
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  // Warm the dev server's on-demand compile of both routes before the clock
  // starts — a cold `next dev` compile of /play can exceed the matchmaking
  // window and make the first attempt flake.
  await page1.request.get("/");
  await page1.request.get("/play?id=warmup");

  await setupBridge(page1, page2);

  const flags = { modelMoves: !!opts.modelMoves, matchLength: opts.matchLength ?? 0 };
  const installFlags = (f: typeof flags) => {
    const w = window as Window & {
      __HVH_TEST_MODE?: boolean;
      __HVH_MODEL_MOVES?: boolean;
      __HVH_MATCH_LENGTH?: number;
    };
    w.__HVH_TEST_MODE = true;
    if (f.modelMoves) w.__HVH_MODEL_MOVES = true;
    if (f.matchLength > 0) w.__HVH_MATCH_LENGTH = f.matchLength;
  };
  await page1.addInitScript(installFlags, flags);
  await page2.addInitScript(installFlags, flags);

  await page1.addInitScript({ content: MOCK_RTC_SCRIPT });
  await page2.addInitScript({ content: MOCK_RTC_SCRIPT });

  await page1.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
  await page2.routeWebSocket("wss://**", (ws) => relay.addClient(ws));

  await Promise.all([page1.goto("/"), page2.goto("/")]);

  await Promise.all([
    page1.getByRole("button", { name: "Play" }).click({ timeout: 10_000 }),
    page2.getByRole("button", { name: "Play" }).click({ timeout: 10_000 }),
  ]);

  const isPlay = (url: URL) => /^\/play\/?$/.test(url.pathname) && url.searchParams.has("id");
  await Promise.all([
    page1.waitForURL(isPlay, { timeout: 60_000 }),
    page2.waitForURL(isPlay, { timeout: 60_000 }),
  ]);

  const id1 = new URL(page1.url()).searchParams.get("id");
  const id2 = new URL(page2.url()).searchParams.get("id");
  expect(id1).toMatch(/^0x[0-9a-f]{64}$/i);
  expect(id1).toBe(id2);

  return { ctx1, ctx2, page1, page2 };
}

// Snapshot of the testMode window hooks that the play page maintains.
export interface HvhSnapshot {
  mySide: 0 | 1 | null;
  modelMoveCount: number;
  game: {
    game_over: boolean;
    winner: 0 | 1 | null;
    score: [number, number];
    match_length: number;
    off: [number, number];
    position_id: string;
  } | null;
}

export function readHvhState(page: Page): Promise<HvhSnapshot> {
  return page.evaluate(() => {
    const w = window as Window & {
      __HVH_GAME_STATE?: HvhSnapshot["game"];
      __HVH_MY_SIDE?: 0 | 1 | null;
      __HVH_MODEL_MOVE_COUNT?: number;
    };
    const g = w.__HVH_GAME_STATE ?? null;
    return {
      mySide: w.__HVH_MY_SIDE ?? null,
      modelMoveCount: w.__HVH_MODEL_MOVE_COUNT ?? 0,
      game: g
        ? {
            game_over: g.game_over,
            winner: g.winner,
            score: g.score,
            match_length: g.match_length,
            off: g.off,
            position_id: g.position_id,
          }
        : null,
    };
  });
}
