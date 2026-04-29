"""Tests for gnubg_state.py — pure bit-unpacking decoders.

The fixtures below come from the gnubg opening position used everywhere
else in this repo (a fresh `new match 3`). If gnubg's encoding ever
changes, these tests fail loudly. Position/match id pairs were captured
from a real `new match 3` session — see also
`agent/tests/test_gnubg_service.py::OPENING_*`.
"""
import pytest

from gnubg_state import decode_match_id, decode_position_id, snapshot_state


# Captured from a real `new match 3` session in gnubg. The position id
# is the standard backgammon opening (independent of match length); the
# match id encodes match_length=3, score=[0,0], game_over=False.
OPENING_POSITION_ID = "4HPwATDgc/ABMA"
OPENING_MATCH_ID = "cAllAAAAAAAE"


def test_decode_position_id_returns_24_signed_points():
    board, bar, off = decode_position_id(OPENING_POSITION_ID)
    assert len(board) == 24
    # Standard backgammon opening totals.
    assert sum(c for c in board if c > 0) + bar[0] + off[0] == 15
    assert -sum(c for c in board if c < 0) + bar[1] + off[1] == 15
    # Both bars start empty.
    assert bar == [0, 0]


def test_decode_match_id_initial_state():
    info = decode_match_id(OPENING_MATCH_ID)
    assert info["match_length"] == 3
    assert info["score"] == [0, 0]
    assert info["game_over"] is False


def test_snapshot_state_extracts_ids_from_gnubg_output():
    fake_stdout = (
        "Some preamble...\n"
        f"Position ID: {OPENING_POSITION_ID}\n"
        f"Match ID  : {OPENING_MATCH_ID}\n"
        "Some postamble.\n"
    )
    state = snapshot_state(fake_stdout)
    assert state["position_id"] == OPENING_POSITION_ID
    assert state["match_id"] == OPENING_MATCH_ID
    assert len(state["board"]) == 24
    assert state["match_length"] == 3
    assert state["game_over"] is False
    assert state["winner"] is None


def test_snapshot_state_raises_when_ids_missing():
    with pytest.raises(ValueError, match="position id"):
        snapshot_state("gnubg banner with no id at all")
