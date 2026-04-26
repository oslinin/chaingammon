from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

response = client.post("/games", json={"match_length": 2, "agent_id": 1})
game = response.json()
game_id = game["game_id"]

for i in range(10):
    print(f"Move {i}: turn={game['turn']}, dice={game['dice']}, game_over={game['game_over']}, pos={game['position_id']}, match={game['match_id']}")
    if not game["dice"]:
        game = client.post(f"/games/{game_id}/roll").json()
        print(f"  Rolled: dice={game['dice']}")
    game = client.post(f"/games/{game_id}/agent-move").json()
