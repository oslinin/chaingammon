from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from pydantic import BaseModel
from typing import Dict, List, Optional
import hashlib
import json
import os
import re
import sys
import uuid

# `agent/` is a sibling directory of `server/`, not a package.
# /agents/{id}/recommend-teammate (below) needs `agent_profile.load_profile`
# (the runtime resolver that picks OverlayProfile vs ModelProfile from a 0G
# storage blob) and `teammate_selection.recommend_teammate`. Insert agent/
# onto sys.path once at module import — same pattern used by tests like
# server/tests/test_phase9_overlay_integration.py.
_AGENT_DIR = Path(__file__).resolve().parents[2] / "agent"
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))

# ENS label rules: lowercase alphanumeric + hyphens, must start and end with
# an alphanumeric char, 1–63 characters.  Mirrors the validation in the
# frontend's ProfileBadge so both layers agree on what is acceptable.
_LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")

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
# Phase 20: the Next.js frontend at :3000 calls these endpoints cross-origin
# (live match flow, subname mint, replay fetch). Open CORS so browser fetches
# succeed in dev. Production should restrict `allow_origins` to the deployed
# frontend host.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
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
    # Phase 24 External Player protocol: ask gnubg for its
    # authoritative structured board (rawboard format) instead of
    # decoding position_id ourselves. gnubg's `decode_board` runs in a
    # hermetic subprocess with all auto-behaviour disabled (auto-roll,
    # auto-game, auto-move) so it returns the exact state at this
    # position — no extra moves, no perspective flips.
    decoded = gnubg.decode_board(pos_id, match_id)
    board = list(decoded["points"])    # 24 signed counts: + = human, - = agent
    bar = list(decoded["bar"])         # [human_bar, agent_bar]
    p0_total = sum(c for c in board if c > 0) + bar[0]
    p1_total = -sum(c for c in board if c < 0) + bar[1]
    off = [15 - p0_total, 15 - p1_total]

    match_info = decode_match_id(match_id)

    # Determine winner if game is over.
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
# Phase 36 — ENS text records read endpoint
#
# Thin wrapper around EnsClient so the frontend can read live text records
# without needing a wagmi connection or on-chain RPC key in the browser.
# Returns the five text record keys for a given subname label. Returns empty
# strings for unset keys rather than errors so the UI renders cleanly.
# ---------------------------------------------------------------------------


@app.get("/ens-records/{label}")
def ens_records(label: str):
    """Return all five reputation text records for `<label>.chaingammon.eth`.

    The five keys (elo, match_count, last_match_id, style_uri, archive_uri)
    are the canonical set written by the protocol. Unset keys return "".

    Requires RPC_URL, PLAYER_SUBNAME_REGISTRAR_ADDRESS, and DEPLOYER_PRIVATE_KEY
    in the server environment. Returns a 503 when those are missing or the RPC
    is unreachable, so the /ens/[matchId] frontend page can show a graceful
    error rather than a crash.
    """
    TEXT_KEYS = ["elo", "match_count", "last_match_id", "style_uri", "archive_uri"]
    try:
        ens = EnsClient.from_env()
    except EnsError as e:
        raise HTTPException(
            status_code=503,
            detail=f"ENS client not configured: {e} — set RPC_URL, "
            "PLAYER_SUBNAME_REGISTRAR_ADDRESS, and DEPLOYER_PRIVATE_KEY",
        ) from e
    node = ens.subname_node(label)
    records: dict[str, str] = {}
    for key in TEXT_KEYS:
        try:
            records[key] = ens.text(node=node, key=key)
        except EnsError:
            records[key] = ""
    return {"label": label, "records": records}


# ---------------------------------------------------------------------------
# Phase 20 — match replay: fetch GameRecord from 0G Storage, decode positions
# ---------------------------------------------------------------------------


@app.get("/game-records/{root_hash}")
def get_game_record(root_hash: str):
    """Return the archived GameRecord for a 0G Storage Merkle root, decoded
    into per-move board states for the frontend replay UI.

    `root_hash` is the same value that landed in
    `MatchRegistry.MatchInfo.gameRecordHash` when the match was finalized
    (Phase 7); the frontend reads it via `getMatch(matchId)` and passes it
    here. Position IDs in the record (gnubg-native, base64) are decoded
    into 24-point board arrays + bar + off counts so the frontend can
    render each step without running gnubg.
    """
    if not root_hash.startswith("0x") or len(root_hash) != 66:
        raise HTTPException(status_code=400, detail="root_hash must be 0x + 64 hex chars")
    try:
        blob = get_blob(root_hash)
    except OgStorageError as e:
        raise HTTPException(status_code=502, detail=f"0G Storage fetch failed: {e}") from e
    try:
        record = json.loads(blob)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"could not decode record: {e}") from e

    states = []
    for move in record.get("moves", []) or []:
        pos = move.get("position_id_after", "")
        try:
            board, bar, off = decode_position_id(pos)
        except Exception:
            # A corrupted move entry shouldn't fail the whole replay; render
            # an empty board so the user can still step through.
            board, bar, off = [0] * 24, [0, 0], [0, 0]
        states.append(
            {
                "turn": move.get("turn", 0),
                "dice": move.get("dice", []),
                "move": move.get("move", ""),
                "board": board,
                "bar": bar,
                "off": off,
            }
        )

    return {"record": record, "states": states}


# ---------------------------------------------------------------------------
# Phase 7 — finalize a finished game on 0G Storage + 0G Chain
# ---------------------------------------------------------------------------


class MintSubnameRequest(BaseModel):
    """Phase 15: claim a subname for a connected wallet.

    `label` is the leftmost component (the `alice` in
    `alice.chaingammon.eth`). `owner_address` is the wallet that will
    own the subname (the wagmi-connected address from the frontend).
    The server, as the registrar's `Ownable` owner, signs the
    `mintSubname` transaction on the user's behalf — the user doesn't
    need any 0G gas for this in v1.
    """

    label: str
    owner_address: str


class MintSubnameResponse(BaseModel):
    label: str
    node: str  # ENS namehash of `<label>.chaingammon.eth`
    tx_hash: str


@app.post("/subname/mint", response_model=MintSubnameResponse)
def mint_subname(req: MintSubnameRequest):
    # Phase 21: validate label against ENS rules before hitting the chain.
    label = req.label.strip().lower()
    if not label:
        raise HTTPException(status_code=400, detail="label cannot be empty")
    if len(label) > 63:
        raise HTTPException(status_code=400, detail="label must be 63 characters or fewer")
    if not _LABEL_RE.match(label):
        raise HTTPException(
            status_code=400,
            detail="label must contain only lowercase letters, numbers, and hyphens, "
            "and cannot start or end with a hyphen",
        )
    try:
        ens = EnsClient.from_env()
    except EnsError as e:
        raise HTTPException(status_code=500, detail=f"ens client misconfigured: {e}") from e
    # Pre-check: ownerOf returns the zero address for unclaimed subnames.
    try:
        node = ens.subname_node(label)
        owner = ens.owner_of(node)
    except EnsError as e:
        raise HTTPException(status_code=502, detail=f"availability check failed: {e}") from e
    _ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
    if owner and owner.lower() != _ZERO_ADDRESS:
        raise HTTPException(status_code=409, detail="label already taken")
    try:
        tx_hash = ens.mint_subname(label, req.owner_address)
    except EnsError as e:
        raise HTTPException(status_code=502, detail=f"mintSubname failed: {e}") from e
    return MintSubnameResponse(label=label, node=node, tx_hash=tx_hash)


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


# ---------------------------------------------------------------------------
# Phase 36 — KeeperHub workflow status mock
#
# TODO(phase-37): Replace this endpoint's body with a real `kh run status --json`
# call once the KeeperHub workflow is wired. The response shape below is the
# canonical contract the frontend develops against — field names, step IDs, and
# status values must remain stable when the real implementation lands.
#
# The eight steps correspond 1-to-1 with the workflow stages described in
# docs/keeperhub-feedback.md and the Phase 36 issue specification.
# ---------------------------------------------------------------------------


def _keeper_step_statuses(seed: int) -> list[str]:
    """Return a deterministic list of 8 step statuses based on a numeric seed.

    The first `n` steps are "ok" and the remainder are "pending", where n is
    seed % 9 (range 0–8). This gives different matchIds visually distinct
    progress states without requiring any real workflow state.
    """
    n_ok = seed % 9
    return ["ok"] * n_ok + ["pending"] * (8 - n_ok)


@app.get("/keeper-workflow/{match_id}")
def keeper_workflow_status(match_id: str):
    """Return a deterministic mock of the KeeperHub workflow run for matchId.

    Shape mirrors what `kh run status --json` will return in Phase 37. Each
    of the eight steps is populated with realistic placeholder data so the
    frontend can develop the full UI without a live KeeperHub connection.

    The step statuses are seeded by sha256(matchId) so the same matchId always
    returns the same response — useful for Playwright snapshot tests and demos.
    """
    seed = int(hashlib.sha256(match_id.encode()).hexdigest(), 16)
    statuses = _keeper_step_statuses(seed)

    # Placeholder tx hashes derived from the matchId seed for display purposes.
    def _tx(index: int) -> Optional[str]:
        if statuses[index] != "ok":
            return None
        h = hashlib.sha256(f"{match_id}-step-{index}".encode()).hexdigest()
        return "0x" + h

    steps = [
        {
            "id": "escrow_deposit",
            "name": "Escrow deposit confirmation",
            "status": statuses[0],
            "duration_ms": 1842 if statuses[0] == "ok" else None,
            "retry_count": 0,
            "tx_hash": _tx(0),
            "error": None,
            "detail": "Both players' deposits confirmed on 0G testnet." if statuses[0] == "ok" else None,
        },
        {
            "id": "vrf_rolls",
            "name": "VRF rolls (drand)",
            "status": statuses[1],
            "duration_ms": 312 if statuses[1] == "ok" else None,
            "retry_count": 0,
            "tx_hash": None,
            "error": None,
            "detail": "Drand rounds fetched and signed for each turn." if statuses[1] == "ok" else None,
        },
        {
            "id": "og_storage_fetch",
            "name": "Game-record fetch from 0G Storage",
            "status": statuses[2],
            "duration_ms": 780 if statuses[2] == "ok" else None,
            "retry_count": 0,
            "tx_hash": None,
            "error": None,
            "detail": "archive_uri resolved; game record downloaded." if statuses[2] == "ok" else None,
        },
        {
            "id": "gnubg_replay",
            "name": "gnubg replay validation",
            "status": statuses[3],
            "duration_ms": 2341 if statuses[3] == "ok" else None,
            "retry_count": 0,
            "tx_hash": None,
            "error": None,
            "detail": "All moves legal given their drand-signed dice." if statuses[3] == "ok" else None,
        },
        {
            "id": "settlement_signed",
            "name": "Settlement payload signed",
            "status": statuses[4],
            "duration_ms": 54 if statuses[4] == "ok" else None,
            "retry_count": 0,
            "tx_hash": None,
            "error": None,
            "detail": "Keeper signed result payload for on-chain relay." if statuses[4] == "ok" else None,
        },
        {
            "id": "relay_tx",
            "name": "Relay tx submitted to 0G testnet",
            "status": statuses[5],
            "duration_ms": 3200 if statuses[5] == "ok" else None,
            "retry_count": 0,
            "tx_hash": _tx(5),
            "error": None,
            "detail": "settleWithSessionKeys confirmed on-chain." if statuses[5] == "ok" else None,
        },
        {
            "id": "ens_update",
            "name": "ENS text records updated",
            "status": statuses[6],
            "duration_ms": 2100 if statuses[6] == "ok" else None,
            "retry_count": 0,
            "tx_hash": _tx(6),
            "error": None,
            "detail": "elo, last_match_id, archive_uri written for both players." if statuses[6] == "ok" else None,
        },
        {
            "id": "audit_append",
            "name": "Audit JSON appended to 0G Storage",
            "status": statuses[7],
            "duration_ms": 950 if statuses[7] == "ok" else None,
            "retry_count": 0,
            "tx_hash": _tx(7),
            "error": None,
            "detail": "Full audit trail written to the match's 0G Storage log." if statuses[7] == "ok" else None,
        },
    ]

    # Overall run status: "ok" if all steps done, "failed" if any failed,
    # "running" if any are running, otherwise "pending".
    all_statuses = {s["status"] for s in steps}
    if "failed" in all_statuses:
        run_status = "failed"
    elif "running" in all_statuses:
        run_status = "running"
    elif all(s == "ok" for s in statuses):
        run_status = "ok"
    else:
        run_status = "pending"

    return {"matchId": match_id, "status": run_status, "steps": steps}


# ─── Career-mode teammate recommendation ────────────────────────────────────
#
# Reads off the trained value-net's own teammate-style preference: for each
# candidate, project that candidate's style profile into the extras vector's
# teammate slots [6:12] and average equity over a fixed reference battery.
# Wires together the resolver (agent_profile.load_profile) and the scorer
# (teammate_selection.recommend_teammate). See the relevant modules for the
# math; this endpoint is just the HTTP shim.


class RecommendTeammateRequest(BaseModel):
    candidates: List[int]


@app.post("/agents/{agent_id}/recommend-teammate")
def recommend_teammate_endpoint(agent_id: int, req: RecommendTeammateRequest):
    """Pick the teammate from `req.candidates` whose style profile best
    aligns with this agent's trained value net.

    Returns a JSON body with:
      best_teammate_id   the candidate the agent prefers
      equities           per-candidate mean equity over the reference battery
      spread             max - min equity (small = low-confidence pick)
      requester_kind     "model"   — requester has a trained checkpoint on 0G
                         "overlay" — requester has only a Phase-9 overlay
                                     (falls back to a deterministic fresh net;
                                     equities reflect architecture, not training)
      candidate_kinds    per-candidate kind, same enum as requester_kind plus "null"

    422 when the requester has no weights yet (NullProfile) or `candidates`
    is empty. Pre-existing testnet env (OG_STORAGE_*, AGENT_REGISTRY_ADDRESS)
    is required so the resolver can read on-chain `dataHashes[1]` and fetch
    blobs from 0G storage.
    """
    if not req.candidates:
        raise HTTPException(status_code=422, detail="candidates must be non-empty")

    # Resolver imports — agent/ on sys.path via the top-of-file insert.
    from agent_profile import (
        ModelProfile,
        NullProfile,
        OverlayProfile,
        load_profile,
    )

    try:
        chain = ChainClient.from_env()
        if chain.agent_registry is None:
            raise ChainError("AGENT_REGISTRY_ADDRESS not set")
    except ChainError as e:
        raise HTTPException(status_code=503, detail=f"chain unavailable: {e}")

    def _resolve(aid: int):
        """Resolve agent_id → AgentProfile via the same dataHashes[1]
        path /games/{id}/agent-move uses for overlays. Pass `fetch=get_blob`
        so load_profile doesn't fall back to its own server.app import path."""
        hashes = chain.agent_data_hashes(aid)
        weights_hash = hashes[1]
        if weights_hash == "0x" + "00" * 32:
            return NullProfile()
        return load_profile(weights_hash, fetch=get_blob)

    # 1. Resolve requester's net.
    requester_profile = _resolve(agent_id)
    if isinstance(requester_profile, NullProfile):
        raise HTTPException(
            status_code=422,
            detail=f"agent {agent_id} has no weights yet — train first",
        )

    if isinstance(requester_profile, ModelProfile):
        net = requester_profile.net
        requester_kind = "model"
    else:  # OverlayProfile — fall back to a deterministic fresh net so the
           # endpoint is still usable for untrained agents. The frontend
           # surfaces requester_kind so the UI can disclose.
        from sample_trainer import BackgammonNet
        net = BackgammonNet(extras_dim=16, core_seed=0xBACC, extras_seed=agent_id)
        net.eval()
        requester_kind = "overlay"

    # 2. Resolve each candidate's style dict.
    candidate_styles: list[tuple[int, dict]] = []
    candidate_kinds: dict[str, str] = {}
    for cid in req.candidates:
        c_profile = _resolve(cid)
        if isinstance(c_profile, OverlayProfile):
            style = dict(c_profile.metrics().get("values", {}))
            candidate_kinds[str(cid)] = "overlay"
        elif isinstance(c_profile, ModelProfile):
            # Trained checkpoints don't carry a style summary in their
            # metadata yet — pass an empty style. Embedding a style
            # summary in save_checkpoint is a follow-up.
            style = {}
            candidate_kinds[str(cid)] = "model"
        else:
            style = {}
            candidate_kinds[str(cid)] = "null"
        candidate_styles.append((cid, style))

    # 3. Score.
    from teammate_selection import recommend_teammate
    rec = recommend_teammate(net, candidate_styles)

    return {
        "best_teammate_id": rec.best_teammate_id,
        "equities": {str(k): v for k, v in rec.equities.items()},
        "spread": rec.spread,
        "requester_kind": requester_kind,
        "candidate_kinds": candidate_kinds,
    }


# ─── Phase E: training endpoints + agents listing ──────────────────────────
#
# Implements the /training/* surface the training page calls:
#   POST /training/start    — spawn round_robin_trainer.py subprocess
#   GET  /training/status   — aggregate JSONL events
#   POST /training/abort    — SIGTERM the trainer
#   GET  /training/estimate — gas estimate for a hypothetical run
#   GET  /agents            — list all minted agents (id + weights_hash + match_count)
#   GET  /agents/{id}/profile — load_profile summary
#
# Auth/CSRF: hackathon scope; CORS already `*`. Production should
# restrict allow_origins and add a session-key check on /training/start
# and /training/abort.

from .training_service import (
    abort_job,
    estimate_run,
    get_status as get_training_status_dict,
    start_job,
)


class StartTrainingRequest(BaseModel):
    epochs: int
    agent_ids: List[int]
    use_0g_inference: bool = False
    use_0g_coaching: bool = False
    extras_dim: int = 16
    seed: int = 42


@app.post("/training/start")
def post_training_start(req: StartTrainingRequest):
    """Spawn a round-robin training subprocess. 409 if one is already
    running. Returns `{job_id, started_at, epochs, agent_ids}`."""
    try:
        job = start_job(
            epochs=req.epochs,
            agent_ids=req.agent_ids,
            use_0g_inference=req.use_0g_inference,
            use_0g_coaching=req.use_0g_coaching,
            extras_dim=req.extras_dim,
            seed=req.seed,
        )
    except RuntimeError as e:
        # Already running.
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {
        "job_id": str(job.pid),
        "started_at": job.started_at.isoformat(),
        "epochs": job.epochs,
        "agent_ids": job.agent_ids,
        "use_0g_inference": job.use_0g_inference,
        "use_0g_coaching": job.use_0g_coaching,
        "status_file": str(job.status_file_path),
    }


@app.get("/training/status")
def get_training_status_endpoint():
    """Aggregate the current (or most recent) trainer's JSONL events.
    Always returns the same shape so the frontend doesn't have to
    branch on whether a job is active."""
    return get_training_status_dict()


@app.post("/training/abort")
def post_training_abort():
    """SIGTERM the running trainer. Returns `{aborted: bool}` — false
    when no job was running."""
    aborted = abort_job()
    return {"aborted": aborted}


@app.get("/training/estimate")
def get_training_estimate(
    epochs: int,
    agent_ids: str,
    use_0g_inference: bool = False,
):
    """Compute games + total inferences + (optional) gas estimate for a
    hypothetical training run. Polled by the training page on every
    slider change with debounce.

    `agent_ids` is a comma-separated query string (FastAPI doesn't
    natively bind list[int] from query params without dependencies,
    and a string keeps the URL readable)."""
    try:
        ids = [int(s.strip()) for s in agent_ids.split(",") if s.strip()]
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail=f"agent_ids must be comma-separated ints, got {agent_ids!r}",
        )
    if not ids:
        raise HTTPException(
            status_code=422,
            detail="agent_ids must contain at least one ID",
        )
    if epochs < 1:
        raise HTTPException(status_code=422, detail="epochs must be >= 1")

    # Phase G will plumb a real eval_estimator here. For Phase E we
    # leave it None so the helper returns the placeholder pricing and
    # surfaces `available: false` to the frontend.
    return estimate_run(
        epochs=epochs,
        agent_ids=ids,
        use_0g_inference=use_0g_inference,
        eval_estimator=None,
    )


@app.get("/agents")
def list_agents():
    """List all minted agents. Returns `[{agent_id, weights_hash,
    match_count, tier}]`. Label resolution (ENS) happens client-side.
    503 when the chain isn't reachable so the training page can render
    a 'chain unavailable' state instead of an empty list."""
    try:
        chain = ChainClient.from_env()
        if chain.agent_registry is None:
            raise ChainError("AGENT_REGISTRY_ADDRESS not set")
        count = chain.agent_count()
    except ChainError as e:
        raise HTTPException(status_code=503, detail=f"chain unavailable: {e}")

    agents = []
    for aid in range(1, count + 1):
        try:
            hashes = chain.agent_data_hashes(aid)
            agents.append({
                "agent_id": aid,
                "weights_hash": hashes[1] if len(hashes) >= 2 else "",
                "match_count": chain.agent_match_count(aid),
                "tier": chain.agent_tier(aid),
            })
        except ChainError:
            # Skip agents the chain client can't read — but report the
            # ID so the frontend knows there's a gap.
            agents.append({
                "agent_id": aid,
                "weights_hash": "",
                "match_count": 0,
                "tier": 0,
                "error": "chain read failed",
            })
    return agents


@app.get("/agents/{agent_id}/profile")
def get_agent_profile(agent_id: int):
    """Resolve `agent_id`'s on-chain `dataHashes[1]` → 0G storage blob
    → `load_profile` content-sniff → `{match_count, summary, kind}`.

    Mirrors the resolver path /games/{id}/agent-move (overlay) and
    /agents/{id}/recommend-teammate (model) already use. Returns the
    NullProfile shape for cold-start agents (frontend renders a
    'no measurable style yet' chip)."""
    from agent_profile import (
        ModelProfile,
        NullProfile,
        OverlayProfile,
        load_profile,
    )

    try:
        chain = ChainClient.from_env()
        if chain.agent_registry is None:
            raise ChainError("AGENT_REGISTRY_ADDRESS not set")
        hashes = chain.agent_data_hashes(agent_id)
    except ChainError as e:
        raise HTTPException(status_code=503, detail=f"chain unavailable: {e}")

    weights_hash = hashes[1] if len(hashes) >= 2 else ""
    profile = (
        load_profile(weights_hash, fetch=get_blob)
        if weights_hash and weights_hash != "0x" + "00" * 32
        else NullProfile()
    )
    metrics = profile.metrics()
    if isinstance(profile, ModelProfile):
        kind = "model"
    elif isinstance(profile, OverlayProfile):
        kind = "overlay"
    else:
        kind = "null"
    return {
        "agent_id": agent_id,
        "kind": kind,
        "match_count": int(metrics.get("match_count", 0)),
        "summary": profile.summarize(),
    }
