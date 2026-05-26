"""Tests for the n-ply gnubg search (agent/gnubg_search.py).

Run with:  cd agent && uv run pytest tests/test_gnubg_search.py -v

Covers the Board->TanBoard bridge (the part most likely to silently
mis-encode), the gnubg ply convention (0-ply == best static reply), terminal
/ bear-off detection, and that a 2-ply search returns a legal in-range move.
Net-backed tests need gnubg.wd and skip otherwise; the pure conversion test
runs unconditionally.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from gnubg_net import DEFAULT_WD_PATH, GnubgEvaluator
from gnubg_search import (
    board_to_tanboard,
    eval_position,
    find_best_move,
    gnubg_eval_fn,
    static_equity,
)
from onnx_board_state import generate_legal_moves
from rules_engine import OPENING_BOARD, Board

_START = [0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0]

_needs_wd = pytest.mark.skipif(
    not Path(DEFAULT_WD_PATH).is_file(),
    reason=f"gnubg weights not found at {DEFAULT_WD_PATH}",
)


@pytest.fixture(scope="module")
def ev():
    return GnubgEvaluator()


# --- Board -> TanBoard ------------------------------------------------------

def test_tanboard_opening_is_symmetric():
    # Standard opening is symmetric, so both sides map to the same array
    # regardless of who is on roll.
    for on_roll in (0, 1):
        b0, b1 = board_to_tanboard(OPENING_BOARD, on_roll)
        assert b0 == _START
        assert b1 == _START


def test_tanboard_asymmetric_hand_computed():
    # Side 0: one checker on its 24-point (board point 24 = index 23).
    # Side 1: one checker on board point 1 (index 0) = side 1's 24-point.
    pts = [0] * 24
    pts[23] = 1
    pts[0] = -1
    board = Board(points=tuple(pts), bar=(1, 2), off=(3, 4))

    b0, b1 = board_to_tanboard(board, on_roll=0)
    # Both back checkers sit on each side's own 24-point (index 23); bars differ.
    assert b0[23] == 1 and b0[24] == 1 and sum(b0[:23]) == 0
    assert b1[23] == 1 and b1[24] == 2 and sum(b1[:23]) == 0

    # Swapping who is on roll swaps the two arrays.
    s0, s1 = board_to_tanboard(board, on_roll=1)
    assert (s0, s1) == (b1, b0)


# --- static equity ----------------------------------------------------------

@_needs_wd
def test_static_equity_matches_evaluator(ev):
    fn = gnubg_eval_fn(ev)
    assert static_equity(OPENING_BOARD, 0, fn) == pytest.approx(ev.evaluate(_START, _START)[1])


@_needs_wd
def test_static_equity_terminal(ev):
    fn = gnubg_eval_fn(ev)
    won = Board(points=tuple([0] * 24), bar=(0, 0), off=(15, 5))
    assert static_equity(won, 0, fn) == 1.0
    assert static_equity(won, 1, fn) == -1.0


# --- ply convention ---------------------------------------------------------

@_needs_wd
def test_find_best_move_0ply_equals_argmax_static(ev):
    fn = gnubg_eval_fn(ev)
    dice = (3, 1)
    board, move_str, value = find_best_move(OPENING_BOARD, 0, dice, fn, plies=0)

    # Independently: 0-ply value of a move is the opponent's negated static
    # equity of the resulting position. Best move maximises it.
    succ = generate_legal_moves(OPENING_BOARD, dice, 0)
    scored = [(-static_equity(child, 1, fn), child, ms) for child, ms in succ]
    best = max(scored, key=lambda t: t[0])
    assert value == pytest.approx(best[0])
    assert board.points == best[1].points
    assert move_str == best[2]


@_needs_wd
def test_2ply_returns_legal_in_range_move(ev):
    fn = gnubg_eval_fn(ev)
    # A small pure race (3 checkers each, no contact) so the exact 21x21 2-ply
    # tree stays cheap. Side 0 on points 1-2, side 1 on points 23-24.
    pts = [0] * 24
    pts[0], pts[1] = 1, 2
    pts[22], pts[23] = -2, -1
    board = Board(points=tuple(pts), bar=(0, 0), off=(12, 12))
    dice = (2, 1)
    legal = {child.points for child, _ in generate_legal_moves(board, dice, 0)}
    chosen, _, value = find_best_move(board, 0, dice, fn, plies=2)
    assert chosen.points in legal
    assert -1.0 <= value <= 1.0
    # 2-ply must agree with 0-ply that this won race is hugely favourable.
    assert value > 0.5


@_needs_wd
def test_bearoff_winning_move(ev):
    fn = gnubg_eval_fn(ev)
    # Side 0's last checker on its 1-point; side 1 still has men on the board.
    pts = [0] * 24
    pts[0] = 1
    pts[23] = -2
    board = Board(points=tuple(pts), bar=(0, 0), off=(14, 13))
    chosen, move_str, value = find_best_move(board, 0, (1, 2), fn, plies=2)
    assert chosen is not None and chosen.off[0] == 15
    assert value == 1.0
    assert "off" in move_str


@_needs_wd
def test_eval_position_plies0_is_static(ev):
    fn = gnubg_eval_fn(ev)
    assert eval_position(OPENING_BOARD, 0, 0, fn) == pytest.approx(static_equity(OPENING_BOARD, 0, fn))
