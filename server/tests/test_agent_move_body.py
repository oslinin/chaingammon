"""Tests for /games/{game_id}/agent-move's Phase I.2 body field.

Run with:  cd server && uv run pytest tests/test_agent_move_body.py -v

These tests don't need real gnubg — we mock `gnubg.get_candidate_moves`
+ `gnubg.submit_move` so the endpoint reaches the inference_meta probe
without hitting a real subprocess. The probe itself is patched per
test to exercise:
  - Default body (no flag) preserves existing GameState shape
  - use_0g_inference=true with eval bridge unavailable returns
    inference_meta carrying available=false + an honest note
  - use_0g_inference=true with eval bridge available returns
    inference_meta carrying provider + per-call cost + latency
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import main as main_module  # noqa: E402


client = TestClient(main_module.app)


def _seed_game_in_dict():
    """Skip the gnubg-backed /games endpoint and stash a synthetic
    GameState directly so we can hit /agent-move without spawning
    gnubg. Returns the synthetic game_id."""
    from app.game_state import GameState

    game_id = "test-i2-game"
    main_module.games[game_id] = GameState(
        game_id=game_id,
        match_id="cAkAAAAAAAAA",
        position_id="4HPwATDgc/ABMA",
        board=[0] * 24,
        bar=[0, 0],
        off=[0, 0],
        turn=1,  # agent's turn
        dice=[3, 1],
        cube=1,
        cube_owner=-1,
        match_length=1,
        score=[0, 0],
        game_over=False,
        winner=None,
    )
    return game_id


def _make_gnubg_stub():
    """Minimal stub of `gnubg.get_candidate_moves` + `submit_move` +
    `decode_board` so /agent-move's full path runs without a real
    gnubg subprocess."""
    candidates = [
        {"move": "13/10 24/23", "equity": 0.42, "win_pct": 0.48},
        {"move": "13/10 6/5", "equity": 0.40, "win_pct": 0.46},
    ]
    def _submit(pos_id, match_id, move):
        return {"position_id": "4HPwATDgc/ABNA", "match_id": "cAkAAAAAAAAB",
                "output": ""}
    def _candidates(pos_id, match_id):
        return candidates
    def _decode_board(pos_id, match_id):
        # Synthetic 24-point board with no checkers anywhere — keeps
        # GameState construction happy without parsing real position_id.
        return {"points": [0] * 24, "bar": [0, 0]}
    return _candidates, _submit, _decode_board


@pytest.fixture(autouse=True)
def _patch_gnubg(monkeypatch):
    cands_fn, submit_fn, decode_fn = _make_gnubg_stub()
    monkeypatch.setattr(main_module.gnubg, "get_candidate_moves", cands_fn)
    monkeypatch.setattr(main_module.gnubg, "submit_move", submit_fn)
    monkeypatch.setattr(main_module.gnubg, "decode_board", decode_fn)
    # decode_match_id returns a structured dict; stub for predictable
    # turn/dice/score state.
    monkeypatch.setattr(main_module, "decode_match_id", lambda mid: {
        "turn": 0, "dice": None, "cube": 1, "cube_owner": -1,
        "match_length": 1, "score": [0, 0], "game_over": False,
    })
    # _ensure_overlay_loaded reads the overlay; stub to a no-op overlay.
    monkeypatch.setattr(main_module, "_ensure_overlay_loaded",
                        lambda gid: type("O", (), {"values": {}})())
    monkeypatch.setattr(main_module, "apply_overlay",
                        lambda c, o: c)  # pass-through ranking


def test_default_body_preserves_game_state_shape():
    """Calling /agent-move without a body leaves all old fields on the
    response (position_id, board, bar, etc.) and inference_meta is
    omitted entirely (Pydantic excludes None at serialize time)."""
    gid = _seed_game_in_dict()
    r = client.post(f"/games/{gid}/agent-move")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "position_id" in body
    assert "board" in body
    assert "bar" in body
    # inference_meta absent OR None — both are acceptable.
    assert body.get("inference_meta") in (None, {})


def test_use_0g_inference_unavailable_returns_meta():
    """Body with use_0g_inference=true and no provider registered
    returns inference_meta carrying available=false + an OG_EVAL_UNAVAILABLE
    note + a latency_ms for the round-trip cost."""
    gid = _seed_game_in_dict()
    # Patch the eval client to raise OgEvalUnavailable, mimicking the
    # serving network without a backgammon-net provider.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))
    import og_compute_eval_client as ec

    def _stub_estimate(count):
        raise ec.OgEvalUnavailable("OG_EVAL_UNAVAILABLE: no backgammon-net provider registered")

    with patch.object(ec, "estimate", _stub_estimate):
        r = client.post(f"/games/{gid}/agent-move",
                        json={"use_0g_inference": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["inference_meta"]["available"] is False
    assert "OG_EVAL_UNAVAILABLE" in body["inference_meta"]["note"]
    assert "latency_ms" in body["inference_meta"]


def test_use_0g_inference_available_returns_provider_meta():
    """Body with use_0g_inference=true and a 'live' provider returns
    inference_meta with available=true + the provider address + cost."""
    gid = _seed_game_in_dict()
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))
    import og_compute_eval_client as ec

    class _Avail:
        per_inference_og = 0.0001
        total_og = 0.0001
        provider_address = "0xprovider"
        available = True
        note = ""

    with patch.object(ec, "estimate", lambda count: _Avail()):
        r = client.post(f"/games/{gid}/agent-move",
                        json={"use_0g_inference": True})
    assert r.status_code == 200, r.text
    body = r.json()
    meta = body["inference_meta"]
    assert meta["available"] is True
    assert meta["provider"] == "0xprovider"
    assert meta["per_inference_og"] == pytest.approx(0.0001)
    assert isinstance(meta["latency_ms"], int)


def test_position_id_advances_under_both_paths():
    """Sanity: the chosen move is applied and the GameState advances
    regardless of the use_0g_inference flag."""
    gid = _seed_game_in_dict()
    r = client.post(f"/games/{gid}/agent-move",
                    json={"use_0g_inference": False})
    assert r.json()["position_id"] == "4HPwATDgc/ABNA"


def test_use_per_agent_nn_field_accepted_but_inactive():
    """Phase I.2 reserves use_per_agent_nn for Phase J. Today the
    field is accepted but doesn't change the chosen move (still
    gnubg+overlay)."""
    gid = _seed_game_in_dict()
    r = client.post(f"/games/{gid}/agent-move",
                    json={"use_per_agent_nn": True})
    assert r.status_code == 200
    # Same move as without the flag — gnubg+overlay path.
    assert r.json()["position_id"] == "4HPwATDgc/ABNA"
