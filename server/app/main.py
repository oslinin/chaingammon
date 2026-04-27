from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, Optional
import os
import uuid

from .agent_overlay import Overlay, OverlayError, apply_overlay, update_overlay
from .chain_client import ChainClient, ChainError
from .ens_client import EnsClient, EnsError
from .game_record import (
    GameRecord,
    MoveEntry,
    PlayerRef,
    build_from_state,
    serialize_record,
)
from .game_state import GameState, decode_position_id, decode_match_id
from .gnubg_client import GnubgClient
from .og_storage_client import OgStorageError, get_blob, put_blob

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

# Per-game pinned agent_id (the iNFT the agent plays as). Set at create_game
# from `NewGameRequest.agent_id`. Used by /agent-move to look up the agent's
# experience overlay so the runtime pick is biased by its learned style.
_game_agent_id: Dict[str, int] = {}

# Per-game cached Overlay. Lazy-loaded on first /agent-move (one 0G Storage
# fetch per game, not per move). Static within a single game so the agent's
# play stays consistent even if /finalize on another game updates the
# overlay concurrently.
_game_overlays: Dict[str, Overlay] = {}

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
    _game_agent_id[game_id] = req.agent_id
    return state


def _ensure_overlay_loaded(game_id: str) -> Overlay:
    """Load (and cache) the agent's experience overlay for this game.

    Lazy-loaded so create_game stays fast — first /agent-move pays the
    one-time 0G Storage round-trip, subsequent moves hit the cache.
    Returns a default zero overlay if the agent hasn't been on-chain
    yet, the iNFT's `dataHashes[1]` is bytes32(0), or any error occurs
    along the way (a corrupted blob shouldn't block play).
    """
    if game_id in _game_overlays:
        return _game_overlays[game_id]
    agent_id = _game_agent_id.get(game_id, 0)
    if agent_id == 0:
        _game_overlays[game_id] = Overlay.default()
        return _game_overlays[game_id]
    try:
        chain = ChainClient.from_env()
        if chain.agent_registry is None:
            raise ChainError("AGENT_REGISTRY_ADDRESS not set")
        overlay = _fetch_overlay(chain, agent_id)
    except (ChainError, OgStorageError, OverlayError):
        overlay = Overlay.default()
    _game_overlays[game_id] = overlay
    return overlay

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
    """Phase 9: pick the agent's move using gnubg's full candidate list
    re-ranked by the agent's experience overlay. Two iNFTs minted on the
    same gnubg base but with divergent overlays will pick different
    moves on identical positions — that's what makes the iNFT meaningful.

    Auto-played positions (no legal moves, e.g. dance from the bar) fall
    back to gnubg's `get_agent_move` which lets gnubg play through.
    """
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    turn_before = game.turn
    dice_before = list(game.dice) if game.dice else []

    candidates = gnubg.get_candidate_moves(game.position_id, game.match_id)

    if not candidates:
        # No legal candidates — auto-play (bar dance, etc.). Overlay can't
        # help here since there's nothing to choose between.
        res = gnubg.get_agent_move(game.position_id, game.match_id)
        if not res["position_id"] or not res["match_id"]:
            raise HTTPException(status_code=500, detail="gnubg agent move failed")
        chosen_move = res.get("best_move") or "(auto-played)"
    else:
        overlay = _ensure_overlay_loaded(game_id)
        ranked = apply_overlay(candidates, overlay)
        chosen_move = ranked[0]["move"]
        res = gnubg.submit_move(game.position_id, game.match_id, chosen_move)
        if not res["position_id"] or not res["match_id"]:
            raise HTTPException(
                status_code=500,
                detail=f"gnubg rejected biased pick {chosen_move!r}: {res.get('output', '')}",
            )

    state = _build_game_state(game_id, res["position_id"], res["match_id"])
    games[game_id] = state
    _move_history.setdefault(game_id, []).append(
        MoveEntry(
            turn=turn_before,
            dice=dice_before,
            move=chosen_move,
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

    `winner_label` / `loser_label` are optional ENS subname labels (the
    `<label>` in `<label>.chaingammon.eth`). When non-empty, the server
    pushes reputation text records (`elo`, `last_match_id`) to that
    player's subname on the PlayerSubnameRegistrar. Phase 11 only handles
    setText; minting is driven by Phase 12 frontend.
    """

    winner_agent_id: int = 0
    winner_human_address: str = "0x0000000000000000000000000000000000000000"
    loser_agent_id: int = 0
    loser_human_address: str = "0x0000000000000000000000000000000000000000"
    winner_label: str = ""
    loser_label: str = ""


class FinalizeResponse(BaseModel):
    match_id: int
    tx_hash: str
    root_hash: str  # 0G Storage Merkle root of the uploaded game record
    # Phase 9: per-agent overlay update results, one entry per agent that
    # played in the match. Empty for human-vs-human matches.
    overlay_updates: list[dict] = []
    # Phase 11: per-side ENS text-record push results. One entry per side
    # whose `winner_label`/`loser_label` was provided. Skipped sides do
    # not appear. ENS push failure does NOT fail finalize — instead the
    # entry contains an `error` field so the caller can see what broke.
    ens_updates: list[dict] = []


def _fetch_overlay(chain: ChainClient, agent_id: int) -> Overlay:
    """Read the agent's current overlay from 0G Storage. If the iNFT's
    `dataHashes[1]` is bytes32(0) (a fresh agent that's never played), the
    fetch is skipped and a zero overlay is returned."""
    hashes = chain.agent_data_hashes(agent_id)
    overlay_hash = hashes[1]
    if overlay_hash == "0x" + "00" * 32:
        return Overlay.default()
    try:
        blob = get_blob(overlay_hash)
        return Overlay.from_bytes(blob)
    except (OgStorageError, OverlayError):
        # Fall back to a zero overlay so a corrupted blob doesn't block
        # finalize. Phase 9.5 can add stricter handling.
        return Overlay.default()


def _push_ens_updates(
    *,
    chain: ChainClient,
    label: str,
    agent_id: int,
    human_address: str,
    match_id: int,
) -> dict:
    """Push reputation text records to `<label>.chaingammon.eth`.

    For agent sides we push the agent's ELO from MatchRegistry; for human
    sides we push the human's ELO. `last_match_id` is the just-recorded
    matchId so any follower can look up the latest archive on 0G Storage.

    The ENS client is constructed lazily here (inside the helper) so that
    finalize_game on a network without PLAYER_SUBNAME_REGISTRAR_ADDRESS
    set still works — only labelled sides pay for the env lookup.
    """
    ens = EnsClient.from_env()
    node = ens.subname_node(label)
    if agent_id != 0:
        elo = chain.agent_elo(agent_id)
    else:
        elo = chain.human_elo(human_address)
    elo_tx = ens.set_text(node=node, key="elo", value=str(elo))
    last_tx = ens.set_text(node=node, key="last_match_id", value=str(match_id))
    return {
        "label": label,
        "node": node,
        "elo": elo,
        "elo_tx_hash": elo_tx,
        "last_match_id_tx_hash": last_tx,
    }


def _update_agent_overlay(
    chain: ChainClient,
    agent_id: int,
    won: bool,
    moves: list[MoveEntry],
) -> dict:
    """Compute the new overlay, upload it to 0G Storage, and call
    `updateOverlayHash` on the agent iNFT. Returns a small dict for the
    finalize response."""
    current = _fetch_overlay(chain, agent_id)
    new_overlay = update_overlay(
        current,
        agent_moves=moves,
        won=won,
        match_count=current.match_count,
    )
    blob = new_overlay.to_bytes()
    upload = put_blob(blob)
    tx_hash = chain.update_overlay_hash(agent_id, upload.root_hash)
    return {
        "agent_id": agent_id,
        "won": won,
        "overlay_root_hash": upload.root_hash,
        "update_overlay_tx_hash": tx_hash,
        "match_count": new_overlay.match_count,
    }


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

    # Phase 9 — for each agent that played, recompute its experience
    # overlay, upload to 0G Storage, and pin the new hash on the iNFT
    # via updateOverlayHash. Humans get no overlay (their style profile
    # is a separate descriptive blob, not a learning loop).
    overlay_updates: list[dict] = []
    moves = _move_history.get(game_id, [])
    if chain.agent_registry is not None:
        if req.winner_agent_id != 0:
            try:
                overlay_updates.append(
                    _update_agent_overlay(chain, req.winner_agent_id, won=True, moves=moves)
                )
            except (OgStorageError, ChainError) as e:
                raise HTTPException(
                    status_code=502, detail=f"winner overlay update failed: {e}"
                ) from e
        if req.loser_agent_id != 0:
            try:
                overlay_updates.append(
                    _update_agent_overlay(chain, req.loser_agent_id, won=False, moves=moves)
                )
            except (OgStorageError, ChainError) as e:
                raise HTTPException(
                    status_code=502, detail=f"loser overlay update failed: {e}"
                ) from e

    # Phase 11 — push reputation text records to each labelled side's
    # subname. Failure here is non-fatal: ENS reachability shouldn't block
    # finalize, since the match is already on-chain. Errors are surfaced
    # in the response so the frontend can retry.
    ens_updates: list[dict] = []
    sides = [
        ("winner", req.winner_label, req.winner_agent_id, req.winner_human_address),
        ("loser", req.loser_label, req.loser_agent_id, req.loser_human_address),
    ]
    for side_name, label, agent_id, human_addr in sides:
        if not label:
            continue
        try:
            ens_updates.append(
                _push_ens_updates(
                    chain=chain,
                    label=label,
                    agent_id=agent_id,
                    human_address=human_addr,
                    match_id=finalized.match_id,
                )
            )
        except (EnsError, ChainError) as e:
            ens_updates.append({"label": label, "side": side_name, "error": str(e)})

    return FinalizeResponse(
        match_id=finalized.match_id,
        tx_hash=finalized.tx_hash,
        root_hash=upload.root_hash,
        overlay_updates=overlay_updates,
        ens_updates=ens_updates,
    )
