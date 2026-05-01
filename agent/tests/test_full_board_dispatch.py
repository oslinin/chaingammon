"""Tests for sample_trainer's encode_state + legal_successors dispatch.

Run with:  cd agent && uv run pytest tests/test_full_board_dispatch.py -v

Phase J.3: encode_state and legal_successors are now type-dispatchers.
RaceState routes through the original code; FullBoardState routes
through gnubg_encoder.encode_full_board + full_board_state.legal_successors_full.

These tests confirm:
  - RaceState path is unchanged (back-compat)
  - FullBoardState path returns the encoder's 198-dim output
  - legal_successors with FullBoardState raises if the gnubg client
    isn't set (caller error, not silent misroute)
  - save_checkpoint writes feature_encoder field; ModelProfile
    metadata exposes it
"""
from __future__ import annotations

from pathlib import Path

import pytest
import torch

import sample_trainer as st
from full_board_state import FullBoardState
from sample_trainer import (
    BackgammonNet,
    RaceState,
    encode_state,
    legal_successors,
    save_checkpoint,
)


def test_encode_state_race_state_path_unchanged():
    """RaceState input still produces the unary thermometer (slot 0..98
    encodes own pip count, slot 99..197 encodes opp). Same as before J.3."""
    state = RaceState(pip=[10, 20], turn=0, n_turns=0)
    feat = encode_state(state, perspective=0)
    assert feat.shape == (198,)
    assert feat[:10].tolist() == [1.0] * 10
    assert feat[10:99].tolist() == [0.0] * 89
    assert feat[99:99 + 20].tolist() == [1.0] * 20


def test_encode_state_full_board_path():
    """FullBoardState input routes through gnubg_encoder.encode_full_board.
    Slot 196 is set to 1.0 (the perspective-on-roll indicator), slot
    197 is 0.0 — distinct from the race path (which leaves both 0)."""
    state = FullBoardState(
        position_id="P", match_id="M",
        board=[2] + [0] * 23, bar=[0, 0], off=[0, 0],
        turn=0, dice=None, n_turns=0,
    )
    feat = encode_state(state, perspective=0)
    assert feat.shape == (198,)
    # Slot 0 = own point 1 has 2 checkers → f0=1
    # Slot 1 = own point 1 has 2 checkers → f1=1
    assert feat[0].item() == 1.0
    assert feat[1].item() == 1.0
    # Slot 196 = on-roll bit
    assert feat[196].item() == 1.0


def test_legal_successors_race_state_path_unchanged():
    state = RaceState(pip=[100, 100], turn=0, n_turns=0)
    cands = legal_successors(state, (3, 1))
    assert len(cands) >= 1
    assert all(isinstance(c, RaceState) for c in cands)


def test_legal_successors_full_board_without_client_raises():
    """If a FullBoardState reaches legal_successors but the module
    global isn't set, raise with a clear message rather than silently
    fall through to the race-only branch (which would crash on
    state.pip access)."""
    state = FullBoardState(
        position_id="P", match_id="M",
        board=[0] * 24, bar=[0, 0], off=[0, 0],
        turn=0, dice=None, n_turns=0,
    )
    # Ensure clean — main() sets this when --full-board is on; tests
    # not running --full-board should not have it set.
    st._GNUBG_CLIENT_FOR_FULL_BOARD = None

    with pytest.raises(RuntimeError, match="_GNUBG_CLIENT_FOR_FULL_BOARD"):
        legal_successors(state, (3, 1))


def test_legal_successors_full_board_with_client_dispatches():
    """When the module global is set, legal_successors routes to
    legal_successors_full and returns FullBoardState successors."""
    class _StubClient:
        def get_candidate_moves(self, p, m):
            return [{"move": "13/10 24/23", "equity": 0.4}]
        def submit_move(self, p, m, mv):
            return {"position_id": "P1", "match_id": "M1", "output": ""}
        def decode_board(self, p, m):
            return {"points": [0] * 24, "bar": [0, 0]}

    import gnubg_state as gs
    original = gs.decode_match_id
    gs.decode_match_id = lambda mid: {
        "turn": 0, "dice": None, "cube": 1, "cube_owner": -1,
        "match_length": 1, "score": [0, 0], "game_over": False,
    }
    try:
        st._GNUBG_CLIENT_FOR_FULL_BOARD = _StubClient()
        state = FullBoardState(
            position_id="P", match_id="M",
            board=[0] * 24, bar=[0, 0], off=[0, 0],
            turn=0, dice=None, n_turns=0,
        )
        cands = legal_successors(state, (3, 1))
        assert len(cands) == 1
        assert isinstance(cands[0], FullBoardState)
    finally:
        gs.decode_match_id = original
        st._GNUBG_CLIENT_FOR_FULL_BOARD = None


# ─── J.4 checkpoint metadata ───────────────────────────────────────────────


def test_save_checkpoint_default_feature_encoder_is_race(tmp_path: Path):
    net = BackgammonNet(extras_dim=16, core_seed=0xBACC, extras_seed=1)
    p = tmp_path / "ckpt.pt"
    save_checkpoint(net, p, match_count=5, extras_dim=16)
    blob = torch.load(p, weights_only=True)
    assert blob["feature_encoder"] == "race"


def test_save_checkpoint_full_board_feature_encoder(tmp_path: Path):
    net = BackgammonNet(extras_dim=16, core_seed=0xBACC, extras_seed=1)
    p = tmp_path / "ckpt.pt"
    save_checkpoint(net, p, match_count=5, extras_dim=16,
                    feature_encoder="gnubg_full")
    blob = torch.load(p, weights_only=True)
    assert blob["feature_encoder"] == "gnubg_full"
