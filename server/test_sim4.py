from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

response = client.post("/games", json={"match_length": 2, "agent_id": 1})
game = response.json()
game_id = game["game_id"]

for moves in range(35):
    if not game["dice"]:
        res = client.post(f"/games/{game_id}/roll")
        game = res.json()
        print(f"Rolled: {game['dice']} (turn {game['turn']})")
    
    print(f"Move {moves}: turn={game['turn']}, dice={game['dice']}, match={game['match_id']}")
    res = client.post(f"/games/{game_id}/agent-move")
    new_game = res.json()
    if new_game["match_id"] == game["match_id"] and new_game["position_id"] == game["position_id"]:
        print(f"State stuck at move {moves}")
        break
    game = new_game

print(f"Game over: {game['game_over']}")
