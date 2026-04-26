import pytest
from fastapi.testclient import TestClient
import sys; import os; sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.main import app
import time

client = TestClient(app)

def test_full_game_happy_path():
    # 1. Create a game
    resp = client.post("/games", json={"agent_id": "gnubg-1", "match_length": 1})
    assert resp.status_code == 200
    data = resp.json()
    game_id = data["game_id"]
    state = data["state"]
    assert state["match_length"] == 1
    assert state["game_over"] is False

    # 2. Player rolls dice
    resp = client.post(f"/games/{game_id}/roll")
    assert resp.status_code == 200
    state = resp.json()
    assert state["dice"] is not None
    assert len(state["dice"]) == 2

    # 3. Player makes move
    resp = client.post(f"/games/{game_id}/move", json={"move": "8/4 6/4"})
    assert resp.status_code == 200
    state = resp.json()
    assert state["turn"] == 1
    assert state["dice"] is None

    # 4. Agent rolls dice (via server)
    resp = client.post(f"/games/{game_id}/roll")
    assert resp.status_code == 200
    state = resp.json()
    assert state["dice"] is not None

    # 5. Agent makes move
    resp = client.post(f"/games/{game_id}/agent-move")
    assert resp.status_code == 200
    data = resp.json()
    state = data["state"]
    assert state["turn"] == 0
    # ensure agent_move is present
    assert "agent_move" in data

    # 6. Player resigns
    resp = client.post(f"/games/{game_id}/resign")
    assert resp.status_code == 200
    state = resp.json()
    assert state["game_over"] is True
    assert state["winner"] == 1
