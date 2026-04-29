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


def test_snapshot_state_extracts_ids_and_rawboard():
    """snapshot_state pulls IDs from the standard `show board` output
    AND points/bar from the rawboard `board:` line. Both formats must
    appear in stdout (gnubg_service._snapshot emits both)."""
    # Real opening rawboard line for `new match 3` with X (human) on roll.
    rawboard_line = (
        "board:oleg:gnubg:3:0:0:0"
        ":-2:0:0:0:0:5:0:3:0:0:0:-5:5:0:0:0:-3:0:-5:0:0:0:0:2"
        ":0:1:5:2:5:2:1:1:1:0:1:-1:0:25:0:0:0:0:0:0:0:1"
    )
    fake_stdout = (
        "Some preamble...\n"
        f"Position ID: {OPENING_POSITION_ID}\n"
        f"Match ID  : {OPENING_MATCH_ID}\n"
        f"{rawboard_line}\n"
        "Some postamble.\n"
    )
    state = snapshot_state(fake_stdout)
    assert state["position_id"] == OPENING_POSITION_ID
    assert state["match_id"] == OPENING_MATCH_ID
    assert state["board"] == [
        -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5,
        5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2,
    ]
    assert state["bar"] == [0, 0]
    assert state["off"] == [0, 0]
    assert state["match_length"] == 3
    assert state["game_over"] is False
    assert state["winner"] is None


def test_snapshot_state_uses_rawboard_for_post_move_state():
    """When position_id is encoded perspective-relative (the bug we
    fixed by switching to rawboard), our pure-Python decode_position_id
    returns wrong values. snapshot_state must trust rawboard, not
    decode_position_id."""
    # Real post-agent-move state captured from gnubg session:
    # human played 8/5 6/5 then agent played 24/14.
    rawboard_line = (
        "board:oleg:gnubg:3:0:0:0"
        ":-1:0:0:0:2:4:0:2:0:0:-1:-5:5:0:0:0:-3:0:-5:0:0:0:0:2"
        ":0:1:0:0:0:0:1:1:1:0:1:-1:0:25:0:0:0:0:0:0:0:1"
    )
    fake_stdout = (
        "Position ID: 4HPwBSCwZ/ABMA\n"
        "Match ID  : cAlgAAAAAAAE\n"
        f"{rawboard_line}\n"
    )
    state = snapshot_state(fake_stdout)
    # Authoritative human-perspective board from rawboard:
    assert state["board"] == [
        -1, 0, 0, 0, 2, 4, 0, 2, 0, 0, -1, -5,
        5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2,
    ]
    # decode_position_id of "4HPwBSCwZ/ABMA" returns the wrong board
    # (perspective-relative quirk). If snapshot_state ever falls back
    # to decode_position_id, this assertion fails immediately.
    from gnubg_state import decode_position_id
    wrong_board, _, _ = decode_position_id("4HPwBSCwZ/ABMA")
    assert wrong_board != state["board"]


def test_snapshot_state_raises_when_ids_missing():
    with pytest.raises(ValueError, match="position id"):
        snapshot_state("gnubg banner with no id at all")


def test_snapshot_state_raises_when_rawboard_missing():
    fake_stdout = (
        f"Position ID: {OPENING_POSITION_ID}\n"
        f"Match ID  : {OPENING_MATCH_ID}\n"
        # No rawboard line.
    )
    with pytest.raises(ValueError, match="rawboard"):
        snapshot_state(fake_stdout)
