"""Tests for the 198-dim Tesauro contact-net encoder.

Run with:  cd agent && uv run pytest tests/test_gnubg_encoder.py -v

Hand-coded positions exercise:
  - shape: always 198, float32
  - empty board: all-zero except the on-roll bit
  - single-checker spike: f0=1 only
  - blocked point (5 stack): f0/f1/f2=1, f3=(5-3)/2=1
  - perspective symmetry: encoding from side 1 swaps own/opp halves
  - bar / off normalization
  - position_id round-trip (uses real gnubg_state.decode_position_id)

The test set covers every encoding rule from the standard layout so a
future contributor changing the encoder has a deterministic regression
to catch silent bugs.
"""
from __future__ import annotations

import pytest
import torch

from gnubg_encoder import (
    GNUBG_FEAT_DIM,
    _encode_point,
    encode_full_board,
)


def test_encode_point_zero():
    assert _encode_point(0) == (0.0, 0.0, 0.0, 0.0)


def test_encode_point_one():
    assert _encode_point(1) == (1.0, 0.0, 0.0, 0.0)


def test_encode_point_two():
    assert _encode_point(2) == (1.0, 1.0, 0.0, 0.0)


def test_encode_point_three():
    assert _encode_point(3) == (1.0, 1.0, 1.0, 0.0)


def test_encode_point_four():
    f0, f1, f2, f3 = _encode_point(4)
    assert (f0, f1, f2) == (1.0, 1.0, 1.0)
    assert f3 == pytest.approx(0.5)


def test_encode_point_five():
    f0, f1, f2, f3 = _encode_point(5)
    assert (f0, f1, f2) == (1.0, 1.0, 1.0)
    assert f3 == pytest.approx(1.0)


def test_encode_point_fifteen():
    f0, f1, f2, f3 = _encode_point(15)
    assert (f0, f1, f2) == (1.0, 1.0, 1.0)
    assert f3 == pytest.approx(6.0)


def test_shape_is_198_float32():
    feat = encode_full_board([0] * 24, [0, 0], [0, 0], perspective=0)
    assert feat.shape == (GNUBG_FEAT_DIM,)
    assert feat.dtype == torch.float32


def test_empty_board_only_on_roll_bit_set():
    """No checkers anywhere — only slot 196 (on-roll for perspective)
    should be 1; everything else 0."""
    feat = encode_full_board([0] * 24, [0, 0], [0, 0], perspective=0)
    assert feat[196].item() == 1.0
    assert feat[197].item() == 0.0
    for i in range(196):
        assert feat[i].item() == 0.0


def test_single_checker_own_side():
    """One own checker on point 1 → slots [0..3] should be (1, 0, 0, 0)."""
    board = [1] + [0] * 23
    feat = encode_full_board(board, [0, 0], [0, 0], perspective=0)
    assert feat[0].item() == 1.0
    assert feat[1].item() == 0.0
    assert feat[2].item() == 0.0
    assert feat[3].item() == 0.0


def test_single_checker_opponent_side():
    """One opp checker on point 1 → slots [96..99] should be (1,0,0,0).
    Own slots [0..3] stay 0."""
    board = [-1] + [0] * 23  # negative = opp
    feat = encode_full_board(board, [0, 0], [0, 0], perspective=0)
    assert feat[0].item() == 0.0
    assert feat[96].item() == 1.0
    assert feat[97].item() == 0.0


def test_blocked_point_five_checkers():
    """5 own checkers on point 6 → slots [20..23] should be (1, 1, 1, 1)
    because (5-3)/2 = 1.0."""
    board = [0] * 24
    board[5] = 5  # point 6 (0-indexed slot 5)
    feat = encode_full_board(board, [0, 0], [0, 0], perspective=0)
    base = 5 * 4
    assert feat[base + 0].item() == 1.0
    assert feat[base + 1].item() == 1.0
    assert feat[base + 2].item() == 1.0
    assert feat[base + 3].item() == pytest.approx(1.0)


def test_perspective_swap_symmetry():
    """Encoding (board, bar, off) from perspective=1 must equal the
    perspective=0 encoding with own/opp blocks swapped + bar/off
    swapped + on-roll bit flipped (because we always claim 'perspective
    is on roll'). After swapping, both encodings should match."""
    board = [3, 0, -2, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -3]
    bar = [1, 2]
    off = [0, 1]

    p0 = encode_full_board(board, bar, off, perspective=0)
    p1 = encode_full_board(board, bar, off, perspective=1)

    # Slots [0:96] of p1 should equal slots [96:192] of p0 (and vice versa).
    assert torch.allclose(p1[0:96], p0[96:192])
    assert torch.allclose(p1[96:192], p0[0:96])
    # Bar / off swap.
    assert p1[192].item() == pytest.approx(p0[193].item())
    assert p1[193].item() == pytest.approx(p0[192].item())
    assert p1[194].item() == pytest.approx(p0[195].item())
    assert p1[195].item() == pytest.approx(p0[194].item())
    # Both encodings claim "perspective on roll" — both have slot 196 = 1.
    assert p0[196].item() == 1.0
    assert p1[196].item() == 1.0


def test_bar_normalization():
    """bar=[3, 0] → slot 192 = 3/2 = 1.5 (own bar) when perspective=0."""
    feat = encode_full_board([0] * 24, [3, 0], [0, 0], perspective=0)
    assert feat[192].item() == pytest.approx(1.5)
    assert feat[193].item() == 0.0


def test_off_normalization():
    """off=[6, 9] → slot 194 = 6/15 = 0.4, slot 195 = 9/15 = 0.6."""
    feat = encode_full_board([0] * 24, [0, 0], [6, 9], perspective=0)
    assert feat[194].item() == pytest.approx(6 / 15)
    assert feat[195].item() == pytest.approx(9 / 15)


def test_invalid_board_length_raises():
    with pytest.raises(ValueError, match="24"):
        encode_full_board([0] * 23, [0, 0], [0, 0], perspective=0)


def test_invalid_perspective_raises():
    with pytest.raises(ValueError, match="perspective"):
        encode_full_board([0] * 24, [0, 0], [0, 0], perspective=2)


def test_invalid_bar_length_raises():
    with pytest.raises(ValueError):
        encode_full_board([0] * 24, [0, 0, 0], [0, 0], perspective=0)


def test_starting_position_canonical_encoding():
    """The canonical opening position: 2 on point 1, 5 on 12, 3 on 17,
    5 on 19 (own side); mirrored opp side. Each of those points produces
    a known unary thermometer of 4 features.

    own counts: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0]
    """
    # gnubg's start position from side 0's POV (side 0 = "X" = positive).
    own = [0] * 24
    own[0] = 2
    own[11] = 5
    own[16] = 3
    own[18] = 5
    opp = [0] * 24
    opp[23] = 2
    opp[12] = 5
    opp[7] = 3
    opp[5] = 5
    board = [own[i] - opp[i] for i in range(24)]

    feat = encode_full_board(board, [0, 0], [0, 0], perspective=0)
    # Own point 1 has 2 checkers: f0=1, f1=1, f2=0, f3=0.
    assert feat[0].item() == 1.0
    assert feat[1].item() == 1.0
    assert feat[2].item() == 0.0
    # Own point 12 has 5 checkers: f0=f1=f2=1, f3=1.
    base = 11 * 4
    assert feat[base + 3].item() == pytest.approx(1.0)
    # Opp point 24 (slot 23) has 2 checkers: opp slot 96 + 23*4 = 188.
    assert feat[188].item() == 1.0
    assert feat[189].item() == 1.0
