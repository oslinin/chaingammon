"""test_phase76_move_tagger.py — unit tests for move_tagger.py.

Phase 76: Chaingammon hackathon MVP collaborative-agent feature.

Tests cover:
  - Blitz tag (multiple hits)
  - Aggressive tag (single hit or dominant equity)
  - Anchor tag (move to points 19-24)
  - Priming tag (extends a consecutive run)
  - Safe tag (default when no other rule fires)
  - tag_candidates returns at most top_n entries
  - tag_candidates handles empty input
  - tag_candidates handles board=None (notation-only path)
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from move_tagger import tag_candidates, _parse_segments, _to_point


# ─── segment / point helpers ─────────────────────────────────────────────────

def test_parse_segments_normal():
    segs = _parse_segments("8/5 6/5")
    assert segs == [("8", "5"), ("6", "5")]


def test_parse_segments_bar_entry():
    segs = _parse_segments("bar/24")
    assert segs == [("bar", "24")]


def test_parse_segments_bearoff():
    segs = _parse_segments("6/off")
    assert segs == [("6", "off")]


def test_parse_segments_hit_star():
    segs = _parse_segments("8/5* 6/5")
    assert segs == [("8", "5"), ("6", "5")]


def test_to_point_normal():
    assert _to_point("8") == 8


def test_to_point_bar():
    assert _to_point("bar") is None


def test_to_point_off():
    assert _to_point("off") is None


# ─── single-candidate tagging ────────────────────────────────────────────────

def _make_cand(move: str, equity: float) -> dict:
    return {"move": move, "equity": equity}


def test_safe_tag_no_board():
    """Default Safe tag when no board is supplied and no anchor/blitz."""
    result = tag_candidates([_make_cand("8/5 6/5", 0.15)], board=None)
    assert len(result) == 1
    assert result[0]["tag"] == "Safe"


def test_aggressive_dominant_equity():
    """Top move is tagged Aggressive when equity gap ≥ 0.15 vs second-best."""
    cands = [_make_cand("8/5 6/5", 0.40), _make_cand("13/10", 0.20)]
    result = tag_candidates(cands)
    assert result[0]["tag"] == "Aggressive"


def test_not_aggressive_when_gap_small():
    """Safe tag when equity gap is < 0.15."""
    cands = [_make_cand("8/5 6/5", 0.30), _make_cand("13/10", 0.22)]
    result = tag_candidates(cands)
    assert result[0]["tag"] == "Safe"


def test_anchor_tag():
    """Move landing on points 19-24 is tagged Anchor."""
    result = tag_candidates([_make_cand("13/20", 0.10)])
    assert result[0]["tag"] == "Anchor"


def test_anchor_deep():
    result = tag_candidates([_make_cand("9/24", -0.05)])
    assert result[0]["tag"] == "Anchor"


def test_blitz_tag_with_board():
    """Move hitting two blots on the board is tagged Blitz."""
    # board[4] = -1 (opponent single at point 5) and board[7] = -1 (point 8)
    board = [0] * 24
    board[4] = -1
    board[7] = -1
    result = tag_candidates([_make_cand("10/5 13/8", 0.20)], board=board)
    assert result[0]["tag"] == "Blitz"
    assert "2" in result[0]["tag_reason"]


def test_aggressive_single_hit_with_board():
    """Move hitting one blot is tagged Aggressive (not Blitz)."""
    board = [0] * 24
    board[4] = -1  # opponent blot at point 5
    result = tag_candidates([_make_cand("10/5 13/9", 0.20)], board=board)
    assert result[0]["tag"] == "Aggressive"


def test_priming_tag_with_board():
    """Move to an interior point already owned by player-0 is tagged Priming."""
    board = [0] * 24
    board[11] = 2  # player-0 already owns point 12
    result = tag_candidates([_make_cand("17/12", 0.15)], board=board)
    assert result[0]["tag"] == "Priming"


def test_priming_not_fired_without_board():
    """Priming rule requires board; falls back to Safe when board is None."""
    result = tag_candidates([_make_cand("17/12", 0.15)], board=None)
    assert result[0]["tag"] == "Safe"


# ─── top_n slicing and bulk tagging ──────────────────────────────────────────

def test_top_n_default_is_5():
    cands = [_make_cand(f"8/{i}", 1.0 - i * 0.1) for i in range(1, 9)]
    result = tag_candidates(cands)
    assert len(result) == 5


def test_top_n_custom():
    cands = [_make_cand(f"8/{i}", 1.0 - i * 0.1) for i in range(1, 9)]
    result = tag_candidates(cands, top_n=3)
    assert len(result) == 3


def test_empty_candidates():
    result = tag_candidates([])
    assert result == []


def test_single_candidate():
    result = tag_candidates([_make_cand("13/10", 0.0)])
    assert len(result) == 1
    assert result[0]["tag"] in {"Safe", "Aggressive", "Priming", "Anchor", "Blitz"}


def test_result_preserves_rank_order():
    cands = [
        _make_cand("8/5 6/5", 0.40),
        _make_cand("13/10", 0.25),
        _make_cand("24/21", 0.10),
    ]
    result = tag_candidates(cands)
    assert result[0]["equity"] >= result[1]["equity"] >= result[2]["equity"]


def test_tag_reason_present():
    result = tag_candidates([_make_cand("8/5 6/5", 0.15)])
    assert "tag_reason" in result[0]
    assert isinstance(result[0]["tag_reason"], str)
