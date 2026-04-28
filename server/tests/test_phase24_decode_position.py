"""
Phase 24: regression tests for `decode_position_id`.

The original implementation used `if/elif` to assign player 0 and player 1
checkers to the board, but their indices map to *different* board cells
(player 0 at index `i`, player 1 mirrored to index `23 - i`). The `elif`
caused player 1's checkers to be silently dropped whenever player 0
already had any checkers at the same array index — which is the case at
every index in the opening position.

Symptom: the agent's red checkers never appeared on the board in the UI.

These tests pin the decoded shape for the gnubg-native opening position
so a future refactor can't reintroduce the same class of bug.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `app` importable when running pytest from server/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.game_state import decode_position_id  # noqa: E402

# gnubg-emitted position_id for the standard backgammon starting position.
# Captured from `GnubgClient.new_match(1)` on 2026-04-27. Stable across
# gnubg versions.
OPENING_POSITION_ID = "4HPwATDgc/ABMA"


def test_opening_decodes_to_full_board_for_both_players():
    board, bar, off = decode_position_id(OPENING_POSITION_ID)

    # Player 0 (positive counts in the board array, blue in the UI):
    #   point 6  → board index 5 → 5 checkers
    #   point 8  → board index 7 → 3 checkers
    #   point 13 → board index 12 → 5 checkers
    #   point 24 → board index 23 → 2 checkers
    assert board[5] == 5
    assert board[7] == 3
    assert board[12] == 5
    assert board[23] == 2

    # Player 1 (negative counts in the board array, red in the UI):
    #   p1's point 6  → p0's point 19 → board index 18 → -5 checkers
    #   p1's point 8  → p0's point 17 → board index 16 → -3 checkers
    #   p1's point 13 → p0's point 12 → board index 11 → -5 checkers
    #   p1's point 24 → p0's point 1  → board index 0  → -2 checkers
    #
    # This is the exact regression: prior to the fix, board[18] / board[16]
    # / board[11] / board[0] all stayed at 0 because the `elif` branch
    # never ran (player 0 had checkers at indices 5/7/12/23, so the
    # corresponding `if` always took precedence).
    assert board[0] == -2
    assert board[11] == -5
    assert board[16] == -3
    assert board[18] == -5

    # All other cells are empty in the opening.
    for i in range(24):
        if i not in {5, 7, 12, 23, 0, 11, 16, 18}:
            assert board[i] == 0, f"unexpected checker at index {i}: {board[i]}"


def test_opening_has_15_checkers_per_side_with_no_bar_or_off():
    board, bar, off = decode_position_id(OPENING_POSITION_ID)

    p0_on_points = sum(c for c in board if c > 0)
    p1_on_points = -sum(c for c in board if c < 0)

    assert bar == [0, 0]
    assert off == [0, 0]
    assert p0_on_points + bar[0] + off[0] == 15
    assert p1_on_points + bar[1] + off[1] == 15


def test_returns_three_tuple_of_correct_shapes():
    """Smoke-test the return contract — Board.tsx depends on this shape."""
    board, bar, off = decode_position_id(OPENING_POSITION_ID)
    assert len(board) == 24
    assert len(bar) == 2
    assert len(off) == 2
    assert all(isinstance(c, int) for c in board + bar + off)
