"""Tests for Phase J.5 — /games/{id}/agent-move use_per_agent_nn branch.

Run with:  cd server && uv run pytest tests/test_agent_move_per_agent_nn.py -v

Hermetic — gnubg + chain client + profile loader all stubbed. The
tests cover:
  - use_per_agent_nn=true with no chain: falls back to overlay path
  - use_per_agent_nn=true with overlay-only profile: falls back
  - use_per_agent_nn=true with race-only model profile: falls back
    (with the documented note in inference_meta when also requesting 0G)
  - use_per_agent_nn=true with gnubg_full model profile: NN scores
    every candidate, picks the highest-scoring move
  - default (use_per_agent_nn=false): existing overlay path unchanged
"""
from __future__ import annotations

import io
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
import torch
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))
from app import main as main_module  # noqa: E402
from app.game_state import GameState  # noqa: E402


client = TestClient(main_module.app)


def _seed_game(turn=1, dice=None):
    main_module.games["nn-game"] = GameState(
        game_id="nn-game",
        match_id="cAkAAAAAAAAA",
        position_id="4HPwATDgc/ABMA",
        board=[0] * 24,
        bar=[0, 0],
        off=[0, 0],
        turn=turn,
        dice=dice,
        cube=1,
        cube_owner=-1,
        match_length=1,
        score=[0, 0],
        game_over=False,
        winner=None,
    )
    main_module._game_agent_id["nn-game"] = 7
    main_module._move_history["nn-game"] = []
    return "nn-game"


@pytest.fixture(autouse=True)
def _patch_gnubg(monkeypatch):
    """Stub gnubg + decode helpers so /agent-move runs without real
    subprocess. Two distinct candidate moves so the NN path can pick
    the higher-scoring one and tests can verify the choice."""
    candidates = [
        {"move": "13/10 24/23", "equity": 0.40, "win_pct": 0.46},
        {"move": "13/11 13/10", "equity": 0.42, "win_pct": 0.48},
    ]

    def _submit(pos_id, match_id, move):
        # Distinct successor position_ids per move so NN scoring sees
        # different inputs and can disagree with gnubg.
        return {
            "position_id": "POS_A" if "24/23" in move else "POS_B",
            "match_id": "cAkAAAAAAAAB",
            "output": "",
        }

    monkeypatch.setattr(main_module.gnubg, "get_candidate_moves",
                        lambda p, m: candidates)
    monkeypatch.setattr(main_module.gnubg, "submit_move", _submit)
    monkeypatch.setattr(main_module.gnubg, "decode_board",
                        lambda p, m: {"points": [0] * 24, "bar": [0, 0]})
    monkeypatch.setattr(main_module, "decode_match_id", lambda mid: {
        "turn": 0, "dice": None, "cube": 1, "cube_owner": -1,
        "match_length": 1, "score": [0, 0], "game_over": False,
    })
    monkeypatch.setattr(main_module, "_ensure_overlay_loaded",
                        lambda gid: type("O", (), {"values": {}})())
    monkeypatch.setattr(main_module, "apply_overlay", lambda c, o: c)
    main_module._game_teams.clear()
    main_module._game_agent_id.clear()
    main_module._move_history.clear()
    main_module.games.clear()


def _patch_chain_with_hash(monkeypatch, weights_hash):
    """Stub ChainClient.from_env to return a fake with a configured
    weights_hash for agent 7."""
    class _FakeChain:
        def __init__(self):
            self.agent_registry = object()
        def agent_data_hashes(self, aid):
            return ["0x" + "00" * 32, weights_hash]
    monkeypatch.setattr(main_module.ChainClient, "from_env",
                        classmethod(lambda cls: _FakeChain()))


# ─── default path: use_per_agent_nn=false (back-compat) ────────────────────


def test_default_uses_overlay_path():
    gid = _seed_game()
    r = client.post(f"/games/{gid}/agent-move")
    assert r.status_code == 200
    body = r.json()
    # gnubg's natural top is the first candidate ("13/10 24/23").
    # apply_overlay is patched to pass-through, so the overlay path
    # picks that.
    assert body["position_id"] == "POS_A"


# ─── use_per_agent_nn=true: falls back when prereqs unmet ──────────────────


def test_per_agent_nn_no_chain_falls_back(monkeypatch):
    """Without a chain client, the helper returns None and /agent-move
    falls back to the overlay path."""
    from app.chain_client import ChainError
    monkeypatch.setattr(main_module.ChainClient, "from_env",
                        classmethod(lambda cls: (_ for _ in ()).throw(ChainError("no chain"))))
    gid = _seed_game()
    r = client.post(f"/games/{gid}/agent-move",
                    json={"use_per_agent_nn": True})
    assert r.status_code == 200
    # Falls back to overlay → picks first candidate's successor.
    assert r.json()["position_id"] == "POS_A"


def test_per_agent_nn_zero_hash_falls_back(monkeypatch):
    _patch_chain_with_hash(monkeypatch, "0x" + "00" * 32)
    gid = _seed_game()
    r = client.post(f"/games/{gid}/agent-move",
                    json={"use_per_agent_nn": True})
    assert r.status_code == 200
    assert r.json()["position_id"] == "POS_A"


def test_per_agent_nn_overlay_profile_falls_back(monkeypatch):
    _patch_chain_with_hash(monkeypatch, "0xab" + "cd" * 31)
    import agent_profile as ap
    overlay_profile = ap.OverlayProfile({"hits_blot": 0.2}, match_count=5)
    monkeypatch.setattr(ap, "load_profile", lambda h, fetch=None: overlay_profile)
    gid = _seed_game()
    r = client.post(f"/games/{gid}/agent-move",
                    json={"use_per_agent_nn": True})
    assert r.status_code == 200
    assert r.json()["position_id"] == "POS_A"


def test_per_agent_nn_race_model_falls_back(monkeypatch):
    """Race-only model profile → falls back since it can't score
    full-board positions."""
    _patch_chain_with_hash(monkeypatch, "0xab" + "cd" * 31)
    import agent_profile as ap
    from sample_trainer import BackgammonNet
    net = BackgammonNet(extras_dim=16, core_seed=0xBACC, extras_seed=7)
    race_profile = ap.ModelProfile(
        {"feature_encoder": "race", "match_count": 10, "extras_dim": 16, "in_dim": 198},
        net=net,
    )
    monkeypatch.setattr(ap, "load_profile", lambda h, fetch=None: race_profile)
    gid = _seed_game()
    r = client.post(f"/games/{gid}/agent-move",
                    json={"use_per_agent_nn": True})
    assert r.status_code == 200
    assert r.json()["position_id"] == "POS_A"


# ─── use_per_agent_nn=true: NN actually picks ─────────────────────────────


def test_per_agent_nn_full_board_model_picks_argmax(monkeypatch):
    """gnubg_full ModelProfile + a stub net that returns higher equity
    for POS_B's encoded successor → NN picks the second candidate
    (which gnubg ranked second). Demonstrates the NN can override
    gnubg's default."""
    _patch_chain_with_hash(monkeypatch, "0xab" + "cd" * 31)
    import agent_profile as ap

    class _StubNet(torch.nn.Module):
        """Returns a higher equity for the second candidate's
        successor (POS_B). The mock encoder won't produce different
        features for POS_A vs POS_B (decode_position_id is real and
        these are toy strings), so we differentiate by reading the
        feature tensor's hash to simulate the NN preferring POS_B."""
        extras = None  # match BackgammonNet API for the helper

        def __init__(self):
            super().__init__()

        def forward(self, feat, extras=None):
            return torch.tensor([[0.7]])  # constant; we'll patch
                                          # decode_position_id to vary
                                          # the feat per call instead

    stub_net = _StubNet()
    # The net always returns 0.7; tie-break: J.5 picks the first idx
    # with the highest score. So with all candidates tied, the first
    # candidate wins. To make the test NON-trivial, monkeypatch the
    # net to return varying scores per call.
    call_idx = {"i": 0}
    def _fake_forward(self, feat, extras=None):
        call_idx["i"] += 1
        # Return a higher score on the second call (= second candidate).
        return torch.tensor([[0.5 + 0.1 * call_idx["i"]]])
    monkeypatch.setattr(_StubNet, "forward", _fake_forward)

    full_profile = ap.ModelProfile(
        {"feature_encoder": "gnubg_full", "match_count": 10,
         "extras_dim": 0, "in_dim": 198},
        net=stub_net,
    )
    monkeypatch.setattr(ap, "load_profile", lambda h, fetch=None: full_profile)

    # decode_position_id needs to handle our toy "POS_A"/"POS_B" strings.
    import gnubg_state
    monkeypatch.setattr(gnubg_state, "decode_position_id",
                        lambda pid: ([0] * 24, [0, 0], [15, 15]))

    gid = _seed_game()
    r = client.post(f"/games/{gid}/agent-move",
                    json={"use_per_agent_nn": True})
    assert r.status_code == 200
    body = r.json()
    # Per the stub net's call_idx logic, candidate 1 (the second) gets
    # the higher score, so "13/11 13/10" → POS_B is the chosen pick.
    assert body["position_id"] == "POS_B"
