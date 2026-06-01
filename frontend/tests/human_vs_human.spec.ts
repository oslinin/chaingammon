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

import { test, expect, type WebSocketRoute } from "@playwright/test";

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

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe("human-vs-human matchmaking", () => {
  test(
    "two players pair via Nostr and land on the same play-human match",
    async ({ browser }) => {
      const relay = new InMemoryNostrRelay();

      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();

      try {
        // Intercept ALL wss:// connections on both pages and route them
        // through the in-memory relay so no live Nostr network is needed.
        await page1.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
        await page2.routeWebSocket("wss://**", (ws) => relay.addClient(ws));

        // Load the home page on both contexts.
        // AppModeContext defaults to "elo" so FindHumanButton renders without
        // any extra setup. wallet address defaults to "" which is fine.
        await Promise.all([page1.goto("/"), page2.goto("/")]);

        // Both players click the button.
        await Promise.all([
          page1
            .getByRole("button", { name: "Play a human" })
            .click({ timeout: 10_000 }),
          page2
            .getByRole("button", { name: "Play a human" })
            .click({ timeout: 10_000 }),
        ]);

        // UI should flip to "Stop searching" on both sides.
        await expect(
          page1.getByRole("button", { name: "Stop searching" }),
        ).toBeVisible({ timeout: 5_000 });
        await expect(
          page2.getByRole("button", { name: "Stop searching" }),
        ).toBeVisible({ timeout: 5_000 });

        // Timing budget:
        //   startPresence re-publishes every 15 s. If one player's initial
        //   publish races ahead of the other's subscription setup, they won't
        //   see each other until the 15 s re-publish (~t=20 s for pairing,
        //   ~t=25 s for navigation). Allow 60 s to cover the worst-case path.
        //
        //   Note: the URL uses a query param (?id=0x…), not a path segment,
        //   so the pattern must not require a trailing slash.
        await Promise.all([
          page1.waitForURL("**/play-human**", { timeout: 60_000 }),
          page2.waitForURL("**/play-human**", { timeout: 60_000 }),
        ]);

        // matchId is keccak256(sorted(pubkeyA + pubkeyB)) — deterministic and
        // identical on both sides. It lives in the ?id= query param.
        const matchId1 = new URL(page1.url()).searchParams.get("id") ?? "";
        const matchId2 = new URL(page2.url()).searchParams.get("id") ?? "";
        expect(matchId1).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(matchId1).toBe(matchId2);
      } finally {
        await ctx1.close();
        await ctx2.close();
      }
    },
  );

  test(
    "play-human page has an active peer connection for both players (not an agent game)",
    async ({ browser }) => {
      // Regression: after matching, peerMatches must contain the connection
      // for the matchId in the URL. If it doesn't, the page shows
      // "No active connection for this match" and the user falls back to an
      // agent game. This test catches that failure path.
      const relay = new InMemoryNostrRelay();

      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();

      try {
        await page1.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
        await page2.routeWebSocket("wss://**", (ws) => relay.addClient(ws));

        await Promise.all([page1.goto("/"), page2.goto("/")]);
        await Promise.all([
          page1
            .getByRole("button", { name: "Play a human" })
            .click({ timeout: 10_000 }),
          page2
            .getByRole("button", { name: "Play a human" })
            .click({ timeout: 10_000 }),
        ]);

        await Promise.all([
          page1.waitForURL("**/play-human**", { timeout: 60_000 }),
          page2.waitForURL("**/play-human**", { timeout: 60_000 }),
        ]);

        // Both players must land on the same matchId.
        const matchId1 = new URL(page1.url()).searchParams.get("id") ?? "";
        const matchId2 = new URL(page2.url()).searchParams.get("id") ?? "";
        expect(matchId1).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(matchId1).toBe(matchId2);

        // The peer connection must be alive in peerMatches — the page shows
        // "Waiting for opponent" rather than the "no connection" error screen.
        // If the bug regresses, the error text appears instead.
        await expect(
          page1.getByText(/no active connection for this match/i),
        ).not.toBeVisible({ timeout: 5_000 });
        await expect(
          page2.getByText(/no active connection for this match/i),
        ).not.toBeVisible({ timeout: 5_000 });

        await expect(
          page1.getByText(/waiting for opponent/i),
        ).toBeVisible({ timeout: 5_000 });
        await expect(
          page2.getByText(/waiting for opponent/i),
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await ctx1.close();
        await ctx2.close();
      }
    },
  );

  test("single player sees 'no one else searching' status", async ({
    browser,
  }) => {
    const relay = new InMemoryNostrRelay();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await page.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
      await page.goto("/");
      await page
        .getByRole("button", { name: "Play a human" })
        .click({ timeout: 10_000 });

      // After STABILIZE_MS with no peer the component shows the "no one" message.
      await expect(
        page.getByText(/no one else searching/i),
      ).toBeVisible({ timeout: 8_000 });

      // Stop searching — button flips back.
      await page.getByRole("button", { name: "Stop searching" }).click();
      await expect(
        page.getByRole("button", { name: "Play a human" }),
      ).toBeVisible({ timeout: 3_000 });
    } finally {
      await ctx.close();
    }
  });
});
