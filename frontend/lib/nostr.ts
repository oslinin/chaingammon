// nostr.ts — presence + WebRTC signaling over public Nostr relays.
//
// This is the serverless, off-chain rendezvous layer for human-vs-human play:
//   - presence  : "I'm searching" (ephemeral event, kind 20100, tag #t=chaingammon-match)
//   - signaling : SDP offer/answer + ICE candidates routed to a peer (kind 20101, #p=peer)
// Both kinds are in the 20000–29999 ephemeral range, so relays don't persist them —
// when you stop publishing presence you simply disappear (no cleanup write, unlike ENS).
//
// Identity is an EPHEMERAL per-session keypair (generated on each search), so there's no
// persistent Nostr identity and nothing ties to the wallet. The wallet/ENS identity travels
// in the presence content and is verified separately (against ENS) by the matcher.
//
// Browser-only ("use client"). nostr-tools v2 API.

"use client";

import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
} from "nostr-tools";

// A small spread of reliable public relays. More = more robust discovery, but
// slower; tune during testing.
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
];

const MATCH_TAG = "chaingammon-match";
const PRESENCE_KIND = 20100;
const SIGNAL_KIND = 20101;

const nowSec = () => Math.floor(Date.now() / 1000);

export interface NostrIdentity {
  sk: Uint8Array;
  pubkey: string;
}

/** Fresh ephemeral keypair for one searching session. */
export function newIdentity(): NostrIdentity {
  const sk = generateSecretKey();
  return { sk, pubkey: getPublicKey(sk) };
}

/** What a searcher advertises. `elo` is from ENS and is re-verified by the matcher. */
export interface PresenceContent {
  ensLabel: string;
  address: string;
  sessionPubkey: string;
  elo: number;
}

export interface SignalMsg {
  type: "offer" | "answer" | "ice";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export class NostrMatchClient {
  private pool = new SimplePool();
  private relays: string[];
  private id: NostrIdentity;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(id: NostrIdentity, relays: string[] = DEFAULT_RELAYS) {
    this.id = id;
    this.relays = relays;
  }

  get pubkey(): string {
    return this.id.pubkey;
  }

  /** Publish presence immediately, then re-publish on a heartbeat until stopPresence(). */
  startPresence(content: PresenceContent, intervalMs = 15_000): void {
    const publishOnce = () => {
      const evt = finalizeEvent(
        {
          kind: PRESENCE_KIND,
          created_at: nowSec(),
          tags: [["t", MATCH_TAG]],
          content: JSON.stringify(content),
        },
        this.id.sk,
      );
      this.pool.publish(this.relays, evt);
    };
    publishOnce();
    this.presenceTimer = setInterval(publishOnce, intervalMs);
  }

  stopPresence(): void {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  /**
   * Subscribe to other searchers' presence (seen within the last `sinceSec`).
   * Feeds the auto-matcher; never rendered. Returns an unsubscribe fn.
   */
  subscribePresence(
    onPresence: (p: PresenceContent, pubkey: string, at: number) => void,
    sinceSec = 30,
  ): () => void {
    const sub = this.pool.subscribeMany(
      this.relays,
      { kinds: [PRESENCE_KIND], "#t": [MATCH_TAG], since: nowSec() - sinceSec },
      {
        onevent: (evt: Event) => {
          if (evt.pubkey === this.id.pubkey) return; // ignore self echoes
          try {
            onPresence(JSON.parse(evt.content) as PresenceContent, evt.pubkey, evt.created_at);
          } catch {
            /* malformed presence — ignore */
          }
        },
      },
    );
    return () => sub.close();
  }

  /** Send an SDP/ICE payload to a specific peer for a specific match. */
  sendSignal(peerPubkey: string, matchId: string, payload: SignalMsg): void {
    const evt = finalizeEvent(
      {
        kind: SIGNAL_KIND,
        created_at: nowSec(),
        tags: [
          ["p", peerPubkey],
          ["d", matchId],
        ],
        content: JSON.stringify(payload),
      },
      this.id.sk,
    );
    this.pool.publish(this.relays, evt);
  }

  /** Subscribe to signaling addressed to me (#p == my pubkey). Returns unsubscribe fn. */
  subscribeSignals(
    onSignal: (payload: SignalMsg, fromPubkey: string, matchId: string) => void,
  ): () => void {
    const sub = this.pool.subscribeMany(
      this.relays,
      // Look back 10 s to tolerate clock skew and relay propagation delay;
      // this is narrow enough to never replay stale signals from prior sessions.
      { kinds: [SIGNAL_KIND], "#p": [this.id.pubkey], since: nowSec() - 10 },
      {
        onevent: (evt: Event) => {
          const matchId = evt.tags.find((t) => t[0] === "d")?.[1] ?? "";
          try {
            onSignal(JSON.parse(evt.content) as SignalMsg, evt.pubkey, matchId);
          } catch {
            /* malformed signal — ignore */
          }
        },
      },
    );
    return () => sub.close();
  }

  close(): void {
    this.stopPresence();
    this.pool.close(this.relays);
  }
}
