"""move_tagger.py — heuristic labels for gnubg candidate moves.

Phase 76: Chaingammon hackathon MVP collaborative-agent feature. Assigns
human-readable strategy tags to ranked gnubg candidates so the LLM
"Chief of Staff" can speak in strategic terms (Safe, Aggressive, …)
rather than raw equity numbers.

Tags are intentionally simple heuristics derived from the move notation
string and the equity values — no neural-net pass required.  The batch
logic evaluates all candidates in one Python pass, mirroring a
single-pass batched evaluation.

Public API
----------
- `MoveTag`              — string literal type for the five tags
- `TaggedCandidate`      — {"move", "equity", "tag", "tag_reason"}
- `tag_candidates(candidates, board)` — tag a ranked candidate list

Heuristic rules (applied in priority order)
--------------------------------------------
1. **Blitz** — move hits two or more opponent blots (aggressive multi-hit)
2. **Aggressive** — move hits exactly one opponent blot, or the equity
   advantage over the 2nd-best move is ≥ 0.15 (dominant choice)
3. **Anchor** — move places a checker on points 1-6 of the opponent's
   home board (points 19-24 in gnubg's human-perspective notation)
4. **Priming** — move builds toward a prime: places a checker on a
   consecutive interior point (7-18) already occupied by the mover
5. **Safe** — default tag when none of the above patterns match

When `board` is supplied (list[int], index = point-1, positive = p0,
negative = p1) the tagger also checks the destination point for
board-state validation.  Board is optional — notation-only rules still
fire when it is None.
"""

from __future__ import annotations

import re
from typing import Literal, Optional

MoveTag = Literal["Safe", "Aggressive", "Priming", "Anchor", "Blitz"]

# One result entry coming out of tag_candidates.
TaggedCandidate = dict  # {"move": str, "equity": float, "tag": MoveTag, "tag_reason": str}

# gnubg move segment pattern: "from/to", e.g. "8/5", "bar/24", "6/off"
_SEG_RE = re.compile(r"(\bbar\b|\d+)/(\d+|\boff\b)", re.IGNORECASE)


def _parse_segments(move: str) -> list[tuple[str, str]]:
    """Return list of (from, to) string pairs from a gnubg move notation.

    Handles normal moves ("8/5 6/5"), bar entries ("bar/24"),
    and bear-offs ("6/off").  Ignores starred hit markers ("*") that
    gnubg appends to hits in some output formats.
    """
    cleaned = move.replace("*", "")
    return [(m.group(1).lower(), m.group(2).lower()) for m in _SEG_RE.finditer(cleaned)]


def _to_point(s: str) -> Optional[int]:
    """Convert a from/to string to a board point number (1-24), or None
    for "bar" / "off"."""
    if s in ("bar", "off"):
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _count_hits(move: str, board: Optional[list[int]]) -> int:
    """Count how many segments in `move` land on a point occupied by
    exactly one opponent checker (a blot).  Requires `board` to check
    occupancy; returns 0 when board is None.
    """
    if board is None:
        return 0
    hits = 0
    for _from_s, to_s in _parse_segments(move):
        to_pt = _to_point(to_s)
        if to_pt is None:
            continue
        idx = to_pt - 1
        if 0 <= idx < len(board) and board[idx] == -1:
            hits += 1
    return hits


def _is_anchor_move(move: str) -> bool:
    """Return True if any segment lands on points 19-24 (opponent home board).

    Anchoring in the opponent's home board (deep anchors at 20-24, or
    the standard 5-point / bar-point at 20/21) is a key positional
    strategy — landing anywhere in this zone qualifies.
    """
    for _from_s, to_s in _parse_segments(move):
        to_pt = _to_point(to_s)
        if to_pt is not None and 19 <= to_pt <= 24:
            return True
    return False


def _is_priming_move(move: str, board: Optional[list[int]]) -> bool:
    """Return True if the move extends a prime: a segment lands on an
    interior point (7-18) that is already occupied by a player-0 checker.

    The prime is being *built* rather than merely *advanced* — we check
    the board state *before* the move so we see what was already there.
    Falls back to False when board is None.
    """
    if board is None:
        return False
    for _from_s, to_s in _parse_segments(move):
        to_pt = _to_point(to_s)
        if to_pt is None:
            continue
        if 7 <= to_pt <= 18:
            idx = to_pt - 1
            if 0 <= idx < len(board) and board[idx] > 0:
                return True
    return False


def _tag_one(
    candidate: dict,
    board: Optional[list[int]],
) -> TaggedCandidate:
    """Apply priority-ordered heuristics to a single candidate and
    return an enriched dict with "tag" and "tag_reason" keys.

    The dominant-equity Aggressive override (rank-0, gap ≥ 0.15) is
    handled in tag_candidates after all candidates are tagged, because
    the second-best equity is only known at that level.
    """
    move = candidate["move"]

    hits = _count_hits(move, board)
    if hits >= 2:
        return {**candidate, "tag": "Blitz", "tag_reason": f"hits {hits} blots"}

    if hits == 1:
        return {**candidate, "tag": "Aggressive", "tag_reason": "hits an opponent blot"}

    if _is_anchor_move(move):
        return {**candidate, "tag": "Anchor", "tag_reason": "establishes a point in opponent's home"}

    if _is_priming_move(move, board):
        return {**candidate, "tag": "Priming", "tag_reason": "extends a prime"}

    return {**candidate, "tag": "Safe", "tag_reason": "positional, low blot exposure"}


def tag_candidates(
    candidates: list[dict],
    board: Optional[list[int]] = None,
    *,
    top_n: int = 5,
) -> list[TaggedCandidate]:
    """Tag the top-N gnubg candidates with heuristic strategy labels.

    This is the main entry point.  All candidates are evaluated in a
    single Python pass (O(N) — analogous to a batched forward pass).

    Parameters
    ----------
    candidates : list[dict]
        Ranked list of {"move": str, "equity": float} as returned by
        gnubg_service /evaluate.  Must be sorted best-first (index 0 =
        highest equity).
    board : list[int] | None
        Current board state (24 elements, index = point-1, positive =
        player-0).  When None the board-dependent rules (hit detection,
        prime detection) are skipped; notation-only rules still run.
    top_n : int
        How many candidates to return (default 5).

    Returns
    -------
    list[TaggedCandidate]
        Tagged candidates, preserving rank order, length ≤ top_n.
    """
    pool = candidates[:top_n]
    if not pool:
        return []

    best_equity = pool[0]["equity"] if pool else 0.0
    second_equity = pool[1]["equity"] if len(pool) > 1 else best_equity - 1.0

    tagged: list[TaggedCandidate] = []
    for rank, cand in enumerate(pool):
        tc = _tag_one(cand, board)
        # Override with Aggressive when the top move has a dominant equity gap ≥ 0.15
        # and was not already tagged Blitz.
        if rank == 0 and tc["tag"] == "Safe" and (best_equity - second_equity) >= 0.15:
            tc = {**tc, "tag": "Aggressive", "tag_reason": "dominant equity advantage vs next-best"}
        tagged.append(tc)

    return tagged
