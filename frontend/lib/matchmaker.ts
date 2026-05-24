// matchmaker.ts — pure, deterministic ELO-biased pairing for serverless,
// one-press auto-matchmaking.
//
// Every searcher runs `computePairing` over the SAME observed set of searchers
// and gets a consistent answer — who am I paired with, and am I the WebRTC
// offerer — with no server deciding. Searchers are sorted by ELO (tiebreak by
// ephemeral pubkey) and paired in adjacent blocks of two: (0,1),(2,3),… so each
// player meets an ELO-neighbour (skill bias). Within a pair the lower pubkey is
// the offerer, which removes WebRTC glare. A trailing odd searcher has no
// partner yet and keeps waiting until another joins.
//
// Determinism is the whole point: two peers that observe the same set compute
// each other as partners and agree on roles. Set churn (someone joins/leaves)
// is handled by the caller — act after a short stabilization window and
// re-derive on handshake failure/timeout.

export interface Searcher {
  /** Ephemeral per-session Nostr pubkey (hex), unique per searching session. */
  pubkey: string;
  /** ENS ELO; callers should verify this against the ENS record (anti-sandbag). */
  elo: number;
}

export interface Pairing {
  /** My partner this round, or null if I'm the odd one out / alone. */
  partner: Searcher | null;
  /** Within the pair, the lower-pubkey peer offers; true ⇒ I create the offer. */
  isOfferer: boolean;
}

/** ELO ascending, tiebreak pubkey ascending → a total, stable order. */
function sortSearchers(searchers: Searcher[]): Searcher[] {
  return searchers.slice().sort((a, b) => {
    if (a.elo !== b.elo) return a.elo - b.elo;
    if (a.pubkey < b.pubkey) return -1;
    if (a.pubkey > b.pubkey) return 1;
    return 0;
  });
}

/**
 * Compute my pairing from my pubkey and the full searcher set (including me).
 * Returns `partner: null` if I'm not in the set or I'm the trailing odd one.
 */
export function computePairing(myPubkey: string, searchers: Searcher[]): Pairing {
  const sorted = sortSearchers(searchers);
  const i = sorted.findIndex((s) => s.pubkey === myPubkey);
  if (i < 0) return { partner: null, isOfferer: false };

  // Block-of-two neighbour: even index pairs with i+1, odd with i-1.
  const j = i % 2 === 0 ? i + 1 : i - 1;
  const partner = sorted[j] ?? null;
  if (!partner) return { partner: null, isOfferer: false };

  return { partner, isOfferer: myPubkey < partner.pubkey };
}
