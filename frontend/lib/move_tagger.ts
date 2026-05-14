/**
 * move_tagger.ts — heuristic strategy labels for candidate moves.
 *
 * TypeScript port of agent/move_tagger.py. Assigns human-readable strategy
 * tags to ranked candidates so the Chief of Staff / Agent Teammate panel can
 * speak in strategic terms rather than raw equity numbers.
 *
 * Tags applied in priority order:
 *   Blitz      — hits two or more opponent blots
 *   Aggressive — hits exactly one blot, or dominant equity gap ≥ 0.15
 *   Anchor     — places a checker in the opponent's home board (points 19-24)
 *   Priming    — extends an existing prime (interior point 7-18 already occupied)
 *   Safe       — default when none of the above match
 */

export type MoveTag = "Safe" | "Aggressive" | "Priming" | "Anchor" | "Blitz";

export interface TaggedCandidate {
  move: string;
  equity: number;
  tag: MoveTag;
  tag_reason: string;
}

interface Candidate {
  move: string;
  equity: number;
}

const SEG_RE = /(\bbar\b|\d+)\/(\d+|\boff\b)/gi;

function parseSegments(move: string): Array<[string, string]> {
  const cleaned = move.replace(/\*/g, "");
  const segs: Array<[string, string]> = [];
  SEG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEG_RE.exec(cleaned)) !== null) {
    segs.push([m[1].toLowerCase(), m[2].toLowerCase()]);
  }
  return segs;
}

function toPoint(s: string): number | null {
  if (s === "bar" || s === "off") return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function countHits(move: string, board: number[] | null): number {
  if (!board) return 0;
  let hits = 0;
  for (const [, toS] of parseSegments(move)) {
    const pt = toPoint(toS);
    if (pt === null) continue;
    const idx = pt - 1;
    if (idx >= 0 && idx < board.length && board[idx] === -1) hits++;
  }
  return hits;
}

function isAnchorMove(move: string): boolean {
  for (const [, toS] of parseSegments(move)) {
    const pt = toPoint(toS);
    if (pt !== null && pt >= 19 && pt <= 24) return true;
  }
  return false;
}

function isPrimingMove(move: string, board: number[] | null): boolean {
  if (!board) return false;
  for (const [, toS] of parseSegments(move)) {
    const pt = toPoint(toS);
    if (pt === null) continue;
    if (pt >= 7 && pt <= 18) {
      const idx = pt - 1;
      if (idx >= 0 && idx < board.length && board[idx] > 0) return true;
    }
  }
  return false;
}

function tagOne(candidate: Candidate, board: number[] | null): TaggedCandidate {
  const { move } = candidate;
  const hits = countHits(move, board);

  if (hits >= 2)
    return { ...candidate, tag: "Blitz", tag_reason: `hits ${hits} blots` };
  if (hits === 1)
    return { ...candidate, tag: "Aggressive", tag_reason: "hits an opponent blot" };
  if (isAnchorMove(move))
    return { ...candidate, tag: "Anchor", tag_reason: "establishes a point in opponent's home" };
  if (isPrimingMove(move, board))
    return { ...candidate, tag: "Priming", tag_reason: "extends a prime" };
  return { ...candidate, tag: "Safe", tag_reason: "positional, low blot exposure" };
}

/**
 * Tag the top-N candidates with heuristic strategy labels.
 *
 * @param candidates Ranked list of {move, equity}, best-first (index 0 = highest equity).
 * @param board      Optional 24-element points array (positive = player 0). When null,
 *                   board-dependent rules (hit detection, prime detection) are skipped.
 * @param topN       How many candidates to return (default 5).
 */
export function tagCandidates(
  candidates: Candidate[],
  board: number[] | null = null,
  topN = 5
): TaggedCandidate[] {
  const pool = candidates.slice(0, topN);
  if (pool.length === 0) return [];

  const bestEquity = pool[0].equity;
  const secondEquity = pool.length > 1 ? pool[1].equity : bestEquity - 1;

  return pool.map((cand, rank) => {
    const tc = tagOne(cand, board);
    if (rank === 0 && tc.tag === "Safe" && bestEquity - secondEquity >= 0.15) {
      return {
        ...tc,
        tag: "Aggressive" as MoveTag,
        tag_reason: "dominant equity advantage vs next-best",
      };
    }
    return tc;
  });
}
