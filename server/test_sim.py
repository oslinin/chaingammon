import httpx
import time
import subprocess

proc = subprocess.Popen(["uv", "run", "uvicorn", "app.main:app", "--port", "8002"])
time.sleep(2)
try:
    game = httpx.post("http://127.0.0.1:8002/games", json={"match_length": 2, "agent_id": 1}).json()
    game_id = game["game_id"]
    for i in range(15):
        print(f"Move {i}: turn={game['turn']}, dice={game['dice']}, game_over={game['game_over']}")
        res = httpx.post(f"http://127.0.0.1:8002/games/{game_id}/agent-move")
        if res.status_code != 200:
            print("Roll needed")
            res = httpx.post(f"http://127.0.0.1:8002/games/{game_id}/roll")
            res = httpx.post(f"http://127.0.0.1:8002/games/{game_id}/agent-move")
        game = res.json()
        print("  -> " + str(game["dice"]) + " " + str(game["turn"]))
except Exception as e:
    print(e)
finally:
    proc.terminate()
