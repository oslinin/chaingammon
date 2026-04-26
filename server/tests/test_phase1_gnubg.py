import pytest
from fastapi.testclient import TestClient
import sys
from pathlib import Path

# Add the server directory to sys.path so we can import app
sys.path.append(str(Path(__file__).parent.parent))

from app.main import app

client = TestClient(app)

def test_gnubg_happy_path():
    # Start a 2-point match
    response = client.post("/games", json={"match_length": 2, "agent_id": 1})
    assert response.status_code == 200
    game = response.json()
    
    assert "game_id" in game
    assert game["match_length"] == 2
    assert game["board"] is not None
    assert len(game["board"]) == 24
    assert game["game_over"] is False
    
    game_id = game["game_id"]
    
    # Play the game to completion by asking the agent to move repeatedly.
    # gnubg `play` command will automatically roll dice if needed and make the move.
    
    # We will limit iterations to avoid an infinite loop in case of bugs
    max_moves = 200
    moves = 0
    
    while not game["game_over"] and moves < max_moves:
        if not game["dice"]:
            res_roll = client.post(f"/games/{game_id}/roll")
            assert res_roll.status_code == 200
            game = res_roll.json()
            
        res = client.post(f"/games/{game_id}/agent-move")
        assert res.status_code == 200
        
        new_game = res.json()
        if new_game["match_id"] == game["match_id"]:
            # State did not change, break to avoid infinite loop
            break
        game = new_game
        moves += 1
        
    assert game["game_over"] is True
    assert game["winner"] is not None
