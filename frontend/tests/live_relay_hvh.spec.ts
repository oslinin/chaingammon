// live_relay_hvh.spec.ts — live Nostr relay smoke test for human-vs-human.
//
// Unlike human_vs_human.spec.ts this test does NOT mock WebSocket connections.
// All Nostr traffic goes through real public relays:
//   wss://relay.damus.io, wss://nos.lol, wss://relay.primal.net, wss://relay.nostr.band
//
// Two browser contexts search for each other, pair, and navigate to the same
// /play-human/{matchId} URL. WebRTC runs over loopback ICE (both contexts
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
        // ENS label/address are empty. FindHumanButton still renders because
        // AppModeContext defaults to "elo".
        await Promise.all([
          page1.goto(BASE_URL),
          page2.goto(BASE_URL),
        ]);

        // Both click "Play a human".
        await Promise.all([
          page1.getByRole("button", { name: "Play a human" }).click({ timeout: 15_000 }),
          page2.getByRole("button", { name: "Play a human" }).click({ timeout: 15_000 }),
        ]);

        // Searching state visible on both sides.
        await expect(page1.getByRole("button", { name: "Stop searching" })).toBeVisible({ timeout: 5_000 });
        await expect(page2.getByRole("button", { name: "Stop searching" })).toBeVisible({ timeout: 5_000 });

        // Wait for both players to land on /play-human/{matchId}.
        // Budget: up to 90 s for real relay latency + STABILIZE_MS + repair loop.
        await Promise.all([
          page1.waitForURL(`${BASE_URL}/play-human/**`, { timeout: 90_000 }),
          page2.waitForURL(`${BASE_URL}/play-human/**`, { timeout: 90_000 }),
        ]);

        // Both must have navigated to the SAME matchId.
        const url1 = new URL(page1.url());
        const url2 = new URL(page2.url());
        const matchId1 = url1.pathname.split("/").pop();
        const matchId2 = url2.pathname.split("/").pop();

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
