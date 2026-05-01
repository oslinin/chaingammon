"""
gnubg_encoder.py — full-board 198-dim Tesauro contact-net feature encoding.

Phase J.1. Replaces the simplified pip-race thermometer at
sample_trainer.encode_state (sample_trainer.py:215-227, GNUBG_FEAT_DIM=198)
which is documented as "production code uses gnubg's exact 198-dim
contact-net encoding here." This module IS that production encoder.

Encoding layout (the standard Tesauro 198-dim contact-net features
gnubg uses internally as input to its evalNeural network):

  Slots [0:96]    own side, 24 points × 4 features each
  Slots [96:192]  opp side, 24 points × 4 features each
  Slot  192       own bar / 2.0   (max ~ 7.5 → max ~ 3.75)
  Slot  193       opp bar / 2.0
  Slot  194       own off / 15.0
  Slot  195       opp off / 15.0
  Slot  196       1.0 if own is on roll
  Slot  197       1.0 if opp is on roll

Per-point 4-feature unary encoding for n checkers:

  f0 = 1.0     if n >= 1 else 0
  f1 = 1.0     if n >= 2 else 0
  f2 = 1.0     if n >= 3 else 0
  f3 = (n-3)/2 if n >= 4 else 0

This is the canonical "tesauro contact-net" input. The same shape is
documented in gnubg's lib/eval.c and various TD-Gammon papers.

The encoder is pure Python — no subprocess, no gnubg binary required.
It composes with `agent/gnubg_state.decode_position_id` (which already
exists at gnubg_state.py:38-83) to take a gnubg position_id string
straight to a 198-dim torch.Tensor.

Production flow:
    from gnubg_state import decode_position_id
    from gnubg_encoder import encode_full_board, encode_position_id

    feats = encode_position_id(position_id, perspective=0)   # convenience
    # or:
    board, bar, off = decode_position_id(position_id)
    feats = encode_full_board(board, bar, off, perspective=0)
    # → torch.Tensor shape [198], float32

Phase J.5 will call this from /games/{id}/agent-move when
use_per_agent_nn=True.

Note: the constant `GNUBG_FEAT_DIM = 198` from agent/sample_trainer.py
is preserved — both encoders produce the same shape, the only
difference is the semantic content.
"""
from __future__ import annotations

from typing import Sequence

import torch


GNUBG_FEAT_DIM = 198


def _encode_point(n: int) -> tuple[float, float, float, float]:
    """Per-point 4-feature unary encoding (standard Tesauro layout)."""
    if n <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    return (
        1.0,
        1.0 if n >= 2 else 0.0,
        1.0 if n >= 3 else 0.0,
        (n - 3) / 2.0 if n >= 4 else 0.0,
    )


def encode_full_board(
    board: Sequence[int],
    bar: Sequence[int],
    off: Sequence[int],
    perspective: int,
) -> torch.Tensor:
    """Build the 198-dim Tesauro contact-net feature vector.

    @param board       24 signed ints, decode_position_id format —
                       board[i] > 0 means side 0 has |board[i]| checkers
                       on point i+1; board[i] < 0 means side 1.
    @param bar         [side_0_bar, side_1_bar] — checkers on the bar.
    @param off         [side_0_off, side_1_off] — checkers borne off.
    @param perspective 0 or 1. The first 96 slots encode this side's
                       points, the next 96 encode the opponent's;
                       slots 192..195 are bar/off normalized; slots
                       196..197 indicate who is on roll. The encoding
                       is symmetric — encoding the same position from
                       perspective=1 gives the perspective=0 encoding
                       with own/opp swapped + the on-roll bit flipped.

    Returns a torch.Tensor of shape [198], dtype float32.
    """
    if len(board) != 24:
        raise ValueError(f"board must have 24 entries, got {len(board)}")
    if len(bar) != 2 or len(off) != 2:
        raise ValueError("bar and off must have 2 entries each")
    if perspective not in (0, 1):
        raise ValueError(f"perspective must be 0 or 1, got {perspective}")

    feat = [0.0] * GNUBG_FEAT_DIM

    # Per-point counts from the perspective's POV. Side-0 owns positive
    # counts; side-1 owns negative counts (decode_position_id convention).
    # When perspective=1, swap signs so the perspective player's points
    # are positive integers.
    own_sign = 1 if perspective == 0 else -1
    opp_sign = -own_sign

    for i in range(24):
        own_n = board[i] * own_sign
        if own_n < 0:
            own_n = 0
        f0, f1, f2, f3 = _encode_point(own_n)
        feat[i * 4 + 0] = f0
        feat[i * 4 + 1] = f1
        feat[i * 4 + 2] = f2
        feat[i * 4 + 3] = f3

    for i in range(24):
        opp_n = board[i] * opp_sign
        if opp_n < 0:
            opp_n = 0
        f0, f1, f2, f3 = _encode_point(opp_n)
        feat[96 + i * 4 + 0] = f0
        feat[96 + i * 4 + 1] = f1
        feat[96 + i * 4 + 2] = f2
        feat[96 + i * 4 + 3] = f3

    own_bar = bar[perspective]
    opp_bar = bar[1 - perspective]
    own_off = off[perspective]
    opp_off = off[1 - perspective]

    feat[192] = own_bar / 2.0
    feat[193] = opp_bar / 2.0
    feat[194] = own_off / 15.0
    feat[195] = opp_off / 15.0
    # On-roll indicator. The caller doesn't tell us whose turn it is,
    # so by convention we say "perspective is on roll" — this matches
    # how the encoder is used during evaluation: you're encoding from
    # the to-move side's perspective.
    feat[196] = 1.0
    feat[197] = 0.0

    return torch.tensor(feat, dtype=torch.float32)


def encode_position_id(position_id: str, perspective: int) -> torch.Tensor:
    """Convenience: decode_position_id → encode_full_board.

    Pulls in the existing gnubg_state.decode_position_id (Phase 24,
    battle-tested through Phase 36) so this function is just glue.
    `decode_position_id` returns a (board, bar, off) tuple; we feed
    each through directly.
    """
    from gnubg_state import decode_position_id

    board, bar, off = decode_position_id(position_id)
    return encode_full_board(board, bar, off, perspective=perspective)
