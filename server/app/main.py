from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, Optional
import uuid

from .game_state import GameState, decode_position_id, decode_match_id
from .gnubg_client import GnubgClient

app = FastAPI()
gnubg = GnubgClient()

# In-memory game store
games: Dict[str, GameState] = {}

class NewGameRequest(BaseModel):
    match_length: int = 3
    agent_id: int

class MoveRequest(BaseModel):
    move: str

def _build_game_state(game_id: str, pos_id: str, match_id: str) -> GameState:
    board, bar, off = decode_position_id(pos_id)
    match_info = decode_match_id(match_id)
    
    # Determine winner if game is over
    winner = None
    if match_info["game_over"]:
        winner = 1 if match_info["score"][1] > match_info["score"][0] else 0
        
    return GameState(
        game_id=game_id,
        match_id=match_id,
        position_id=pos_id,
        board=board,
        bar=bar,
        off=off,
        turn=match_info["turn"],
        dice=match_info["dice"],
        cube=match_info["cube"],
        cube_owner=match_info["cube_owner"],
        match_length=match_info["match_length"],
        score=match_info["score"],
        game_over=match_info["game_over"],
        winner=winner
    )

@app.get("/")
def read_root():
    return {"message": "Hello from Chaingammon Server"}

@app.post("/games", response_model=GameState)
def create_game(req: NewGameRequest):
    res = gnubg.new_match(req.match_length)
    if not res["position_id"] or not res["match_id"]:
        raise HTTPException(status_code=500, detail="Failed to initialize gnubg game")
    
    game_id = str(uuid.uuid4())
    state = _build_game_state(game_id, res["position_id"], res["match_id"])
    games[game_id] = state
    return state

@app.get("/games/{game_id}", response_model=GameState)
def get_game(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    return games[game_id]

@app.post("/games/{game_id}/roll", response_model=GameState)
def roll_dice(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    res = gnubg.roll_dice(game.position_id, game.match_id)
    if not res["position_id"] or not res["match_id"]:
        raise HTTPException(status_code=500, detail="gnubg roll failed")
        
    state = _build_game_state(game_id, res["position_id"], res["match_id"])
    games[game_id] = state
    return state

@app.post("/games/{game_id}/move", response_model=GameState)
def make_move(game_id: str, req: MoveRequest):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    res = gnubg.submit_move(game.position_id, game.match_id, req.move)
    
    # If the output doesn't contain a new position, the move was likely invalid.
    if not res["position_id"] or not res["match_id"]:
        raise HTTPException(status_code=400, detail=f"Invalid move or gnubg error:\n{res['output']}")
        
    state = _build_game_state(game_id, res["position_id"], res["match_id"])
    games[game_id] = state
    return state

@app.post("/games/{game_id}/agent-move", response_model=GameState)
def agent_move(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    res = gnubg.get_agent_move(game.position_id, game.match_id)
    if not res["position_id"] or not res["match_id"]:
        raise HTTPException(status_code=500, detail="gnubg agent move failed")
        
    state = _build_game_state(game_id, res["position_id"], res["match_id"])
    games[game_id] = state
    return state

@app.post("/games/{game_id}/resign", response_model=GameState)
def resign(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    res = gnubg.resign(game.position_id, game.match_id)
    if not res["position_id"] or not res["match_id"]:
        raise HTTPException(status_code=500, detail="gnubg resign failed")
        
    state = _build_game_state(game_id, res["position_id"], res["match_id"])
    games[game_id] = state
    return state