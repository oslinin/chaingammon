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

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export type ConnState = "connecting" | "open" | "closed" | "failed";

export interface PeerConnection {
  /** Send a JSON-serializable game message to the peer. */
  send: (msg: unknown) => void;
  /** Add an inbound message listener. Returns a cleanup function to remove it. */
  onMessage: (cb: (msg: unknown) => void) => () => void;
  /** Add a connection-state listener. Returns a cleanup function to remove it. */
  onState: (cb: (s: ConnState) => void) => () => void;
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
  const messageCbs = new Set<(m: unknown) => void>();
  const stateCbs = new Set<(s: ConnState) => void>();
  let remoteSet = false;
  // ICE can arrive before the remote description is applied — buffer until then.
  const pendingCandidates: RTCIceCandidateInit[] = [];

  const emit = (s: ConnState) => stateCbs.forEach((cb) => cb(s));

  const wireChannel = (ch: RTCDataChannel) => {
    channel = ch;
    ch.onopen = () => emit("open");
    ch.onclose = () => emit("closed");
    ch.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as unknown;
        messageCbs.forEach((cb) => cb(parsed));
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
    void (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      nostr.sendSignal(peerPubkey, matchId, { type: "offer", sdp: offer });
    })();
  } else {
    pc.ondatachannel = (e) => wireChannel(e.channel);
  }

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

  emit("connecting");

  return {
    send: (msg) => {
      if (channel?.readyState === "open") channel.send(JSON.stringify(msg));
    },
    onMessage: (cb) => {
      messageCbs.add(cb);
      return () => messageCbs.delete(cb);
    },
    onState: (cb) => {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    close: () => {
      unsub();
      channel?.close();
      pc.close();
      emit("closed");
    },
  };
}
