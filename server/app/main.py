from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, Optional
import os
import uuid

from .chain_client import ChainClient, ChainError
from .game_record import (
    GameRecord,
    MoveEntry,
    PlayerRef,
    build_from_state,
    serialize_record,
)
from .game_state import GameState, decode_position_id, decode_match_id
from .gnubg_client import GnubgClient
from .og_storage_client import OgStorageError, put_blob

app = FastAPI()
gnubg = GnubgClient()

# In-memory game store
games: Dict[str, GameState] = {}

# When did each game start (used as the GameRecord's started_at).
_game_started_at: Dict[str, str] = {}

# Per-game move history. Each entry is one checker-move commit (after a
# roll). Roll-only events aren't moves; cube actions are tracked separately
# (not in v1). Populated by /move and /agent-move; consumed by /finalize.
_move_history: Dict[str, list[MoveEntry]] = {}

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
    _game_started_at[game_id] = datetime.now(timezone.utc).isoformat()
    _move_history[game_id] = []
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
    # Capture pre-move turn + dice for the GameRecord. State.dice gets cleared
    # after a successful submit, so we have to read it before the gnubg call.
    turn_before = game.turn
    dice_before = list(game.dice) if game.dice else []
    res = gnubg.submit_move(game.position_id, game.match_id, req.move)

    # If the output doesn't contain a new position, the move was likely invalid.
    if not res["position_id"] or not res["match_id"]:
        raise HTTPException(status_code=400, detail=f"Invalid move or gnubg error:\n{res['output']}")

    state = _build_game_state(game_id, res["position_id"], res["match_id"])
    games[game_id] = state
    _move_history.setdefault(game_id, []).append(
        MoveEntry(
            turn=turn_before,
            dice=dice_before,
            move=req.move,
            position_id_after=state.position_id,
        )
    )
    return state

@app.post("/games/{game_id}/agent-move", response_model=GameState)
def agent_move(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    turn_before = game.turn
    dice_before = list(game.dice) if game.dice else []
    res = gnubg.get_agent_move(game.position_id, game.match_id)
    if not res["position_id"] or not res["match_id"]:
        raise HTTPException(status_code=500, detail="gnubg agent move failed")

    state = _build_game_state(game_id, res["position_id"], res["match_id"])
    games[game_id] = state
    move_str = res.get("best_move") or "(auto-played)"
    _move_history.setdefault(game_id, []).append(
        MoveEntry(
            turn=turn_before,
            dice=dice_before,
            move=move_str,
            position_id_after=state.position_id,
        )
    )
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


# ---------------------------------------------------------------------------
# Phase 7 — finalize a finished game on 0G Storage + 0G Chain
# ---------------------------------------------------------------------------


class FinalizeRequest(BaseModel):
    """Identifies the participants so we can record the match on-chain.

    Exactly one of agent_id / human_address must be set per side. agent_id
    of 0 means "no agent on this side" (i.e. human player); human_address
    of zero-address means "no human on this side" (i.e. agent player).
    """

    winner_agent_id: int = 0
    winner_human_address: str = "0x0000000000000000000000000000000000000000"
    loser_agent_id: int = 0
    loser_human_address: str = "0x0000000000000000000000000000000000000000"


class FinalizeResponse(BaseModel):
    match_id: int
    tx_hash: str
    root_hash: str  # 0G Storage Merkle root of the uploaded game record


@app.post("/games/{game_id}/finalize", response_model=FinalizeResponse)
def finalize_game(game_id: str, req: FinalizeRequest):
    """Wrap up a finished game: upload the GameRecord to 0G Storage, then
    call MatchRegistry.recordMatch with the resulting Merkle root hash so
    the on-chain match is cryptographically tied to the off-chain archive.

    v1 calls recordMatch directly via web3.py; Phase 18 will route this
    through a KeeperHub workflow instead.
    """
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    state = games[game_id]
    if not state.game_over:
        raise HTTPException(status_code=400, detail="Game has not ended yet")

    # Build the GameRecord. Move history isn't tracked in v1 — just the final
    # position and the gnubg-native match id so any tool with gnubg installed
    # can reconstruct the end state bit-perfectly.
    winner = (
        PlayerRef(kind="human", address=req.winner_human_address)
        if req.winner_agent_id == 0
        else PlayerRef(kind="agent", agent_id=req.winner_agent_id)
    )
    loser = (
        PlayerRef(kind="human", address=req.loser_human_address)
        if req.loser_agent_id == 0
        else PlayerRef(kind="agent", agent_id=req.loser_agent_id)
    )
    record = build_from_state(
        state,
        winner=winner,
        loser=loser,
        moves=_move_history.get(game_id, []),
        started_at=_game_started_at.get(game_id),
        ended_at=datetime.now(timezone.utc).isoformat(),
    )
    payload = serialize_record(record)

    try:
        upload = put_blob(payload)
    except OgStorageError as e:
        raise HTTPException(status_code=502, detail=f"0G Storage upload failed: {e}") from e

    try:
        chain = ChainClient.from_env()
    except ChainError as e:
        raise HTTPException(status_code=500, detail=f"chain client misconfigured: {e}") from e

    try:
        finalized = chain.record_match(
            winner_agent_id=req.winner_agent_id,
            winner_human=req.winner_human_address,
            loser_agent_id=req.loser_agent_id,
            loser_human=req.loser_human_address,
            match_length=int(state.match_length),
            game_record_hash=upload.root_hash,
        )
    except ChainError as e:
        raise HTTPException(status_code=502, detail=f"recordMatch failed: {e}") from e

    return FinalizeResponse(
        match_id=finalized.match_id,
        tx_hash=finalized.tx_hash,
        root_hash=upload.root_hash,
    )
