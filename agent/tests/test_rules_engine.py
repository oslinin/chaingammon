"""Tests for rules_engine.py.

Run with:  cd agent && uv run pytest tests/test_rules_engine.py -v

The rules engine is the validator KeeperHub's `validate_move` step
relies on (see docs/keeperhub-workflow.md). Wrong answers here would
either accept cheating moves on-chain or refuse legitimate gameplay,
so coverage focuses on the boundary cases.
"""
from __future__ import annotations

import pytest

from rules_engine import (
    BAR_SRC,
    NUM_POINTS,
    OFF_DST,
    Board,
    CheckerMove,
    OPENING_BOARD,
    all_in_home,
    apply_move,
    dice_pool,
    has_pieces_on_bar,
    is_legal,
    parse_move,
)


# ---------------------------------------------------------------------------
# parse_move
# ---------------------------------------------------------------------------


def test_parse_basic_two_checker_move():
    moves = parse_move("8/5 6/5", side=0)
    assert moves == [
        CheckerMove(src=8, dst=5, hit=False),
        CheckerMove(src=6, dst=5, hit=False),
    ]


def test_parse_bar_entry():
    moves = parse_move("bar/22", side=0)
    assert len(moves) == 1
    assert moves[0].src == BAR_SRC
    assert moves[0].dst == 22


def test_parse_bear_off():
    moves = parse_move("6/off", side=0)
    assert len(moves) == 1
    assert moves[0].src == 6
    assert moves[0].dst == OFF_DST


def test_parse_hit_marker():
    moves = parse_move("13/8*", side=0)
    assert len(moves) == 1 and moves[0].hit


def test_parse_invalid_side_raises():
    with pytest.raises(ValueError):
        parse_move("8/5", side=2)


# ---------------------------------------------------------------------------
# dice_pool
# ---------------------------------------------------------------------------


def test_dice_pool_normal_roll():
    assert dice_pool((3, 5)) == [3, 5]


def test_dice_pool_doubles_yield_four_pips():
    assert dice_pool((4, 4)) == [4, 4, 4, 4]


# ---------------------------------------------------------------------------
# Board helpers
# ---------------------------------------------------------------------------


def test_board_rejects_wrong_length_points():
    with pytest.raises(ValueError):
        Board(points=tuple([0] * 10))


def _starting_board() -> Board:
    """Standard backgammon starting position from player 0's perspective."""
    pts = [0] * NUM_POINTS
    pts[5] = 5      # 6-point: 5 player-0 checkers
    pts[7] = 3      # 8-point: 3 player-0 checkers
    pts[12] = 5     # 13-point: 5 player-0 checkers
    pts[23] = 2     # 24-point: 2 player-0 checkers
    pts[18] = -5    # 19-point: 5 player-1 checkers
    pts[16] = -3    # 17-point: 3 player-1 checkers
    pts[11] = -5    # 12-point: 5 player-1 checkers
    pts[0] = -2     # 1-point: 2 player-1 checkers
    return Board(points=tuple(pts))


def test_starting_board_for_side():
    b = _starting_board()
    p0 = b.for_side(0)
    p1 = b.for_side(1)
    assert sum(p0) == 15
    assert sum(p1) == 15


def test_opponent_blot_detection():
    pts = [0] * NUM_POINTS
    pts[7] = -1      # opponent blot on the 8-point
    b = Board(points=tuple(pts))
    assert b.opponent_blot_at(8, side=0)
    assert not b.opponent_blot_at(8, side=1)


def test_all_in_home_false_at_start():
    assert not all_in_home(_starting_board(), side=0)


def test_all_in_home_true_when_all_in_home_board():
    pts = [0] * NUM_POINTS
    pts[5] = 15  # all 15 on the 6-point
    assert all_in_home(Board(points=tuple(pts)), side=0)


def test_all_in_home_false_when_bar_nonempty():
    pts = [0] * NUM_POINTS
    pts[5] = 14
    b = Board(points=tuple(pts), bar=(1, 0))
    assert not all_in_home(b, side=0)


# ---------------------------------------------------------------------------
# is_legal — happy path
# ---------------------------------------------------------------------------


def test_legal_opening_8_5_6_5():
    """Classic 3-1 split: 8/5 6/5 makes the 5-point. Both pips used."""
    assert is_legal(_starting_board(), dice=(3, 1), side=0,
                    move_str="8/5 6/5")


def test_legal_simple_one_pip_move():
    """Just 13/11 with a 4-2 roll consumes the 2; remaining 4 unused
    (legality is per-checker; remainder isn't enforced here)."""
    assert is_legal(_starting_board(), dice=(4, 2), side=0,
                    move_str="13/11")


# ---------------------------------------------------------------------------
# is_legal — illegal cases
# ---------------------------------------------------------------------------


def test_illegal_pip_not_in_dice():
    """Trying to move 8/3 (5 pips) on a 3-1 roll is illegal."""
    assert not is_legal(_starting_board(), dice=(3, 1), side=0,
                        move_str="8/3")


def test_illegal_blocked_destination():
    """The 19-point starts blocked by 5 player-1 checkers — player 0
    cannot land there."""
    assert not is_legal(_starting_board(), dice=(5, 5), side=0,
                        move_str="24/19")


def test_illegal_source_empty():
    """Player 0 has no checkers on the 4-point initially."""
    assert not is_legal(_starting_board(), dice=(2, 2), side=0,
                        move_str="4/2")


def test_illegal_must_come_from_bar_first():
    """If you have a checker on the bar, the first move of the turn
    must be a bar entry."""
    pts = list(_starting_board().points)
    b = Board(points=tuple(pts), bar=(1, 0))
    assert not is_legal(b, dice=(3, 5), side=0, move_str="13/8")


def test_legal_bar_entry():
    """Bar entry against a non-blocked point in the opponent's home."""
    pts = [0] * NUM_POINTS
    pts[18] = -3        # 19-point blocked
    pts[19] = -2        # 20-point blocked
    # All other home-board points (21-24) are open.
    b = Board(points=tuple(pts), bar=(1, 0))
    # Player 0 enters from the bar with a 3 → lands on 22 (point index 21).
    assert is_legal(b, dice=(3, 5), side=0, move_str="bar/22")


def test_illegal_bar_entry_into_blocked_point():
    """Cannot enter onto a point with 2+ opponent checkers."""
    pts = [0] * NUM_POINTS
    pts[21] = -2        # 22-point blocked by 2 opponent checkers
    b = Board(points=tuple(pts), bar=(1, 0))
    assert not is_legal(b, dice=(3, 5), side=0, move_str="bar/22")


# ---------------------------------------------------------------------------
# Hits
# ---------------------------------------------------------------------------


def test_legal_hit_with_explicit_marker():
    pts = [0] * NUM_POINTS
    pts[12] = 5         # 13-point: 5 player-0 checkers
    pts[7] = -1         # 8-point: opponent blot
    b = Board(points=tuple(pts))
    assert is_legal(b, dice=(5, 4), side=0, move_str="13/8*")


def test_illegal_hit_without_marker():
    """The notation requires `*` to mark a hit; refusing without it
    keeps audit traces unambiguous."""
    pts = [0] * NUM_POINTS
    pts[12] = 5
    pts[7] = -1
    b = Board(points=tuple(pts))
    assert not is_legal(b, dice=(5, 4), side=0, move_str="13/8")


# ---------------------------------------------------------------------------
# Bear-off
# ---------------------------------------------------------------------------


def test_legal_bearoff_when_all_home():
    pts = [0] * NUM_POINTS
    pts[5] = 15
    b = Board(points=tuple(pts))
    assert is_legal(b, dice=(6, 6), side=0, move_str="6/off")


def test_illegal_bearoff_when_not_all_home():
    """Standard rule: cannot bear off while any checker is outside
    the home board."""
    assert not is_legal(_starting_board(), dice=(6, 6), side=0,
                        move_str="6/off")


# ---------------------------------------------------------------------------
# Doubles
# ---------------------------------------------------------------------------


def test_legal_doubles_uses_four_pips():
    """A 3-3 roll provides four 3s; using two of them on 13/10 13/10."""
    pts = [0] * NUM_POINTS
    pts[12] = 5
    b = Board(points=tuple(pts))
    assert is_legal(b, dice=(3, 3), side=0, move_str="13/10 13/10")


# ---------------------------------------------------------------------------
# Robustness
# ---------------------------------------------------------------------------


def test_unparseable_move_returns_false():
    assert not is_legal(_starting_board(), dice=(3, 5), side=0,
                        move_str="not-a-move-string")


def test_empty_move_returns_false():
    assert not is_legal(_starting_board(), dice=(3, 5), side=0, move_str="")


# ---------------------------------------------------------------------------
# OPENING_BOARD
# ---------------------------------------------------------------------------


def test_opening_board_has_15_checkers_per_side():
    p0 = OPENING_BOARD.for_side(0)
    p1 = OPENING_BOARD.for_side(1)
    assert sum(p0) == 15
    assert sum(p1) == 15


def test_opening_board_matches_starting_board():
    """OPENING_BOARD must equal the _starting_board() helper used in the rest of
    the test suite — they encode the same standard position."""
    assert OPENING_BOARD == _starting_board()


# ---------------------------------------------------------------------------
# apply_move
# ---------------------------------------------------------------------------


def test_apply_move_simple_shift():
    """13/10 on a 3-x roll: point 13 loses one checker, point 10 gains one."""
    b = _starting_board()
    result = apply_move(b, side=0, move_str="13/10")
    assert result.points[12] == b.points[12] - 1   # 13-point lost one
    assert result.points[9] == b.points[9] + 1     # 10-point gained one
    # Total checker count unchanged.
    assert sum(c for c in result.points if c > 0) + result.bar[0] + result.off[0] == 15


def test_apply_move_two_checkers():
    """8/5 6/5 (3-1 roll): both source points lose one, destination gains two."""
    b = _starting_board()
    result = apply_move(b, side=0, move_str="8/5 6/5")
    assert result.points[7] == b.points[7] - 1    # 8-point
    assert result.points[5] == b.points[5] - 1    # 6-point
    assert result.points[4] == b.points[4] + 2    # 5-point


def test_apply_move_hit_sends_opponent_to_bar():
    """13/8* hits an opponent blot on the 8-point: blot goes to bar."""
    pts = list(_starting_board().points)
    pts[7] = -1   # lone opponent blot on 8-point
    b = Board(points=tuple(pts))
    result = apply_move(b, side=0, move_str="13/8*")
    assert result.points[7] == 1        # player 0 now on the 8-point
    assert result.bar[1] == 1           # opponent was sent to bar
    assert result.points[12] == b.points[12] - 1  # 13-point lost one


def test_apply_move_bar_entry():
    """bar/22: player 0 enters from bar onto the 22-point."""
    pts = [0] * NUM_POINTS
    b = Board(points=tuple(pts), bar=(1, 0))
    result = apply_move(b, side=0, move_str="bar/22")
    assert result.bar[0] == 0           # bar cleared
    assert result.points[21] == 1       # 22-point occupied


def test_apply_move_bear_off():
    """6/off: player 0 bears off from the 6-point."""
    pts = [0] * NUM_POINTS
    pts[5] = 15
    b = Board(points=tuple(pts))
    result = apply_move(b, side=0, move_str="6/off")
    assert result.points[5] == 14
    assert result.off[0] == 1


def test_apply_move_preserves_immutability():
    """apply_move must not mutate the input board (Board is frozen)."""
    b = _starting_board()
    _ = apply_move(b, side=0, move_str="13/10")
    assert b.points[12] == 5   # original unchanged
