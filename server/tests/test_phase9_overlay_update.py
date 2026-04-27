"""
Phase 9 unit tests for the post-match overlay update rule.

The update is exposure-weighted, outcome-driven, damped reinforcement —
no backprop, no RL infrastructure. Properties tested here are the ones
that justify the design choice:

  - wins reinforce categories the agent leaned into; losses discourage them
  - early matches move the overlay more than late matches (damping)
  - values stay clipped to [-1, 1]
  - the same agent's overlay converges, not diverges, under consistent play
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.agent_overlay import (  # noqa: E402
    CATEGORIES,
    LEARNING_RATE,
    Overlay,
    update_overlay,
)
from app.game_record import MoveEntry  # noqa: E402


def _move(move_str: str, turn: int = 1, dice=(3, 1)) -> MoveEntry:
    return MoveEntry(turn=turn, dice=list(dice), move=move_str)


# --- direction of update: wins reinforce, losses discourage -----------------


def test_winning_match_increases_categories_the_agent_leaned_into():
    o = Overlay.default()
    # Agent built the 5-point twice — should lean into "build_5_point"
    moves = [_move("8/5 6/5"), _move("13/5 11/5")]
    after = update_overlay(o, moves, won=True, match_count=0)
    assert after.values["build_5_point"] > o.values["build_5_point"], (
        "winning while building 5-point should reinforce that category"
    )


def test_losing_match_decreases_categories_the_agent_leaned_into():
    o = Overlay.default()
    moves = [_move("8/5 6/5"), _move("13/5 11/5")]
    after = update_overlay(o, moves, won=False, match_count=0)
    assert after.values["build_5_point"] < o.values["build_5_point"], (
        "losing while building 5-point should discourage that category"
    )


def test_categories_with_zero_exposure_are_unchanged():
    o = Overlay.default()
    o.values["opening_slot"] = 0.3  # pre-existing bias
    moves = [_move("13/8")]  # not a slot opening
    after = update_overlay(o, moves, won=True, match_count=0)
    # opening_slot got no exposure this match, should not move.
    assert after.values["opening_slot"] == pytest.approx(0.3, abs=1e-9)


# --- match_count increments -------------------------------------------------


def test_match_count_increments_by_one_per_update():
    o = Overlay.default()
    after = update_overlay(o, [_move("8/5 6/5")], won=True, match_count=o.match_count)
    assert after.match_count == o.match_count + 1


# --- damping: early matches move more than late matches ---------------------


def test_early_matches_move_overlay_more_than_late_matches():
    """Damping factor alpha = N / (N + match_count). When match_count is
    small alpha is near 1 and the proposed delta lands fully; when
    match_count is large alpha shrinks and individual matches matter less.
    Required so a freak win at match 200 doesn't rewrite years of style."""
    moves = [_move("8/5 6/5") for _ in range(5)]

    early = update_overlay(Overlay.default(), moves, won=True, match_count=0)
    late = update_overlay(Overlay.default(), moves, won=True, match_count=500)

    early_delta = early.values["build_5_point"]
    late_delta = late.values["build_5_point"]
    assert early_delta > late_delta, (
        f"early match should move overlay more (early={early_delta}, late={late_delta})"
    )
    # And the late delta should be small but non-zero.
    assert 0.0 < late_delta < early_delta / 5


# --- bounded: never exceeds [-1, 1] -----------------------------------------


def test_overlay_values_stay_clipped_to_minus_one_one():
    """Repeated wins in the same category must never push values out of
    [-1, 1] — the overlay is a *bias*, not an unbounded score."""
    o = Overlay.default()
    moves = [_move("8/5 6/5") for _ in range(10)]
    for i in range(500):
        o = update_overlay(o, moves, won=True, match_count=i)
    for c in CATEGORIES:
        assert -1.0 <= o.values[c] <= 1.0, f"{c} = {o.values[c]} outside [-1, 1]"


# --- convergence under consistent play --------------------------------------


def test_overlay_converges_under_consistent_winning_style():
    """An agent that always plays the same way and always wins should
    settle on a stable overlay, not oscillate or grow forever."""
    o = Overlay.default()
    moves = [_move("8/5 6/5"), _move("13/11 13/9")]

    history = []
    for i in range(200):
        o = update_overlay(o, moves, won=True, match_count=i)
        history.append(o.values["build_5_point"])

    # Last 30 values should be within a tight band — convergence, not drift.
    tail = history[-30:]
    spread = max(tail) - min(tail)
    assert spread < 0.05, f"overlay didn't settle: tail spread={spread}, tail={tail}"


# --- exposure normalization -------------------------------------------------


def test_exposure_is_normalized_so_total_match_signal_is_bounded():
    """The exposure dict is normalized inside update_overlay, so a match
    with 100 moves doesn't apply 100x more update than a match with 5
    moves of the same character. Match length shouldn't dominate."""
    short = [_move("8/5 6/5")]
    long_match = [_move("8/5 6/5") for _ in range(50)]

    short_after = update_overlay(Overlay.default(), short, won=True, match_count=0)
    long_after = update_overlay(Overlay.default(), long_match, won=True, match_count=0)

    short_delta = short_after.values["build_5_point"]
    long_delta = long_after.values["build_5_point"]
    # Both should be roughly the same (normalization), within an order of magnitude.
    assert abs(short_delta - long_delta) < LEARNING_RATE, (
        f"long match shouldn't apply 50x update: short={short_delta}, long={long_delta}"
    )


# --- empty match: no-op-ish -------------------------------------------------


def test_no_moves_produces_no_update():
    """An empty move list (no agent activity) shouldn't change values
    even on a win — there's nothing to reinforce."""
    o = Overlay.default()
    o.values["opening_slot"] = 0.4
    after = update_overlay(o, [], won=True, match_count=0)
    for c in CATEGORIES:
        assert after.values[c] == pytest.approx(o.values[c], abs=1e-9)
    assert after.match_count == 1  # match still counted
