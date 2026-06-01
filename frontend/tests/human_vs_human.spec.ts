// human_vs_human.spec.ts — E2E tests for the Nostr + WebRTC matchmaking flow.
//
// The real user path goes through EloHome (page.tsx), not FindHumanButton.
// EloHome's "Play" ActionCard starts Nostr presence, waits STABILIZE_MS (3 s),
// runs ONE pairing attempt, then either:
//   - found partner → WebRTC → navigate to /play-human?id=<matchId>
//   - no partner    → immediately navigate to /team-demo?opponents=4 (agent fallback)
//
// All Nostr relay connections are intercepted with an in-memory relay so no
// live internet access is required.  WebRTC runs natively between two browser
// contexts in the same Chromium process over loopback ICE candidates.
//
// Timing budget: STABILIZE_MS (3 s) + WebRTC handshake (~1 s) + buffer = 15 s.

import { test, expect, type WebSocketRoute } from "@playwright/test";

// ── Minimal in-memory Nostr relay ──────────────────────────────────────────
//
// Implements just enough of NIP-01 to relay ephemeral presence (kind 20100)
// and signal (kind 20101) events between the two browser contexts:
//   REQ  → store subscription, reply EOSE (no persisted events)
//   EVENT → acknowledge OK, broadcast to matching subscriptions
//   CLOSE → remove subscription
//
// Event IDs are deduplicated so duplicate publications from nostr-tools
// SimplePool don't fire duplicate messages to subscribers.

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

// ── Helper: find EloHome "Play" button ────────────────────────────────────
//
// EloHome renders after hydration (AppModeContext defaults to "elo").
// The "Play" ActionCard is the only <button> on the page — Train and
// Play ($) use <Link href=...> which renders as <a>, not <button>.
// Its accessible name includes "Find a human first" (the sublabel),
// which uniquely identifies it and stops matching once searching starts
// (the sublabel then shows the live search status instead).
function playButton(page: import("@playwright/test").Page) {
  return page.getByRole("button", { name: /find a human/i });
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe("human-vs-human matchmaking (EloHome flow)", () => {
  test(
    "two players pair via Nostr and navigate to the same play-human URL",
    async ({ browser }) => {
      const relay = new InMemoryNostrRelay();

      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();

      try {
        await page1.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
        await page2.routeWebSocket("wss://**", (ws) => relay.addClient(ws));

        await Promise.all([page1.goto("/"), page2.goto("/")]);

        // Both must click before STABILIZE_MS (3 s) fires on either side.
        // EloHome has no retry loop: if no partner is seen at the 3 s mark it
        // navigates straight to the agent fallback (/team-demo?opponents=4).
        // Starting both simultaneously with Promise.all ensures both are
        // publishing presence before any pairing attempt runs.
        await Promise.all([
          playButton(page1).waitFor({ timeout: 10_000 }),
          playButton(page2).waitFor({ timeout: 10_000 }),
        ]);
        await Promise.all([
          playButton(page1).click(),
          playButton(page2).click(),
        ]);

        // After STABILIZE_MS + WebRTC handshake both players navigate to
        // /play-human?id=<matchId>.  The matchId MUST be in the ?id= query
        // param — the [matchId] dynamic route was removed in favour of a
        // static /play-human page that reads searchParams on the client.
        await Promise.all([
          page1.waitForURL("**/play-human**", { timeout: 15_000 }),
          page2.waitForURL("**/play-human**", { timeout: 15_000 }),
        ]);

        // Regression: previously page.tsx used /play-human/<matchId> (old
        // path-segment format).  That route no longer exists in the static
        // export so GitHub Pages returned 404 and peerMatches was never found.
        const matchId1 = new URL(page1.url()).searchParams.get("id") ?? "";
        const matchId2 = new URL(page2.url()).searchParams.get("id") ?? "";
        expect(matchId1, "matchId must be in ?id= query param").toMatch(
          /^0x[0-9a-f]{64}$/i,
        );
        expect(matchId1, "both players must share the same matchId").toBe(
          matchId2,
        );
      } finally {
        await ctx1.close();
        await ctx2.close();
      }
    },
  );

  test(
    "play-human page shows game UI — not a 404 or agent-game fallback",
    async ({ browser }) => {
      // Regression: peerMatches (module-level Map) must survive the client-side
      // navigation from the home page to /play-human.  If it doesn't, the page
      // shows "No active connection for this match" and the user ends up playing
      // an agent instead.
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
          playButton(page1).waitFor({ timeout: 10_000 }),
          playButton(page2).waitFor({ timeout: 10_000 }),
        ]);
        await Promise.all([
          playButton(page1).click(),
          playButton(page2).click(),
        ]);

        await Promise.all([
          page1.waitForURL("**/play-human**", { timeout: 15_000 }),
          page2.waitForURL("**/play-human**", { timeout: 15_000 }),
        ]);

        // Must NOT show the "No active connection" error (peerMatches miss).
        await expect(
          page1.getByText(/no active connection for this match/i),
        ).not.toBeVisible({ timeout: 3_000 });
        await expect(
          page2.getByText(/no active connection for this match/i),
        ).not.toBeVisible({ timeout: 3_000 });

        // Must NOT have fallen back to the agent team-demo page.
        expect(page1.url()).not.toContain("team-demo");
        expect(page2.url()).not.toContain("team-demo");

        // Must show the human-game connecting state.
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

  test(
    "solo player falls back to agent team-demo after stabilize timeout",
    async ({ browser }) => {
      // EloHome has no retry loop. A lone player navigates to team-demo
      // (not a stale "searching" state) after STABILIZE_MS with no peer.
      const relay = new InMemoryNostrRelay();
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      try {
        await page.routeWebSocket("wss://**", (ws) => relay.addClient(ws));
        await page.goto("/");
        await playButton(page).waitFor({ timeout: 10_000 });
        await playButton(page).click();

        // After 3 s with no peer, EloHome calls router.push("/team-demo?opponents=4").
        await page.waitForURL("**/team-demo**", { timeout: 8_000 });
        expect(new URL(page.url()).searchParams.get("opponents")).toBe("4");
      } finally {
        await ctx.close();
      }
    },
  );
});
