// app/page.tsx — home page: one button, matchmake over Nostr, play unrated.
//
// Trimmed from frontend/app/page.tsx: no wallet, no ENS, no on-chain ELO — a
// guest's identity is just an ephemeral Nostr keypair (see ../lib/nostr.ts)
// and every guest advertises the same neutral ELO, since there's no rating
// system to bias pairing with yet (Task 5 adds human ELO on-chain).
"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { keccak256, toBytes } from "viem";

import { NostrMatchClient, newIdentity } from "../lib/nostr";
import { computePairing, type Searcher } from "../lib/matchmaker";
import { connectPeer } from "../lib/webrtc_match";
import { peerMatches } from "../lib/peer_connections";

const STABILIZE_MS = 3_000;
const PRESENCE_TTL_S = 22;
const PRESENCE_INTERVAL_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
const REPAIR_MS = 5_000;
const GUEST_ELO = 1500;

function hvhMatchId(pubA: string, pubB: string): string {
  const [lo, hi] = pubA < pubB ? [pubA, pubB] : [pubB, pubA];
  return keccak256(toBytes(lo + hi));
}

export default function Home() {
  const router = useRouter();
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState("");

  const nostrRef = useRef<NostrMatchClient | null>(null);
  const searchersRef = useRef<Map<string, { s: Searcher; at: number }>>(new Map());
  const connectingRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const stopSearching = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    connectingRef.current = false;
    nostrRef.current?.stopPresence();
    nostrRef.current?.close();
    nostrRef.current = null;
    searchersRef.current.clear();
    setSearching(false);
    setSearchStatus("");
  }, []);

  const tryConnect = useCallback((nostr: NostrMatchClient) => {
    if (connectingRef.current) return;
    const now = Date.now() / 1000;
    for (const [pk, entry] of searchersRef.current) {
      if (now - entry.at > PRESENCE_TTL_S) searchersRef.current.delete(pk);
    }
    const searchers: Searcher[] = [
      { pubkey: nostr.pubkey, elo: GUEST_ELO },
      ...Array.from(searchersRef.current.values()).map((e) => e.s),
    ];
    const { partner, isOfferer } = computePairing(nostr.pubkey, searchers);
    if (!partner) {
      setSearchStatus(
        searchersRef.current.size === 0
          ? "Searching for an opponent…"
          : `${searchersRef.current.size} found, pairing…`,
      );
      return;
    }
    connectingRef.current = true;
    const mid = hvhMatchId(nostr.pubkey, partner.pubkey);
    setSearchStatus("Connecting…");
    const peer = connectPeer(nostr, partner.pubkey, mid, isOfferer);
    peerMatches.set(mid, { peer, isOfferer, myNostrPubkey: nostr.pubkey });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      connectingRef.current = false;
      peer.close();
      peerMatches.delete(mid);
      setSearchStatus("Timed out, retrying…");
    }, CONNECT_TIMEOUT_MS);
    peer.onState((s) => {
      if (timedOut) return;
      if (s === "open") {
        clearTimeout(timer);
        nostr.stopPresence();
        router.push(`/play?id=${mid}`);
      } else if (s === "failed" || s === "closed") {
        clearTimeout(timer);
        connectingRef.current = false;
        peerMatches.delete(mid);
        setSearchStatus("Retry…");
      }
    });
  }, [router]);

  const startPlay = useCallback(() => {
    const id = newIdentity();
    const nostr = new NostrMatchClient(id);
    nostrRef.current = nostr;
    nostr.startPresence({ ensLabel: "", address: "", sessionPubkey: nostr.pubkey, elo: GUEST_ELO }, PRESENCE_INTERVAL_MS);
    const unsub = nostr.subscribePresence((p, pubkey, at) => {
      const existing = searchersRef.current.get(pubkey);
      if (!existing || at >= existing.at) {
        searchersRef.current.set(pubkey, { s: { pubkey, elo: p.elo ?? GUEST_ELO }, at });
      }
    });
    const stabilizeTimer = setTimeout(() => tryConnect(nostr), STABILIZE_MS);
    const repairTimer = setInterval(() => {
      if (!connectingRef.current) tryConnect(nostr);
    }, REPAIR_MS);
    cleanupRef.current = () => {
      unsub();
      clearTimeout(stabilizeTimer);
      clearInterval(repairTimer);
    };
    setSearching(true);
    setSearchStatus("Searching for an opponent…");
  }, [tryConnect]);

  return (
    <main
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", minHeight: "calc(100vh - 60px)", gap: 24,
        fontFamily: "var(--cg-font-sans)", color: "var(--cg-fg-1)", padding: 24,
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <h1 style={{ fontFamily: "var(--cg-font-display)", fontSize: 32, fontWeight: 400, marginBottom: 8 }}>
          Unrated backgammon
        </h1>
        <p style={{ fontSize: 14, color: "var(--cg-fg-3)" }}>
          Play a peer-to-peer game with a stranger. No wallet, no stakes — just
          matchmaking over Nostr and moves relayed directly between browsers.
          Dice are generated fairly by both players via commit-reveal, so
          neither side can control a roll.
        </p>
      </div>

      <button
        type="button"
        className="cg-btn-primary"
        style={{
          padding: "12px 32px", borderRadius: "var(--cg-radius)", border: "1px solid var(--cg-brass)",
          background: "rgba(201,155,92,0.14)", color: "var(--cg-brass-hi)", fontSize: 16, fontWeight: 600,
          fontFamily: "var(--cg-font-sans)", cursor: "pointer",
        }}
        onClick={searching ? stopSearching : startPlay}
      >
        {searching ? "Searching…" : "Play"}
      </button>

      {searching && (
        <p style={{ fontSize: 13, color: "var(--cg-fg-4)" }}>{searchStatus}</p>
      )}
    </main>
  );
}
