// FindHumanButton — one-press ELO-biased human-vs-human matchmaking.
//
// Press Play → publish Nostr presence → auto-matcher pairs you with the
// nearest-ELO peer → WebRTC data channel opens → navigate to the game.
// No list of searchers, no opponent to pick, no wallet popup until match
// start (the auth-sig ceremony happens on the play-human page).
//
// Presence is published on an ephemeral per-session Nostr keypair so
// nothing ties back to the ENS identity or wallet; the ENS label + ELO
// travel as content inside the presence event and are re-verified by
// peers against ENS before pairing.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { keccak256, toBytes } from "viem";
import { useAccount } from "wagmi";

import { useAppMode } from "./AppModeContext";
import { useChaingammonName } from "./useChaingammonName";
import { useChaingammonProfile } from "./useChaingammonProfile";
import { NostrMatchClient, newIdentity, type PresenceContent } from "../lib/nostr";
import { computePairing, type Searcher } from "../lib/matchmaker";
import { connectPeer } from "../lib/webrtc_match";
import { peerMatches } from "../lib/peer_connections";

// How long to accumulate presence events before attempting to pair.
const STABILIZE_MS = 3_000;
// Presence expires after this window — peers older are dropped from the set.
const PRESENCE_TTL_S = 35;
// How often to re-run pairing after the initial attempt.
const REPAIR_MS = 5_000;
// WebRTC handshake timeout before retrying.
const CONNECT_TIMEOUT_MS = 15_000;

function matchId(pubA: string, pubB: string): string {
  const [lo, hi] = pubA < pubB ? [pubA, pubB] : [pubB, pubA];
  return keccak256(toBytes(lo + hi));
}

export function FindHumanButton() {
  const { mode, hydrated } = useAppMode();
  const { address } = useAccount();
  const router = useRouter();

  const { label } = useChaingammonName(address);
  const { elo } = useChaingammonProfile(label);

  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const nostrRef = useRef<NostrMatchClient | null>(null);
  const searchersRef = useRef<Map<string, { s: Searcher; at: number }>>(new Map());
  const connectingRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    connectingRef.current = false;
    nostrRef.current?.stopPresence();
    nostrRef.current?.close();
    nostrRef.current = null;
    searchersRef.current.clear();
    setSearching(false);
    setStatus("");
    setError(null);
  }, []);

  const tryConnect = useCallback(
    (nostr: NostrMatchClient, myElo: number) => {
      if (connectingRef.current) return;

      // Drop stale peers.
      const now = Date.now() / 1000;
      for (const [pk, entry] of searchersRef.current) {
        if (now - entry.at > PRESENCE_TTL_S) searchersRef.current.delete(pk);
      }

      const searchers: Searcher[] = [
        { pubkey: nostr.pubkey, elo: myElo },
        ...Array.from(searchersRef.current.values()).map((e) => e.s),
      ];

      const { partner, isOfferer } = computePairing(nostr.pubkey, searchers);
      if (!partner) {
        setStatus(
          searchersRef.current.size === 0
            ? "Searching… no one else searching yet"
            : `Searching… ${searchersRef.current.size} also searching`,
        );
        return;
      }

      connectingRef.current = true;
      const mid = matchId(nostr.pubkey, partner.pubkey);
      setStatus(`Connecting to opponent…`);

      const peer = connectPeer(nostr, partner.pubkey, mid, isOfferer);
      peerMatches.set(mid, { peer, isOfferer, myNostrPubkey: nostr.pubkey });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        connectingRef.current = false;
        peer.close();
        peerMatches.delete(mid);
        setStatus("Handshake timed out, retrying…");
      }, CONNECT_TIMEOUT_MS);

      peer.onState((s) => {
        if (timedOut) return;
        if (s === "open") {
          clearTimeout(timer);
          nostr.stopPresence();
          router.push(`/play-human?id=${mid}`);
        } else if (s === "failed" || s === "closed") {
          clearTimeout(timer);
          connectingRef.current = false;
          peerMatches.delete(mid);
          setStatus("Connection failed, retrying…");
        }
      });
    },
    [router],
  );

  const startSearching = useCallback(() => {
    setError(null);
    const id = newIdentity();
    const nostr = new NostrMatchClient(id);
    nostrRef.current = nostr;

    const myEloNum = Number(elo ?? "1500") || 1500;

    const content: PresenceContent = {
      ensLabel: label ?? "",
      address: address ?? "",
      sessionPubkey: nostr.pubkey,
      elo: myEloNum,
    };
    nostr.startPresence(content);

    const unsub = nostr.subscribePresence((p, pubkey, at) => {
      const searcher: Searcher = { pubkey, elo: p.elo ?? 1500 };
      searchersRef.current.set(pubkey, { s: searcher, at });
    });

    // Wait for the presence set to stabilize before the first pairing attempt.
    const stabilizeTimer = setTimeout(() => {
      tryConnect(nostr, myEloNum);
    }, STABILIZE_MS);

    // Periodic re-attempt if not yet connected.
    const repairTimer = setInterval(() => {
      if (!connectingRef.current) {
        tryConnect(nostr, myEloNum);
      }
    }, REPAIR_MS);

    cleanupRef.current = () => {
      clearTimeout(stabilizeTimer);
      clearInterval(repairTimer);
      unsub();
    };

    setSearching(true);
    setStatus("Searching for an opponent…");
  }, [address, label, elo, tryConnect]);

  // Cleanup on unmount.
  useEffect(() => () => stop(), [stop]);

  if (!hydrated || mode !== "elo") return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        borderRadius: "var(--cg-radius-lg)",
        border: "1px solid var(--cg-line-1)",
        background: "var(--cg-bg-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={searching ? stop : startSearching}
          className="cg-btn-primary"
        >
          {searching ? "Stop searching" : "Play a human"}
        </button>
        {searching && status && (
          <span
            style={{
              fontSize: 13,
              color: "var(--cg-fg-3)",
              fontFamily: "var(--cg-font-sans)",
            }}
          >
            {status}
          </span>
        )}
      </div>
      {error && (
        <p style={{ fontSize: 12, color: "var(--cg-danger)", margin: 0 }}>{error}</p>
      )}
    </div>
  );
}
