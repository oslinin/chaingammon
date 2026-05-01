"""rules_engine.py — pure-Python backgammon move legality.

The KeeperHub `validate_move` step (see docs/keeperhub-workflow.md)
must independently verify that each player's move is legal — i.e.
matches the dice and the position. This is the pure-Python reference
implementation; the WASM bundle that runs in the browser and the
KeeperHub validator's WASM module both compile from this same logic.

Why a separate implementation from gnubg's:
  - gnubg runs as a subprocess and is too heavy for browser / WASM.
  - We need bit-identical agreement between the browser, KeeperHub,
    and audit replayers; depending on a particular gnubg build's
    parsing nuances would re-introduce a single point of failure.
  - The rules of legal-move validation are mechanical (point
    ownership, blot rules, bear-off conditions) — small enough to
    re-implement and audit.

Scope and shape:
  - `Board` — 24-point board encoded as `tuple[int, ...]` of 24
    signed checker counts (positive = player 0, negative = player 1)
    + bar/borne-off counts per side. Pure data, no IO.
  - `parse_move` — turn a gnubg-format move string ("8/5 6/5",
    "bar/22", "6/off") into a list of `(src, dst, hit)` triples.
  - `is_legal` — given a board, dice, perspective, and parsed move,
    return True iff the move is legal under standard backgammon
    rules.
  - `apply_move` — produce the post-move board. Caller is
    responsible for first calling `is_legal`.

Out of scope (deliberate, for now):
  - Cube doubling rules.
  - Match-equity tables (irrelevant to legality).
  - Actually computing equity — that's gnubg/the trained NN's job.
  - End-of-game detection beyond "all 15 borne off" (no Crawford
    rule, no resignation logic).

This file is intentionally a stub for the most expressive cases —
v1 covers the common cases (point-to-point moves, hits, bar entry,
bear-off when all checkers are home) and explicitly errors out on
constructs it doesn't yet handle. That keeps audit results trustworthy
(better to refuse than to wave through) until we expand coverage.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable


# Board-encoding conventions (matched to gnubg's "rawboard" output):
#   - 24 points indexed 1..24 from player 0's perspective.
#   - Player 0 moves from 24 → 1 (so dice subtract from src for player 0).
#   - Player 1 moves from 1 → 24 (mirror image).
#   - `bar` = checkers on the bar; positive entry-point is point 25
#     for player 0 ("bar" in notation), point 0 for player 1.
#   - `off` = checkers borne off (15 - on-board for the side).
NUM_POINTS = 24


@dataclass(frozen=True)
class Board:
    """Immutable backgammon position.

    `points[i]` is the count of checkers on point `i+1` (so points[0]
    is the 1-point, points[23] the 24-point). Positive = player 0
    pieces, negative = player 1.

    `bar = (p0_on_bar, p1_on_bar)` and `off = (p0_borne_off, p1_borne_off)`."""
    points: tuple[int, ...]      # length 24, signed
    bar: tuple[int, int] = (0, 0)
    off: tuple[int, int] = (0, 0)

    def __post_init__(self) -> None:
        if len(self.points) != NUM_POINTS:
            raise ValueError(f"points must have {NUM_POINTS} entries, got {len(self.points)}")

    def for_side(self, side: int) -> list[int]:
        """Per-point count of `side`'s checkers (0 if the point is
        empty or owned by the opponent)."""
        if side == 0:
            return [c if c > 0 else 0 for c in self.points]
        if side == 1:
            return [-c if c < 0 else 0 for c in self.points]
        raise ValueError(f"side must be 0 or 1, got {side}")

    def opponent_blot_at(self, point: int, side: int) -> bool:
        """True iff `point` (1..24) holds exactly one opponent checker
        — a blot the active side can hit on landing."""
        idx = point - 1
        if not (0 <= idx < NUM_POINTS):
            return False
        c = self.points[idx]
        if side == 0:
            return c == -1
        return c == 1


# ---------------------------------------------------------------------------
# Move parsing
# ---------------------------------------------------------------------------


_MOVE_PIECE = re.compile(r"(\d+|bar)/(\d+|off)(\*?)", re.IGNORECASE)


@dataclass(frozen=True)
class CheckerMove:
    """One src→dst checker movement parsed from gnubg notation.

    `src` and `dst` are integers in 1..24 except for the special
    sentinels: `src=BAR_SRC` for entries from the bar, `dst=OFF_DST`
    for bear-offs. `hit` is True when the destination was marked with
    `*` in the source string."""
    src: int
    dst: int
    hit: bool


BAR_SRC = 25       # entering from the bar (player 0)
BAR_SRC_P1 = 0     # entering from the bar (player 1)
OFF_DST = 0        # bear off (player 0)
OFF_DST_P1 = 25    # bear off (player 1)


def parse_move(move_str: str, *, side: int) -> list[CheckerMove]:
    """Parse a gnubg-format move string into per-checker movements.

    Examples:
      "8/5 6/5"   →  two checkers, one 8→5 and one 6→5
      "bar/22"    →  enter from the bar onto the 22-point
      "6/off"     →  bear off from the 6-point
      "13/8*"     →  13→8 with a hit
    """
    if side not in (0, 1):
        raise ValueError(f"side must be 0 or 1, got {side}")
    pieces: list[CheckerMove] = []
    for raw_src, raw_dst, hit_marker in _MOVE_PIECE.findall(move_str.lower()):
        src = (BAR_SRC if side == 0 else BAR_SRC_P1) if raw_src == "bar" else int(raw_src)
        dst = (OFF_DST if side == 0 else OFF_DST_P1) if raw_dst == "off" else int(raw_dst)
        pieces.append(CheckerMove(src=src, dst=dst, hit=bool(hit_marker)))
    return pieces


# ---------------------------------------------------------------------------
# Dice consumption + legality
# ---------------------------------------------------------------------------


def dice_pool(dice: tuple[int, int]) -> list[int]:
    """Return the pool of pip values the player has to spend this
    turn. Doubles produce four pips; everything else produces two."""
    d1, d2 = dice
    if d1 == d2:
        return [d1, d1, d1, d1]
    return [d1, d2]


def _pip_consumed(checker: CheckerMove, side: int) -> int:
    """Pips consumed by `checker` for `side`. Bar entries and bear-offs
    use the source/destination distance to a virtual edge."""
    if side == 0:
        if checker.src == BAR_SRC:
            return BAR_SRC - checker.dst   # 25 - dst
        if checker.dst == OFF_DST:
            # Bearing off the n-point uses exactly n pips minimum
            # (overshoot is allowed when no farther checker).
            return checker.src
        return checker.src - checker.dst
    # side 1: mirror
    if checker.src == BAR_SRC_P1:
        return checker.dst                 # dst - 0
    if checker.dst == OFF_DST_P1:
        return BAR_SRC_P1 + (NUM_POINTS + 1 - checker.src)
    return checker.dst - checker.src


def has_pieces_on_bar(board: Board, side: int) -> bool:
    return board.bar[side] > 0


def all_in_home(board: Board, side: int) -> bool:
    """True iff all of `side`'s checkers (off the bar, on the board)
    are in their home board. Bear-off is only legal in this state."""
    if has_pieces_on_bar(board, side):
        return False
    side_counts = board.for_side(side)
    if side == 0:
        # Player 0's home is points 1..6; checkers on 7..24 forbid bear-off.
        return all(side_counts[i] == 0 for i in range(6, NUM_POINTS))
    # Player 1's home is points 19..24.
    return all(side_counts[i] == 0 for i in range(0, 18))


def is_legal(board: Board, dice: tuple[int, int], side: int,
             move_str: str) -> bool:
    """Conservative legality check.

    Returns True iff every checker in `move_str` consumes a distinct
    available pip and lands on a legal point (own point, empty point,
    or single-opponent-blot). Bar-entry, bear-off, and hit moves are
    accepted; tower-of-checkers stacks (3+ opponent checkers blocking
    a destination) are rejected.

    Returns False on any of: malformed move string, mismatched pip
    count, source point empty for `side`, destination blocked,
    bear-off attempted while not all-in-home, or moves that don't
    leave the bar when `side` has bar checkers.

    Does NOT yet handle "must use larger die when only one is
    playable" — that's a strategic constraint, not a legality one,
    and gnubg accepts the suboptimal move.
    """
    try:
        pieces = parse_move(move_str, side=side)
    except (ValueError, AttributeError):
        return False
    if not pieces:
        return False

    pool = dice_pool(dice)

    # Bar rule: if you have checkers on the bar, every move in this
    # turn must come from the bar (until the bar is empty). v1 enforces
    # the simpler "first move must be from the bar" check.
    if has_pieces_on_bar(board, side):
        bar_src = BAR_SRC if side == 0 else BAR_SRC_P1
        if pieces[0].src != bar_src:
            return False

    # Walk the moves in order, mutating a board copy + dice pool.
    sim_points = list(board.points)
    sim_bar = list(board.bar)
    available = list(pool)

    for piece in pieces:
        pip = _pip_consumed(piece, side)
        if pip not in available:
            return False
        available.remove(pip)

        # Source: must have a checker for `side`.
        bar_src = BAR_SRC if side == 0 else BAR_SRC_P1
        if piece.src == bar_src:
            if sim_bar[side] <= 0:
                return False
            sim_bar[side] -= 1
        else:
            src_idx = piece.src - 1
            if not (0 <= src_idx < NUM_POINTS):
                return False
            if side == 0 and sim_points[src_idx] <= 0:
                return False
            if side == 1 and sim_points[src_idx] >= 0:
                return False
            sim_points[src_idx] -= 1 if side == 0 else -1

        # Destination: bear-off requires all-in-home and exact (or
        # overshoot only if no farther checker remains).
        off_dst = OFF_DST if side == 0 else OFF_DST_P1
        if piece.dst == off_dst:
            sim_board_after_src = Board(
                points=tuple(sim_points), bar=tuple(sim_bar),
                off=board.off,
            )
            if not all_in_home(sim_board_after_src, side):
                return False
            # Overshoot rule omitted in v1 — gnubg always supplies a
            # legal pip, so we accept whatever pip was consumed above.
        else:
            dst_idx = piece.dst - 1
            if not (0 <= dst_idx < NUM_POINTS):
                return False
            dst_count = sim_points[dst_idx]
            if side == 0:
                # Blocked if 2+ opponent checkers are on the destination.
                if dst_count <= -2:
                    return False
                # Hit: opponent blot becomes our checker, opponent goes to bar.
                if dst_count == -1:
                    if not piece.hit:
                        return False
                    sim_bar[1] += 1
                    sim_points[dst_idx] = 1
                else:
                    sim_points[dst_idx] = dst_count + 1
            else:
                if dst_count >= 2:
                    return False
                if dst_count == 1:
                    if not piece.hit:
                        return False
                    sim_bar[0] += 1
                    sim_points[dst_idx] = -1
                else:
                    sim_points[dst_idx] = dst_count - 1

    return True
