"""
Phase 7 unit tests for move-history tracking through the FastAPI endpoints.

The runtime path /games → /games/{id}/move and /games/{id}/agent-move is
expected to populate _move_history so that /finalize can pass the moves
into the GameRecord. These tests mock gnubg + the game-state builder so
nothing depends on the gnubg binary or any network.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

# Make `app` importable when running pytest from server/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from fastapi.testclient import TestClient

from app import main as main_module  # noqa: E402
from app.game_state import GameState  # noqa: E402


HUMAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"


def _state(
    *,
    game_id: str,
    position_id: str,
    match_id: str,
    turn: int,
    dice,
    game_over: bool = False,
    winner=None,
) -> GameState:
    """Hand-build a GameState bypassing position/match-id decoding."""
    return GameState(
        game_id=game_id,
        match_id=match_id,
        position_id=position_id,
        board=[0] * 24,
        bar=[0, 0],
        off=[0, 0],
        turn=turn,
        dice=dice,
        cube=1,
        cube_owner=-1,
        match_length=1,
        score=[0, 0],
        game_over=game_over,
        winner=winner,
    )


@pytest.fixture(autouse=True)
def reset_in_memory_state():
    """Clear in-memory dicts between tests so they don't leak."""
    main_module.games.clear()
    main_module._game_started_at.clear()
    main_module._move_history.clear()
    yield
    main_module.games.clear()
    main_module._game_started_at.clear()
    main_module._move_history.clear()


@pytest.fixture
def client(monkeypatch):
    # Mock gnubg's external calls; we never spawn the binary.
    mock_gnubg = MagicMock()
    mock_gnubg.new_match.return_value = {
        "position_id": "POS_INIT",
        "match_id": "MATCH_INIT",
        "output": "",
    }
    mock_gnubg.roll_dice.return_value = {
        "position_id": "POS_AFTER_ROLL",
        "match_id": "MATCH_AFTER_ROLL",
        "output": "",
    }
    mock_gnubg.submit_move.return_value = {
        "position_id": "POS_AFTER_HUMAN",
        "match_id": "MATCH_AFTER_HUMAN",
        "output": "",
    }
    mock_gnubg.get_agent_move.return_value = {
        "position_id": "POS_AFTER_AGENT",
        "match_id": "MATCH_AFTER_AGENT",
        "output": "",
        "best_move": "13/11 13/9",
    }
    monkeypatch.setattr(main_module, "gnubg", mock_gnubg)

    # Mock the position/match-id decoders so we can hand-build states from
    # arbitrary gnubg responses without real backgammon state.
    state_iter = iter([
        _state(game_id="g", position_id="POS_INIT", match_id="MATCH_INIT", turn=0, dice=None),
        _state(game_id="g", position_id="POS_AFTER_ROLL", match_id="MATCH_AFTER_ROLL", turn=0, dice=[3, 1]),
        _state(game_id="g", position_id="POS_AFTER_HUMAN", match_id="MATCH_AFTER_HUMAN", turn=1, dice=None),
        _state(game_id="g", position_id="POS_AFTER_AGENT_ROLL", match_id="MATCH_AGENT_ROLL", turn=1, dice=[5, 2]),
        _state(game_id="g", position_id="POS_AFTER_AGENT", match_id="MATCH_AFTER_AGENT", turn=0, dice=None,
               game_over=True, winner=0),
    ])

    def _fake_build(game_id, pos_id, match_id):
        st = next(state_iter)
        # Patch the game_id to match what the endpoint actually creates.
        return st.model_copy(update={"game_id": game_id})

    monkeypatch.setattr(main_module, "_build_game_state", _fake_build)

    return TestClient(main_module.app)


def test_create_game_initialises_empty_move_history(client):
    resp = client.post("/games", json={"agent_id": 1, "match_length": 1})
    assert resp.status_code == 200
    game_id = resp.json()["game_id"]
    assert main_module._move_history[game_id] == []


def test_make_move_records_move_with_pre_move_dice_and_turn(client):
    resp = client.post("/games", json={"agent_id": 1, "match_length": 1})
    game_id = resp.json()["game_id"]

    # Roll: dice get populated on the state, no move recorded yet.
    client.post(f"/games/{game_id}/roll")
    assert main_module._move_history[game_id] == [], "rolling alone shouldn't record a move"

    # Human submits the move; the recorded MoveEntry should carry the
    # turn/dice that existed *before* the move (since dice get cleared).
    client.post(f"/games/{game_id}/move", json={"move": "8/5 6/5"})
    history = main_module._move_history[game_id]
    assert len(history) == 1
    entry = history[0]
    assert entry.turn == 0  # human is player 0
    assert entry.dice == [3, 1]  # pre-move dice from the state after /roll
    assert entry.move == "8/5 6/5"
    assert entry.position_id_after == "POS_AFTER_HUMAN"


def test_agent_move_records_best_move_returned_by_gnubg(client):
    resp = client.post("/games", json={"agent_id": 1, "match_length": 1})
    game_id = resp.json()["game_id"]
    client.post(f"/games/{game_id}/roll")
    client.post(f"/games/{game_id}/move", json={"move": "8/5 6/5"})
    # Agent's turn now: roll then agent-move.
    client.post(f"/games/{game_id}/roll")
    client.post(f"/games/{game_id}/agent-move")

    history = main_module._move_history[game_id]
    assert len(history) == 2
    agent_entry = history[1]
    assert agent_entry.turn == 1  # gnubg is player 1
    assert agent_entry.dice == [5, 2]
    assert agent_entry.move == "13/11 13/9", "should record gnubg's best_move string"
    assert agent_entry.position_id_after == "POS_AFTER_AGENT"
