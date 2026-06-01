// live_relay_hvh.spec.ts — live Nostr relay smoke test for human-vs-human.
//
// Unlike human_vs_human.spec.ts this test does NOT mock WebSocket connections.
// All Nostr traffic goes through real public relays:
//   wss://relay.damus.io, wss://nos.lol, wss://relay.primal.net, wss://relay.nostr.band
//
// Two browser contexts search for each other, pair, and navigate to the same
// /play-human?id=<matchId> URL. WebRTC runs over loopback ICE (both contexts
// share the same Chromium process on the same machine), so NAT traversal is
// not exercised — but relay reachability, NIP-01 message flow, and the full
// pairing → WebRTC handshake → navigation path all run against real
// infrastructure.
//
// Run against the local dev server:
//   pnpm exec playwright test tests/live_relay_hvh.spec.ts
//
// Run against the deployed GitHub Pages build (set BASE_URL env var):
//   BASE_URL=https://oslinin.github.io/chaingammon \
//     pnpm exec playwright test tests/live_relay_hvh.spec.ts
//
// Timing budget:
//   STABILIZE_MS (3 s) + real relay RTT (≤5 s) + WebRTC loopback (≤3 s) +
//   buffer = 60 s total, matching the in-memory test.
//
// Note: this test requires outbound HTTPS/WSS access to the Nostr relays. It
// will fail in fully air-gapped environments or if the relays are down.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
// Allow the full 60 s pairing budget per test.
test.setTimeout(120_000);

test.describe("human-vs-human live relay smoke test", () => {
  test(
    "two walletless players pair via live Nostr relays and land on the same match",
    async ({ browser }) => {
      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();

      // Capture browser console errors for post-mortem debugging.
      const errors: string[] = [];
      page1.on("console", (m) => { if (m.type() === "error") errors.push(`P1: ${m.text()}`); });
      page2.on("console", (m) => { if (m.type() === "error") errors.push(`P2: ${m.text()}`); });

      try {
        // Navigate both players. No wallet connected → ELO defaults to 1500,
        // ENS label/address are empty. AppModeContext defaults to "elo" so
        // EloHome renders with the "Play" ActionCard after hydration.
        await Promise.all([
          page1.goto(BASE_URL),
          page2.goto(BASE_URL),
        ]);

        // EloHome's "Play" button is the only <button> on the page (Train and
        // Play($) are <Link> elements). Both must click before STABILIZE_MS
        // (3 s) fires — EloHome has no retry loop and falls back to the agent
        // team-demo immediately if no partner is seen at the 3 s mark.
        const playBtn = (p: typeof page1) =>
          p.getByRole("button", { name: /find a human/i });
        await Promise.all([
          playBtn(page1).waitFor({ timeout: 15_000 }),
          playBtn(page2).waitFor({ timeout: 15_000 }),
        ]);
        await Promise.all([playBtn(page1).click(), playBtn(page2).click()]);

        // Wait for both players to land on /play-human?id=<matchId>.
        // Budget: up to 60 s for real relay latency + STABILIZE_MS.
        await Promise.all([
          page1.waitForURL(`${BASE_URL}**/play-human**`, { timeout: 60_000 }),
          page2.waitForURL(`${BASE_URL}**/play-human**`, { timeout: 60_000 }),
        ]);

        // Both must have navigated to the SAME matchId in the ?id= query param.
        const matchId1 = new URL(page1.url()).searchParams.get("id") ?? "";
        const matchId2 = new URL(page2.url()).searchParams.get("id") ?? "";

        expect(matchId1).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(matchId1).toBe(matchId2);

        // Both pages should show the "Waiting for opponent…" connecting phase
        // (WebRTC channel is open; wallet signing hasn't happened yet because
        // neither context has a connected wallet — that's expected in this test).
        await Promise.all([
          page1.getByText(/waiting for opponent/i).waitFor({ timeout: 15_000 }),
          page2.getByText(/waiting for opponent/i).waitFor({ timeout: 15_000 }),
        ]);
      } finally {
        if (errors.length > 0) {
          console.log("Console errors captured during test:\n" + errors.join("\n"));
        }
        await ctx1.close();
        await ctx2.close();
      }
    },
  );

  test(
    "relay connectivity: presence event reaches a second subscriber within 10 s",
    async ({ browser }) => {
      // Lighter relay health check: one publisher, one subscriber.
      // Verifies the relays accept our ephemeral events and forward them —
      // without needing a full WebRTC handshake.
      const { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } =
        await import("nostr-tools");

      const skA = generateSecretKey();
      const pkA = getPublicKey(skA);

      const pool = new SimplePool();
      const relays = [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.primal.net",
      ];

      const received = new Promise<boolean>((resolve) => {
        const sub = pool.subscribeMany(
          relays,
          { kinds: [20100], "#t": ["chaingammon-smoke-test"], since: Math.floor(Date.now() / 1000) - 5 },
          {
            onevent(evt) {
              if (evt.pubkey === pkA) {
                sub.close();
                resolve(true);
              }
            },
          },
        );
      });

      // Publish a presence event.
      const evt = finalizeEvent(
        {
          kind: 20100,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "chaingammon-smoke-test"]],
          content: JSON.stringify({ smoke: true }),
        },
        skA,
      );
      pool.publish(relays, evt);

      const ok = await Promise.race([
        received,
        new Promise<false>((r) => setTimeout(() => r(false), 10_000)),
      ]);

      pool.close(relays);
      expect(ok, "presence event should echo back from at least one relay within 10 s").toBe(true);
    },
  );
});
