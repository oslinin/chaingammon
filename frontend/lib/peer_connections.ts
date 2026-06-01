// peer_connections.ts — module-level store for live WebRTC peer connections.
//
// EloHome (page.tsx) stores a PeerConnection here before navigating to
// /play-human?id=<matchId>. The play-human page retrieves it by matchId.
// The map persists across Next.js client-side navigations within the same
// browser tab, but is cleared on a full page reload (acceptable — a
// reload while mid-match already loses the WebRTC connection).

import type { PeerConnection } from "./webrtc_match";

export interface PeerMatchInfo {
  peer: PeerConnection;
  isOfferer: boolean;
}

export const peerMatches = new Map<string, PeerMatchInfo>();
