"""
test_phase1_game.py

End-to-end integration tests for the Chaingammon backend Phase 1 implementation.
Verifies that the FastAPI server correctly handles the flow of a full backgammon game
and properly interacts with the underlying GNUbg engine wrapper.
"""
import pytest
from fastapi.testclient import TestClient
import sys; import os; sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.main import app
import time

# Create a synchronous test client for the FastAPI app
client = TestClient(app)

def test_full_game_happy_path():
    """
    Simulates a full turn sequence of a backgammon game against the gnubg agent
    via the REST API.

    Steps tested:
    1. Creating a new match.
    2. The human player rolling dice.
    3. The human player submitting a move.
    4. Rolling dice for the agent.
    5. Requesting the agent's move.
    6. The human player resigning to end the game and trigger cleanup.
    """

    # 1. Create a new game
    resp = client.post("/games", json={"agent_id": "gnubg-1", "match_length": 1})
    assert resp.status_code == 200, "Should successfully create a new game."
    data = resp.json()
    game_id = data["game_id"]
    state = data["state"]
    assert state["match_length"] == 1, "Match length should match the request."
    assert state["game_over"] is False, "Game should not be over immediately."

    # 2. Player rolls dice
    resp = client.post(f"/games/{game_id}/roll")
    assert resp.status_code == 200, "Player should be able to roll dice."
    state = resp.json()
    assert state["dice"] is not None, "Dice should be populated."
    assert len(state["dice"]) == 2, "Should roll exactly two dice."

    # 3. Player makes move
    # Note: Because dice rolls are randomized by the server, we submit a generic move.
    # The gnubg wrapper doesn't currently strictly validate human move legality against
    # the randomly rolled dice unless configured to do so; it just passes the string
    # to the `move` command in the pexpect session.
    resp = client.post(f"/games/{game_id}/move", json={"move": "8/4 6/4"})
    assert resp.status_code == 200, "Player should be able to submit a move."
    state = resp.json()
    assert state["turn"] == 1, "Turn should transition to the agent (1)."
    assert state["dice"] is None, "Dice should be cleared after a move."

    # 4. Agent rolls dice (via server API call)
    resp = client.post(f"/games/{game_id}/roll")
    assert resp.status_code == 200, "Agent should be able to roll dice."
    state = resp.json()
    assert state["dice"] is not None, "Dice should be populated for the agent."

    # 5. Agent makes move
    resp = client.post(f"/games/{game_id}/agent-move")
    assert resp.status_code == 200, "Agent should compute and return a move."
    data = resp.json()
    state = data["state"]

    assert state["turn"] == 0, "Turn should transition back to the human (0)."
    assert "agent_move" in data, "The response should contain the parsed move string from gnubg."

    # 6. Player resigns
    resp = client.post(f"/games/{game_id}/resign")
    assert resp.status_code == 200, "Player should be able to resign."
    state = resp.json()

    assert state["game_over"] is True, "Resigning should end the game."
    assert state["winner"] == 1, "Agent should win if human resigns."
