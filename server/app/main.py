from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, Optional, List
import uuid
import random

from app.game_state import GameState
from app.gnubg_client import GNUBGClient

app = FastAPI(title="Chaingammon Server")

# In-memory stores
games: Dict[str, GameState] = {}
gnubg_clients: Dict[str, GNUBGClient] = {}

class NewGameRequest(BaseModel):
    agent_id: str
    match_length: int = 1

class GameResponse(BaseModel):
    game_id: str
    state: GameState

class MoveRequest(BaseModel):
    move: str

class MoveResponse(BaseModel):
    state: GameState
    agent_move: Optional[str] = None

@app.post("/games", response_model=GameResponse)
def create_game(req: NewGameRequest):
    game_id = str(uuid.uuid4())
    state = GameState.initial_state(req.match_length)

    # Init gnubg
    client = GNUBGClient()
    client.start()
    client.new_match(req.match_length)

    games[game_id] = state
    gnubg_clients[game_id] = client

    return GameResponse(game_id=game_id, state=state)

@app.get("/games/{game_id}", response_model=GameState)
def get_game(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    return games[game_id]

@app.post("/games/{game_id}/roll", response_model=GameState)
def roll_dice(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    state = games[game_id]
    if state.game_over:
        raise HTTPException(status_code=400, detail="Game is over")
    if state.dice is not None:
        raise HTTPException(status_code=400, detail="Dice already rolled")

    die1 = random.randint(1, 6)
    die2 = random.randint(1, 6)
    state.dice = [die1, die2]

    return state

@app.post("/games/{game_id}/move", response_model=GameState)
def make_move(game_id: str, req: MoveRequest):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    state = games[game_id]
    client = gnubg_clients[game_id]

    if state.game_over:
        raise HTTPException(status_code=400, detail="Game is over")
    if state.turn != 0:
        raise HTTPException(status_code=400, detail="Not human turn")
    if state.dice is None:
        raise HTTPException(status_code=400, detail="Dice not rolled")

    client.submit_move(state, state.dice, req.move)

    # We update the state
    if client.is_game_over():
        state.game_over = True
        state.winner = client.winner()
        client.stop() # Cleanup on natural win

    state.turn = 1
    state.dice = None

    return state

@app.post("/games/{game_id}/agent-move", response_model=MoveResponse)
def agent_move(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    state = games[game_id]
    client = gnubg_clients[game_id]

    if state.game_over:
        raise HTTPException(status_code=400, detail="Game is over")
    if state.turn != 1:
        raise HTTPException(status_code=400, detail="Not agent turn")
    if state.dice is None:
        raise HTTPException(status_code=400, detail="Dice not rolled")

    move_str = client.get_agent_move(state, state.dice)

    if client.is_game_over():
        state.game_over = True
        state.winner = client.winner()
        client.stop() # Cleanup on natural win

    state.turn = 0
    state.dice = None

    return MoveResponse(state=state, agent_move=move_str)

@app.post("/games/{game_id}/resign", response_model=GameState)
def resign_game(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    state = games[game_id]
    state.game_over = True
    state.winner = 1 # gnubg wins if human resigns

    # Cleanup
    client = gnubg_clients.get(game_id)
    if client:
        client.stop()

    return state
