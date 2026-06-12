// webrtc_match.ts — the peer-to-peer move transport for human-vs-human.
//
// A thin wrapper over RTCPeerConnection + an ordered RTCDataChannel, with the
// SDP offer/answer and ICE candidates relayed through Nostr (see nostr.ts).
// The game layer gets a tiny typed interface (send / onMessage / onState) and
// never touches SDP or Nostr directly.
//
// Roles come from the matcher (matchmaker.ts): the lower-pubkey peer of a pair
// is the offerer, so there's no glare and no perfect-negotiation dance. NAT
// traversal uses a free public STUN server; a minority of symmetric NATs will
// need TURN (a follow-up).
//
// Browser-only ("use client").

"use client";

import type { NostrMatchClient, SignalMsg } from "./nostr";

// STUN resolves reflexive candidates for cone NAT.
// TURN relays traffic when direct ICE fails (symmetric NAT, enterprise firewall).
// OpenRelay is a public free-tier TURN service; replace with a private TURN
// deployment for production to avoid shared-credential abuse.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    // Port 3479 is open on the VCN security list; 3478 is not yet.
    // Switch to 3478 once the VCN rule is updated.
    urls: [
      "turn:132.145.158.84:3479",
      "turn:132.145.158.84:3479?transport=tcp",
    ],
    username: "cg",
    credential: "chaingammon2026",
  },
];

export type ConnState = "connecting" | "open" | "closed" | "failed";

export interface PeerConnection {
  /** Send a JSON-serializable game message to the peer. */
  send: (msg: unknown) => void;
  /** Register the handler for inbound game messages (parsed JSON). */
  onMessage: (cb: (msg: unknown) => void) => void;
  /** Register the connection-state handler. */
  onState: (cb: (s: ConnState) => void) => void;
  /** Tear down the data channel, peer connection, and Nostr subscription. */
  close: () => void;
}

/**
 * Open a WebRTC data channel to `peerPubkey` for `matchId`, signaling over
 * Nostr. `isOfferer` (from the matcher) decides who creates the offer.
 */
export function connectPeer(
  nostr: NostrMatchClient,
  peerPubkey: string,
  matchId: string,
  isOfferer: boolean,
): PeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  let channel: RTCDataChannel | null = null;
  let messageCb: ((m: unknown) => void) | null = null;
  const messageBuffer: unknown[] = [];
  let stateCb: ((s: ConnState) => void) | null = null;
  let remoteSet = false;
  // ICE can arrive before the remote description is applied — buffer until then.
  const pendingCandidates: RTCIceCandidateInit[] = [];

  const emit = (s: ConnState) => stateCb?.(s);

  const wireChannel = (ch: RTCDataChannel) => {
    channel = ch;
    ch.onopen = () => emit("open");
    ch.onclose = () => emit("closed");
    ch.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (messageCb) {
          messageCb(msg);
        } else {
          messageBuffer.push(msg);
        }
      } catch {
        /* non-JSON frame — ignore */
      }
    };
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      nostr.sendSignal(peerPubkey, matchId, {
        type: "ice",
        candidate: e.candidate.toJSON(),
      });
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") emit("failed");
    else if (pc.connectionState === "closed") emit("closed");
  };

  const applyRemote = async (sdp: RTCSessionDescriptionInit) => {
    await pc.setRemoteDescription(sdp);
    remoteSet = true;
    for (const c of pendingCandidates.splice(0)) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* stale/duplicate candidate — ignore */
      }
    }
  };

  if (isOfferer) {
    wireChannel(pc.createDataChannel("game", { ordered: true }));
  } else {
    pc.ondatachannel = (e) => wireChannel(e.channel);
  }

  // Subscribe BEFORE sending the offer so the answerer's relay subscription is
  // in place when the offer event arrives. Ephemeral Nostr events are not stored;
  // if the offer fires before subscribeSignals sends its REQ, it is gone forever.
  const unsub = nostr.subscribeSignals(async (payload: SignalMsg, from, mId) => {
    if (from !== peerPubkey || mId !== matchId) return;
    if (payload.type === "offer" && payload.sdp) {
      await applyRemote(payload.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      nostr.sendSignal(peerPubkey, matchId, { type: "answer", sdp: answer });
    } else if (payload.type === "answer" && payload.sdp) {
      await applyRemote(payload.sdp);
    } else if (payload.type === "ice" && payload.candidate) {
      if (remoteSet) {
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch {
          /* ignore */
        }
      } else {
        pendingCandidates.push(payload.candidate);
      }
    }
  });

  // Send offer now that our own subscribeSignals is registered (answerer side has
  // the same timing guarantee because both peers call connectPeer simultaneously
  // from tryConnect, so by the time the offer is published the answerer's REQ is
  // already in-flight to the relay).
  if (isOfferer) {
    void (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      nostr.sendSignal(peerPubkey, matchId, { type: "offer", sdp: offer });
    })();
  }

  emit("connecting");

  return {
    send: (msg) => {
      if (channel?.readyState === "open") channel.send(JSON.stringify(msg));
    },
    onMessage: (cb) => {
      messageCb = cb;
      if (messageBuffer.length > 0) {
        const buffered = messageBuffer.splice(0);
        for (const m of buffered) cb(m);
      }
    },
    onState: (cb) => {
      stateCb = cb;
    },
    close: () => {
      unsub();
      channel?.close();
      pc.close();
      emit("closed");
    },
  };
}
