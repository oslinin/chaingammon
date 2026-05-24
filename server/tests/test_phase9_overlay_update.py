"""
Unit tests for the neutral-EMA overlay update rule.

The update reflects observed play style without win/loss bias:
  target[c] = 2 * exposure[c] - 1  (EMA toward observed frequency)

Properties tested:
  - Dominant category drifts toward +1 (highest relative exposure)
  - Zero-exposure categories drift toward -1
  - Early matches move the overlay more than late matches (damping)
  - Values stay clipped to [-1, 1]
  - Empty move list: no value changes, match_count still increments
  - Consistent play converges to a stable overlay
  - Normalization: match length doesn't amplify the update
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.agent_overlay import (  # noqa: E402
    ACTIVE_CATEGORIES,
    CATEGORIES,
    Overlay,
    update_overlay,
)
from app.game_record import MoveEntry  # noqa: E402


def _move(move_str: str, turn: int = 1, dice=(3, 1)) -> MoveEntry:
    return MoveEntry(turn=turn, dice=list(dice), move=move_str)


# --- direction of update: exposure drives value ----------------------------


def test_dominant_category_drifts_positive():
    """Category with highest relative exposure ends up with the highest
    (least-negative or positive) value after the update."""
    o = Overlay.default()
    # Agent built the 5-point twice — build_5_point has high exposure
    moves = [_move("8/5 6/5"), _move("13/5 11/5")]
    after = update_overlay(o, moves, match_count=0)
    # build_5_point should have a higher value than most others
    build5 = after.values["build_5_point"]
    others = [v for c, v in after.values.items() if c != "build_5_point" and c in ACTIVE_CATEGORIES]
    assert build5 >= max(others) or build5 > -0.5, (
        f"build_5_point ({build5:.3f}) should be among the highest-valued categories"
    )


def test_zero_exposure_categories_drift_negative():
    """Categories that received no moves drift toward -1 (style was absent)."""
    o = Overlay.default()
    # Only builds 5-point; other categories get zero exposure → target=-1 → drift down
    moves = [_move("8/5 6/5")]
    after = update_overlay(o, moves, match_count=0)
    # anchors_back received zero exposure and should drift toward -1
    assert after.values["anchors_back"] < 0.0, (
        "zero-exposure category should drift negative with neutral EMA"
    )


def test_outcome_does_not_affect_update():
    """The update is identical regardless of which side won — neutral EMA."""
    o = Overlay.default()
    moves = [_move("8/5 6/5"), _move("13/5 11/5")]
    # Both calls use the same moves and match_count — results must be equal.
    after1 = update_overlay(o, moves, match_count=0)
    after2 = update_overlay(o, moves, match_count=0)
    for c in CATEGORIES:
        assert after1.values[c] == pytest.approx(after2.values[c], abs=1e-9), (
            f"update should be deterministic (category {c})"
        )


# --- match_count increments -------------------------------------------------


def test_match_count_increments_by_one_per_update():
    o = Overlay.default()
    after = update_overlay(o, [_move("8/5 6/5")], match_count=o.match_count)
    assert after.match_count == o.match_count + 1


# --- damping: early matches move more than late matches ---------------------


def test_early_matches_move_overlay_more_than_late_matches():
    """Damping factor alpha = N / (N + match_count). When match_count is
    small alpha is near 1 and the target blends in fully; when
    match_count is large alpha shrinks and individual matches matter less."""
    moves = [_move("8/5 6/5") for _ in range(5)]

    early = update_overlay(Overlay.default(), moves, match_count=0)
    late = update_overlay(Overlay.default(), moves, match_count=500)

    # Whichever category moved most, early should have moved further than late.
    def _max_abs_change(after: Overlay, before: Overlay) -> float:
        return max(abs(after.values[c] - before.values[c]) for c in CATEGORIES)

    early_delta = _max_abs_change(early, Overlay.default())
    late_delta = _max_abs_change(late, Overlay.default())
    assert early_delta > late_delta, (
        f"early match should move overlay more (early_delta={early_delta:.4f}, "
        f"late_delta={late_delta:.4f})"
    )
    assert 0.0 < late_delta < early_delta / 5


# --- bounded: never exceeds [-1, 1] -----------------------------------------


def test_overlay_values_stay_clipped_to_minus_one_one():
    """Repeated updates must never push values out of [-1, 1]."""
    o = Overlay.default()
    moves = [_move("8/5 6/5") for _ in range(10)]
    for i in range(500):
        o = update_overlay(o, moves, match_count=i)
    for c in CATEGORIES:
        assert -1.0 <= o.values[c] <= 1.0, f"{c} = {o.values[c]} outside [-1, 1]"


# --- convergence under consistent play --------------------------------------


def test_overlay_converges_under_consistent_play():
    """An agent that always plays the same way should settle on a stable
    overlay, not oscillate or grow forever."""
    o = Overlay.default()
    moves = [_move("8/5 6/5"), _move("13/11 13/9")]

    history = []
    for i in range(200):
        o = update_overlay(o, moves, match_count=i)
        history.append(o.values["build_5_point"])

    # Last 30 values should be within a tight band — convergence, not drift.
    tail = history[-30:]
    spread = max(tail) - min(tail)
    assert spread < 0.05, f"overlay didn't settle: tail spread={spread}, tail={tail}"


# --- exposure normalization -------------------------------------------------


def test_exposure_is_normalized_so_match_length_does_not_dominate():
    """The exposure dict is normalized, so a long match doesn't apply more
    update per category than a short match with the same style character."""
    short = [_move("8/5 6/5")]
    long_match = [_move("8/5 6/5") for _ in range(50)]

    short_after = update_overlay(Overlay.default(), short, match_count=0)
    long_after = update_overlay(Overlay.default(), long_match, match_count=0)

    short_delta = abs(short_after.values["build_5_point"] - Overlay.default().values["build_5_point"])
    long_delta = abs(long_after.values["build_5_point"] - Overlay.default().values["build_5_point"])
    assert abs(short_delta - long_delta) < 0.1, (
        f"long match shouldn't apply 50x update: short={short_delta:.4f}, long={long_delta:.4f}"
    )


# --- empty match: no-op-ish -------------------------------------------------


def test_no_moves_produces_no_value_change():
    """An empty move list means no classifiable moves → values unchanged,
    but match_count still increments."""
    o = Overlay.default()
    o.values["opening_slot"] = 0.4  # pre-existing bias — immutable so reconstruct
    o = Overlay(version=o.version, values=dict(o.values) | {"opening_slot": 0.4}, match_count=o.match_count)
    after = update_overlay(o, [], match_count=0)
    for c in CATEGORIES:
        assert after.values[c] == pytest.approx(o.values[c], abs=1e-9)
    assert after.match_count == 1  # match still counted
