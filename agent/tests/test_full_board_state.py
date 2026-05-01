"""Tests for FullBoardState + legal_successors_full.

Run with:  cd agent && uv run pytest tests/test_full_board_state.py -v

Hermetic — gnubg_client is replaced by an in-memory stub that returns
canned position_id/match_id strings. We never spawn a real gnubg
subprocess; the FullBoardState driver's job is to wire the right
calls in the right order, not to validate gnubg's output.

decode_board + decode_match_id are also stubbed via the same client
methods so the test runs without parsing real gnubg position_ids.
"""
from __future__ import annotations

from typing import Optional
from unittest.mock import patch

import pytest

import full_board_state as fbs


class _StubClient:
    """In-memory gnubg_client stub. State machine:
       - new_match returns canned starting position
       - get_candidate_moves returns canned candidates
       - submit_move advances position_id deterministically
       - decode_board returns synthetic 24-point board the encoder
         can consume."""

    def __init__(self, *, candidates_per_turn=2, terminal_after=4):
        self.candidates_per_turn = candidates_per_turn
        self.terminal_after = terminal_after
        self._move_count = 0

    def new_match(self, length):
        return {"position_id": "P0", "match_id": "M0"}

    def decode_board(self, pos_id, match_id):
        # Synthetic empty board — enough for the FullBoardState class
        # to construct without errors. The real encoder won't be run
        # in these tests.
        return {"points": [0] * 24, "bar": [0, 0]}

    def get_candidate_moves(self, pos_id, match_id):
        # Return a deterministic list of candidates.
        return [
            {"move": f"13/10 {i}/0", "equity": 0.4 - 0.01 * i, "win_pct": 0.5}
            for i in range(self.candidates_per_turn)
        ]

    def submit_move(self, pos_id, match_id, move):
        self._move_count += 1
        return {
            "position_id": f"P{self._move_count}",
            "match_id": f"M{self._move_count}",
            "output": "",
        }


def _patch_decode_match_id_simple(monkeypatch):
    """Stub decode_match_id to return a stable structure for tests
    so we don't have to encode real match_id base64 strings."""
    import gnubg_state as gs

    def _fake(match_id):
        # Last char is a digit we use as turn count; "M0" → 0, "M3" → 3.
        idx = int(match_id[1:]) if match_id and match_id[0] == "M" else 0
        return {
            "turn": idx % 2,
            "dice": None,
            "cube": 1,
            "cube_owner": -1,
            "match_length": 1,
            "score": [0, 0],
            "game_over": False,
        }

    monkeypatch.setattr(gs, "decode_match_id", _fake)


@pytest.fixture
def stub_client(monkeypatch):
    _patch_decode_match_id_simple(monkeypatch)
    return _StubClient()


# ─── FullBoardState.initial ────────────────────────────────────────────────


def test_initial_state_via_new_match(stub_client):
    state = fbs.FullBoardState.initial(stub_client)
    assert state.position_id == "P0"
    assert state.match_id == "M0"
    assert state.n_turns == 0
    assert state.game_over is False
    assert state.terminal() is False


def test_initial_raises_when_new_match_fails(stub_client):
    class BadClient(_StubClient):
        def new_match(self, length):
            return {"position_id": "", "match_id": ""}

    with pytest.raises(RuntimeError, match="new_match failed"):
        fbs.FullBoardState.initial(BadClient())


# ─── legal_successors_full ─────────────────────────────────────────────────


def test_legal_successors_returns_one_state_per_candidate(stub_client):
    state = fbs.FullBoardState.initial(stub_client)
    succs = fbs.legal_successors_full(state, (3, 1), stub_client)
    assert len(succs) == 2  # candidates_per_turn default
    # Each successor's n_turns is one greater than parent.
    for s in succs:
        assert s.n_turns == state.n_turns + 1


def test_legal_successors_distinct_positions(stub_client):
    state = fbs.FullBoardState.initial(stub_client)
    succs = fbs.legal_successors_full(state, (3, 1), stub_client)
    ids = [s.position_id for s in succs]
    # Each submit_move advances position counter, so successors are
    # distinct (P1, P2 in this stub).
    assert len(set(ids)) == len(succs)


def test_legal_successors_no_candidates_yields_skip(monkeypatch, stub_client):
    """When gnubg returns no candidates (bar dance), the driver must
    submit an empty move to advance the turn, returning exactly one
    successor."""
    class NoCands(_StubClient):
        def get_candidate_moves(self, pos_id, match_id):
            return []

    _patch_decode_match_id_simple(monkeypatch)
    client = NoCands()
    state = fbs.FullBoardState.initial(client)
    succs = fbs.legal_successors_full(state, (1, 1), client)
    assert len(succs) == 1
    assert succs[0].n_turns == state.n_turns + 1


def test_legal_successors_skips_moves_gnubg_rejects(monkeypatch, stub_client):
    """If submit_move returns empty position_id (gnubg rejected the
    pick), drop that successor instead of including a malformed state."""
    class FlakyClient(_StubClient):
        def __init__(self):
            super().__init__()
            self._rejected_first = False

        def submit_move(self, pos_id, match_id, move):
            if not self._rejected_first:
                self._rejected_first = True
                return {"position_id": "", "match_id": "", "output": "rejected"}
            return super().submit_move(pos_id, match_id, move)

    _patch_decode_match_id_simple(monkeypatch)
    client = FlakyClient()
    state = fbs.FullBoardState.initial(client)
    succs = fbs.legal_successors_full(state, (3, 1), client)
    # 2 candidates, first rejected, one accepted.
    assert len(succs) == 1


# ─── terminal / winner from match_id ───────────────────────────────────────


def test_terminal_when_match_id_signals_game_over(monkeypatch, stub_client):
    import gnubg_state as gs

    def _fake(match_id):
        return {
            "turn": 0, "dice": None, "cube": 1, "cube_owner": -1,
            "match_length": 1, "score": [1, 0],
            "game_over": True,
        }

    monkeypatch.setattr(gs, "decode_match_id", _fake)
    state = fbs.FullBoardState.initial(stub_client)
    assert state.terminal() is True
    assert state.winner() == 0


def test_terminal_capped_at_200_turns(stub_client):
    state = fbs.FullBoardState(
        position_id="P", match_id="M",
        board=[0] * 24, bar=[0, 0], off=[0, 0],
        turn=0, n_turns=200, game_over=False,
    )
    assert state.terminal() is True


def test_winner_from_score_when_game_over(monkeypatch, stub_client):
    import gnubg_state as gs

    def _fake(match_id):
        return {
            "turn": 0, "dice": None, "cube": 1, "cube_owner": -1,
            "match_length": 1, "score": [0, 1],  # side 1 wins
            "game_over": True,
        }

    monkeypatch.setattr(gs, "decode_match_id", _fake)
    state = fbs.FullBoardState.initial(stub_client)
    assert state.winner() == 1
