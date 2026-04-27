"""
Phase 9 unit tests for `classify_move` and `apply_overlay`.

`classify_move` reads a gnubg-format move string and returns a dict of
`category → score in [0, 1]`. v1 uses hand-coded heuristics — they don't
need to be tactically correct, they need to be deterministic and
distinguish moves with different characters so the overlay update has
real signal.

`apply_overlay` re-ranks gnubg's candidate moves by `gnubg_equity +
sum(v[c] * classifier_c(move))`. Two agents with different overlays
should pick different moves on the same set of candidates.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.agent_overlay import (  # noqa: E402
    CATEGORIES,
    Overlay,
    apply_overlay,
    classify_move,
)
from app.game_record import MoveEntry  # noqa: E402


def _m(move_str: str) -> MoveEntry:
    return MoveEntry(turn=1, dice=[3, 1], move=move_str)


# --- classify_move shape ----------------------------------------------------


def test_classify_returns_score_for_every_category():
    scores = classify_move(_m("8/5 6/5"))
    assert set(scores.keys()) == set(CATEGORIES)
    for c, score in scores.items():
        assert 0.0 <= score <= 1.0, f"{c} score {score} outside [0, 1]"


def test_classify_is_deterministic():
    a = classify_move(_m("8/5 6/5"))
    b = classify_move(_m("8/5 6/5"))
    assert a == b


# --- distinguishing moves: different moves get different signatures ---------


def test_different_moves_produce_different_signatures():
    """The whole point of the classifier is to separate moves into
    categories. Three structurally-different moves should produce three
    different score dicts."""
    a = classify_move(_m("8/5 6/5"))   # builds the 5-point
    b = classify_move(_m("24/22 24/20"))  # back checkers running
    c = classify_move(_m("6/off 5/off"))  # bear-off
    assert a != b
    assert b != c
    assert a != c


def test_build_5_point_move_scores_in_build_5_point_category():
    scores = classify_move(_m("8/5 6/5"))
    assert scores["build_5_point"] > 0, "8/5 6/5 should score in build_5_point"


def test_bearoff_move_scores_in_bearoff_efficient():
    scores = classify_move(_m("6/off 5/off"))
    assert scores["bearoff_efficient"] > 0, "moves to off should score in bearoff"


def test_running_back_checker_scores_in_runs_back_checker():
    scores = classify_move(_m("24/22 24/20"))
    assert scores["runs_back_checker"] > 0, "moves from 24 should score in runs_back_checker"


def test_hit_move_scores_in_hits_blot():
    scores = classify_move(_m("13/8* 6/4"))
    assert scores["hits_blot"] > 0, "* in move should score in hits_blot"


def test_unrelated_categories_score_zero():
    """A pure bear-off move shouldn't accidentally light up
    runs_back_checker or hits_blot."""
    scores = classify_move(_m("6/off 5/off"))
    assert scores["runs_back_checker"] == 0
    assert scores["hits_blot"] == 0


# --- apply_overlay re-ranking ------------------------------------------------


CANDIDATES = [
    {"move": "8/5 6/5", "equity": 0.10},   # build 5-point
    {"move": "13/8 13/9", "equity": 0.09},  # neutral middle-game move
    {"move": "24/22 24/20", "equity": 0.08},  # run back checkers
]


def test_apply_overlay_with_zero_overlay_picks_top_equity():
    """No bias → gnubg's ordering wins. (Important fallback property:
    a fresh agent with all-zero overlay plays exactly like vanilla gnubg.)"""
    ranked = apply_overlay(CANDIDATES, Overlay.default())
    assert ranked[0]["move"] == "8/5 6/5"


def test_apply_overlay_with_negative_5_point_bias_demotes_5_point_moves():
    """An agent that has *un*learned 5-point play (heavy negative bias)
    should pick a non-5-point move even when gnubg ranks 5-point first."""
    o = Overlay.default()
    o.values["build_5_point"] = -1.0  # max negative bias
    ranked = apply_overlay(CANDIDATES, o)
    assert ranked[0]["move"] != "8/5 6/5", (
        f"agent with build_5_point=-1 should not pick 8/5 6/5; got {ranked[0]['move']}"
    )


def test_apply_overlay_with_positive_back_checker_bias_picks_running_move():
    """An agent that has learned to favour running back checkers should
    pick the running move even when gnubg's equity puts it third."""
    o = Overlay.default()
    o.values["runs_back_checker"] = 1.0
    ranked = apply_overlay(CANDIDATES, o)
    assert ranked[0]["move"] == "24/22 24/20", (
        f"agent with runs_back_checker=1 should pick 24/22 24/20; got {ranked[0]['move']}"
    )


def test_apply_overlay_returns_all_candidates():
    """re-ranked, not filtered — apply_overlay must preserve every input
    candidate so callers can inspect the full ordering."""
    o = Overlay.default()
    o.values["build_5_point"] = 0.5
    ranked = apply_overlay(CANDIDATES, o)
    assert len(ranked) == len(CANDIDATES)
    assert {r["move"] for r in ranked} == {c["move"] for c in CANDIDATES}


def test_two_agents_with_different_overlays_pick_different_moves():
    """The keystone property — two iNFTs with the same gnubg base but
    different learned overlays produce different play. This is what
    makes the iNFT meaningful as an asset rather than a label."""
    a = Overlay.default()
    a.values["build_5_point"] = 0.8

    b = Overlay.default()
    b.values["runs_back_checker"] = 0.8

    pick_a = apply_overlay(CANDIDATES, a)[0]["move"]
    pick_b = apply_overlay(CANDIDATES, b)[0]["move"]
    assert pick_a != pick_b
