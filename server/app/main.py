"""
main.py

FastAPI server for the Chaingammon backend.
Provides REST endpoints to manage game state, roll dice, and interact with the GNUbg agent.
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, Optional, List
import uuid
import random

from app.game_state import GameState
from app.gnubg_client import GNUBGClient

app = FastAPI(title="Chaingammon Server")

# In-memory stores for managing active game sessions.
# In a production environment with multiple workers, these would be backed by Redis/PostgreSQL.
games: Dict[str, GameState] = {}
gnubg_clients: Dict[str, GNUBGClient] = {}

class NewGameRequest(BaseModel):
    """Payload for starting a new game."""
    agent_id: str
    match_length: int = 1

class GameResponse(BaseModel):
    """Response containing the game ID and initial state."""
    game_id: str
    state: GameState

class MoveRequest(BaseModel):
    """Payload for a human player submitting a move."""
    move: str

class MoveResponse(BaseModel):
    """Response returning the state and the move chosen by the agent."""
    state: GameState
    agent_move: Optional[str] = None

@app.post("/games", response_model=GameResponse)
def create_game(req: NewGameRequest):
    """
    Start a new match against a specified agent.
    Initializes a new GameState and spawns a GNUBG subprocess.
    """
    game_id = str(uuid.uuid4())
    state = GameState.initial_state(req.match_length)

    # Initialize and start the GNUbg engine
    client = GNUBGClient()
    client.start()
    client.new_match(req.match_length)

    # Store references for future API calls
    games[game_id] = state
    gnubg_clients[game_id] = client

    return GameResponse(game_id=game_id, state=state)

@app.get("/games/{game_id}", response_model=GameState)
def get_game(game_id: str):
    """
    Fetch the current state of an active game.
    """
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    return games[game_id]

@app.post("/games/{game_id}/roll", response_model=GameState)
def roll_dice(game_id: str):
    """
    Roll two 6-sided dice for the current turn.
    The server acts as the trusted random number generator.
    """
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    state = games[game_id]

    # Validate game rules
    if state.game_over:
        raise HTTPException(status_code=400, detail="Game is over")
    if state.dice is not None:
        raise HTTPException(status_code=400, detail="Dice already rolled")

    # Generate random dice
    die1 = random.randint(1, 6)
    die2 = random.randint(1, 6)
    state.dice = [die1, die2]

    return state

@app.post("/games/{game_id}/move", response_model=GameState)
def make_move(game_id: str, req: MoveRequest):
    """
    Submit a move for the human player.
    The move is forwarded to GNUbg to keep the engine's internal board synchronized.
    """
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    state = games[game_id]
    client = gnubg_clients[game_id]

    # Validate turn state
    if state.game_over:
        raise HTTPException(status_code=400, detail="Game is over")
    if state.turn != 0:
        raise HTTPException(status_code=400, detail="Not human turn")
    if state.dice is None:
        raise HTTPException(status_code=400, detail="Dice not rolled")

    # Send the human's move to the engine
    client.submit_move(state, state.dice, req.move)

    # Check if the move ended the game
    if client.is_game_over():
        state.game_over = True
        state.winner = client.winner()
        client.stop() # Clean up the subprocess on a natural win

    # Transition turn to the agent
    state.turn = 1
    state.dice = None

    return state

@app.post("/games/{game_id}/agent-move", response_model=MoveResponse)
def agent_move(game_id: str):
    """
    Request the AI agent to compute and execute its move.
    Returns the string representation of the move chosen by GNUbg.
    """
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    state = games[game_id]
    client = gnubg_clients[game_id]

    # Validate turn state
    if state.game_over:
        raise HTTPException(status_code=400, detail="Game is over")
    if state.turn != 1:
        raise HTTPException(status_code=400, detail="Not agent turn")
    if state.dice is None:
        raise HTTPException(status_code=400, detail="Dice not rolled")

    # Ask the engine to decide on a move
    move_str = client.get_agent_move(state, state.dice)

    # Check if the agent's move won the game
    if client.is_game_over():
        state.game_over = True
        state.winner = client.winner()
        client.stop() # Clean up the subprocess on a natural win

    # Transition turn back to the human
    state.turn = 0
    state.dice = None

    return MoveResponse(state=state, agent_move=move_str)

@app.post("/games/{game_id}/resign", response_model=GameState)
def resign_game(game_id: str):
    """
    Allows the human player to concede the match.
    The agent is immediately declared the winner and subprocesses are cleaned up.
    """
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    state = games[game_id]
    state.game_over = True

    # gnubg (agent) is player 1, so it wins when human resigns
    state.winner = 1

    # Clean up the gnubg subprocess
    client = gnubg_clients.get(game_id)
    if client:
        client.stop()

    return state
