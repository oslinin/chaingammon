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

# Load server/.env into os.environ before any module reads RPC_URL etc.
# Without this, `uv run uvicorn app.main:app` ignores the .env file and
# every chain-touching endpoint 503s with "Missing env var RPC_URL".
# `override=False` lets shell-set vars win over the .env file (matches
# how dotenvx + most CLI tools behave).
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)

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
    AdvisorSignal,
    GameRecord,
    MoveEntry,
    PlayerRef,
    Team,
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

# Phase K.1: optional team rosters per game_id. Populated by
# create_game when the request body carries team_a/team_b. Read by
# /agent-move to compute captain + advisor signals, and by
# finalize_game to write rosters into the on-chain GameRecord.
_game_teams: Dict[str, "tuple[Team, Team]"] = {}

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
    # Phase K.1: optional team rosters for live team-mode play. When
    # set, the per-turn /agent-move endpoint emits AdvisorSignal[]
    # from each non-captain teammate and rotates captain per the
    # team's `captain_rotation` policy. Solo flows leave both None
    # and hit zero new code paths.
    team_a: Optional[Team] = None
    team_b: Optional[Team] = None

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
    # Phase K.1: stash team rosters when the game is opened in
    # team mode. Solo flows leave both None and skip this branch.
    if req.team_a is not None and req.team_b is not None:
        _game_teams[game_id] = (req.team_a, req.team_b)
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

class AgentMoveRequest(BaseModel):
    """Phase I.2 — optional body for /games/{id}/agent-move.

    `use_0g_inference` flips the move-evaluation path through the 0G
    compute eval bridge. The trained BackgammonNet today only operates
    on pip-race states (sample_trainer.py:189 RaceState), so the chosen
    move is STILL gnubg+overlay even when this flag is on — what
    changes is that we record one billable inference call to capture
    real provider + cost metadata for the match-page caption. Phase J
    swaps in a full-board NN; once that ships and `use_per_agent_nn`
    is True, the NN's argmax actually drives the move.
    """

    use_0g_inference: bool = False
    use_per_agent_nn: bool = False  # reserved for Phase J


class AgentMoveResponse(GameState):
    """Phase I.2 + K.4: extends GameState with optional `inference_meta`
    (0G cost caption) and `advisor_signals` (team-mode per-turn voices).

    Subclassing GameState (not wrapping it) preserves byte-stable
    back-compat: every existing /agent-move caller can still read
    `resp.json()["position_id"]`, `["dice"]`, etc. With `exclude_none=True`
    serialization, solo / non-0G calls don't surface the new fields.
    """

    inference_meta: Optional[Dict[str, object]] = None
    advisor_signals: Optional[List[AdvisorSignal]] = None
    captain_id: Optional[str] = None


@app.post("/games/{game_id}/agent-move", response_model=AgentMoveResponse)
def agent_move(game_id: str, req: AgentMoveRequest = AgentMoveRequest()):
    """Phase 9: pick the agent's move using gnubg's full candidate list
    re-ranked by the agent's experience overlay. Two iNFTs minted on the
    same gnubg base but with divergent overlays will pick different
    moves on identical positions — that's what makes the iNFT meaningful.

    Auto-played positions (no legal moves, e.g. dance from the bar) fall
    back to gnubg's `get_agent_move` which lets gnubg play through.

    Phase I.2: when `req.use_0g_inference` is set, also probe the 0G
    eval bridge so the per-move billable path is exercised. Returns
    inference metadata in `inference_meta` (provider, per-call cost,
    available flag, latency) for the frontend caption. Does NOT change
    the chosen move yet — see AgentMoveRequest docstring.
    """
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    game = games[game_id]
    turn_before = game.turn
    dice_before = list(game.dice) if game.dice else []

    candidates = gnubg.get_candidate_moves(game.position_id, game.match_id)

    # Phase J.5: when use_per_agent_nn is set AND the agent has a
    # gnubg_full checkpoint registered, route the move-selection
    # through the per-agent neural net. Each candidate's successor is
    # decoded → encoded with gnubg_encoder → scored against
    # net(features, extras); argmax wins. Latency: ~N gnubg
    # subprocess calls per move (one submit_move + decode per
    # candidate), so this branch is opt-in. When the agent doesn't
    # have a gnubg_full checkpoint, the function falls back to the
    # gnubg+overlay path with a note explaining why.
    nn_pick: Optional[Dict[str, object]] = None
    if req.use_per_agent_nn and candidates:
        nn_pick = _try_per_agent_nn_pick(
            game_id=game_id,
            game=game,
            candidates=candidates,
        )

    if not candidates:
        # No legal candidates — auto-play (bar dance, etc.). Overlay can't
        # help here since there's nothing to choose between.
        res = gnubg.get_agent_move(game.position_id, game.match_id)
        if not res["position_id"] or not res["match_id"]:
            raise HTTPException(status_code=500, detail="gnubg agent move failed")
        chosen_move = res.get("best_move") or "(auto-played)"
    elif nn_pick is not None and nn_pick.get("chosen_res") is not None:
        # Per-agent NN drove the choice; the helper already submitted
        # the move and stashed the gnubg result so we don't pay another
        # subprocess hop here.
        chosen_move = nn_pick["chosen_move"]
        res = nn_pick["chosen_res"]
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

    # Phase K.4: in team mode, every non-captain teammate publishes one
    # AdvisorSignal per turn. Captain still picks alone (its own pick
    # via gnubg+overlay is final for the K MVP); the signals are
    # archived to MoveEntry.advisor_signals so an audit replayer can
    # reconstruct what advice was on the table. Vote fusion is a
    # follow-up phase.
    advisor_signals, captain_id = _maybe_collect_advisor_signals(
        game_id, turn_before, candidates
    )

    _move_history.setdefault(game_id, []).append(
        MoveEntry(
            turn=turn_before,
            dice=dice_before,
            move=chosen_move,
            position_id_after=state.position_id,
            advisor_signals=advisor_signals,
        )
    )

    inference_meta = _maybe_probe_0g_inference(req.use_0g_inference)

    return AgentMoveResponse(
        **state.model_dump(),
        inference_meta=inference_meta,
        advisor_signals=advisor_signals,
        captain_id=captain_id,
    )


@app.get("/games/{game_id}/last-advisor-signals")
def get_last_advisor_signals(game_id: str):
    """Phase K.5: returns the most recent move's advisor signals + the
    captain who decided that turn. The frontend's AdvisorSignalsPanel
    polls this so it can render the latest signals without driving
    /agent-move directly. Returns empty arrays when no move has been
    recorded yet — the live match page uses gnubg_service for moves,
    not /agent-move, so this stays empty unless the operator drives
    moves through the main backend (e.g. team-mode integration tests
    or a future end-to-end UI cutover)."""
    history = _move_history.get(game_id, [])
    if not history:
        return {"signals": [], "captain_id": None, "move_idx": -1, "team_mode": game_id in _game_teams}
    last = history[-1]
    if not last.advisor_signals:
        return {"signals": [], "captain_id": None, "move_idx": len(history) - 1,
                "team_mode": game_id in _game_teams}
    # Resolve captain for this move.
    if game_id not in _game_teams:
        captain_id = None
    else:
        team_a, team_b = _game_teams[game_id]
        team = team_a if last.turn == 0 else team_b
        moves_for_team = sum(1 for m in history if m.turn == last.turn)
        from .team_mode import captain_member
        cap_ref = captain_member(team, max(0, moves_for_team - 1))
        captain_id = (
            f"agent:{cap_ref.agent_id}" if cap_ref.kind == "agent"
            else (cap_ref.address or "").lower()
        )
    return {
        "signals": [s.model_dump() for s in last.advisor_signals],
        "captain_id": captain_id,
        "move_idx": len(history) - 1,
        "team_mode": True,
    }


def _maybe_collect_advisor_signals(
    game_id: str,
    turn_before: int,
    candidates: List[Dict],
) -> "tuple[Optional[List[AdvisorSignal]], Optional[str]]":
    """K.4 helper: when this game is in team mode, enumerate the
    non-captain teammates on the side that just moved and produce one
    AdvisorSignal each. Returns (signals, captain_id) or (None, None)
    for solo games."""
    if game_id not in _game_teams:
        return None, None
    if not candidates:
        # Auto-played turn (bar dance) — no candidates means nothing for
        # advisors to score; caller's record carries None for this turn.
        return None, None

    team_a, team_b = _game_teams[game_id]
    # Side 0 = "human" / left team; side 1 = "agent" / right team. The
    # team whose member just moved is the side equal to `turn_before`.
    team = team_a if turn_before == 0 else team_b

    # Move count for THIS team only — captain rotation must respect
    # per-team turn count, not the global game count.
    moves_for_this_team = sum(
        1 for m in _move_history.get(game_id, []) if m.turn == turn_before
    )

    from .team_mode import captain_index, captain_member, non_captain_members
    from .teammate_advisor import AdvisorScoring, score_advisor_move

    cap_idx = captain_index(team, moves_for_this_team)
    cap_ref = team.members[cap_idx]
    captain_id = (
        f"agent:{cap_ref.agent_id}" if cap_ref.kind == "agent"
        else (cap_ref.address or "").lower()
    )

    advisors: List[AdvisorSignal] = []
    for advisor_ref in non_captain_members(team, moves_for_this_team):
        scoring = _resolve_advisor_scoring(advisor_ref, candidates, team)
        if scoring is None:
            continue
        sig = score_advisor_move(scoring)
        if sig is not None:
            advisors.append(sig)
    return advisors or None, captain_id


def _resolve_advisor_scoring(
    advisor_ref: PlayerRef,
    candidates: List[Dict],
    team: Team,
) -> "Optional[AdvisorScoring]":
    """Build the AdvisorScoring inputs for `advisor_ref`. For agent
    advisors we resolve their on-chain dataHashes[1] → load_profile →
    OverlayProfile (or ModelProfile when Phase J ships). For human
    advisors we have no profile to score with, so skip them — the K
    MVP only scores agent teammates."""
    from .teammate_advisor import AdvisorScoring

    if advisor_ref.kind != "agent" or advisor_ref.agent_id is None:
        return None  # human advisors out of scope for K MVP

    aid = advisor_ref.agent_id
    try:
        chain = ChainClient.from_env()
        if chain.agent_registry is None:
            return None
        hashes = chain.agent_data_hashes(aid)
    except ChainError:
        return None

    weights_hash = hashes[1] if len(hashes) >= 2 else ""
    if not weights_hash or weights_hash == "0x" + "00" * 32:
        return AdvisorScoring(
            teammate=advisor_ref,
            candidates=candidates,
            profile_kind="null",
        )

    from agent_profile import (   # noqa: E402 — agent/ on sys.path at module top
        ModelProfile,
        NullProfile,
        OverlayProfile,
        load_profile,
    )
    try:
        profile = load_profile(weights_hash, fetch=get_blob)
    except Exception:
        return AdvisorScoring(
            teammate=advisor_ref,
            candidates=candidates,
            profile_kind="null",
        )

    if isinstance(profile, OverlayProfile):
        # Reconstruct an Overlay from the profile's metric values for
        # apply_overlay's signature. Start with an all-zero default
        # (carries the canonical CATEGORIES list), then merge the
        # profile's known values. Unknown categories from a future
        # profile version are dropped silently.
        from .agent_overlay import CATEGORIES as _CATS, CURRENT_OVERLAY_VERSION
        raw_values = dict(profile.metrics().get("values", {}))
        values = {c: float(raw_values.get(c, 0.0)) for c in _CATS}
        overlay = Overlay(
            version=CURRENT_OVERLAY_VERSION,
            values=values,
            match_count=int(profile.metrics().get("match_count", 0)),
        )
        return AdvisorScoring(
            teammate=advisor_ref,
            candidates=candidates,
            overlay=overlay,
            profile_kind="overlay",
        )
    if isinstance(profile, ModelProfile):
        encoder = str(profile.metrics().get("feature_encoder", "race"))
        return AdvisorScoring(
            teammate=advisor_ref,
            candidates=candidates,
            profile_kind="model",
            model_encoder=encoder,
        )
    return AdvisorScoring(
        teammate=advisor_ref,
        candidates=candidates,
        profile_kind="null",
    )


def _try_per_agent_nn_pick(
    *, game_id: str, game: GameState, candidates: List[Dict],
) -> Optional[Dict[str, object]]:
    """Phase J.5: if the agent attached to this game has a
    `gnubg_full` ModelProfile, score every candidate's successor
    position through `net(features, extras)` and pick argmax. Returns
    a dict with the chosen move + gnubg's submit response when the NN
    drove the pick, or None to signal the caller should fall back to
    the gnubg+overlay path.

    Failure modes that fall through silently to overlay:
      - no agent_id stashed for this game
      - chain client unavailable (no AGENT_REGISTRY_ADDRESS)
      - profile is null / overlay / race-only
      - encoder import fails (agent/ not on path)
      - any candidate score path raises

    Each candidate adds one gnubg.submit_move call; for a typical
    backgammon position with 5-10 candidates that's ~500-1000ms of
    subprocess time per /agent-move call.
    """
    agent_id = _game_agent_id.get(game_id)
    if not agent_id:
        return None
    try:
        chain = ChainClient.from_env()
        if chain.agent_registry is None:
            return None
        hashes = chain.agent_data_hashes(agent_id)
    except ChainError:
        return None
    weights_hash = hashes[1] if len(hashes) >= 2 else ""
    if not weights_hash or weights_hash == "0x" + "00" * 32:
        return None

    try:
        from agent_profile import ModelProfile, load_profile  # noqa: E402
    except ImportError:
        return None

    try:
        profile = load_profile(weights_hash, fetch=get_blob)
    except Exception:
        return None

    if not isinstance(profile, ModelProfile) or profile.net is None:
        return None
    encoder_tag = str(profile.metrics().get("feature_encoder", "race"))
    if encoder_tag != "gnubg_full":
        # Race-only weights can't score full-board positions.
        return None

    # Score each candidate. We need each candidate's successor
    # position, which means submit_move + decode_board per candidate.
    # The chosen one's gnubg result is reused to advance the game,
    # avoiding a second submit pass.
    try:
        import torch
        from gnubg_encoder import encode_full_board  # noqa: E402
        from gnubg_state import decode_position_id  # noqa: E402
    except ImportError:
        return None

    extras = torch.zeros(profile.net.extras.in_features) \
        if profile.net.extras is not None else None

    best_idx = -1
    best_eq = -float("inf")
    best_move = ""
    best_res = None
    perspective = 1 - game.turn   # the agent just played for `game.turn`;
                                  # successors are scored from the side that
                                  # would move next, but for picking the
                                  # current player's best move we score from
                                  # game.turn's perspective. After
                                  # submit_move, gnubg flips the turn
                                  # automatically.
    for idx, cand in enumerate(candidates):
        move_str = cand.get("move", "")
        if not move_str:
            continue
        try:
            res = gnubg.submit_move(game.position_id, game.match_id, move_str)
        except Exception:
            continue
        succ_pos = res.get("position_id")
        if not succ_pos:
            continue
        try:
            board, bar, off = decode_position_id(succ_pos)
            feat = encode_full_board(board, bar, off,
                                     perspective=game.turn).unsqueeze(0)
            with torch.no_grad():
                if extras is not None:
                    eq = profile.net(feat, extras.unsqueeze(0)).item()
                else:
                    eq = profile.net(feat).item()
        except Exception:
            continue
        if eq > best_eq:
            best_eq = eq
            best_idx = idx
            best_move = move_str
            best_res = res

    if best_idx < 0 or best_res is None:
        return None
    return {
        "chosen_move": best_move,
        "chosen_idx": best_idx,
        "chosen_eq": best_eq,
        "chosen_res": best_res,
    }


def _maybe_probe_0g_inference(use_0g_inference: bool) -> Optional[Dict[str, object]]:
    """Phase I.2: when 0G inference is on, call the eval bridge once
    so the bounty meter ticks per move. Returns metadata the frontend
    renders as 'Last move: 0G compute · {latency_ms} ms · {gas_og} OG'.
    `available: false` is honest — the bridge couldn't find a
    backgammon-net provider; we still surface what we know so the
    caption disambiguates 'wire-decorated-but-unprovisioned' from
    'real 0G traffic'."""
    if not use_0g_inference:
        return None
    import time as _time
    try:
        from og_compute_eval_client import estimate as _og_estimate
    except ImportError:
        return {"available": False, "note": "og-compute-bridge not importable"}
    t0 = _time.time()
    try:
        r = _og_estimate(1)
    except Exception as exc:
        return {
            "available": False,
            "note": f"OG_EVAL_UNAVAILABLE: {exc}",
            "latency_ms": int((_time.time() - t0) * 1000),
        }
    return {
        "available": bool(r.available),
        "provider": r.provider_address or None,
        "per_inference_og": r.per_inference_og,
        "gas_og": r.per_inference_og,
        "latency_ms": int((_time.time() - t0) * 1000),
        "note": r.note or "",
    }

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
    # Phase K.6: thread team rosters through to the GameRecord when
    # the game was opened in team mode. Solo games leave both None.
    team_a, team_b = _game_teams.get(game_id, (None, None))
    record = build_from_state(
        state,
        winner=winner,
        loser=loser,
        moves=_move_history.get(game_id, []),
        started_at=_game_started_at.get(game_id),
        ended_at=datetime.now(timezone.utc).isoformat(),
        team_a=team_a,
        team_b=team_b,
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
# KeeperHub integration: /finalize-direct, /settle (relayer), /replay
#
# The match page drives gameplay through gnubg_service (port 8001) without
# creating a game at this server. These three endpoints close the settlement
# loop for that path:
#
#   POST /finalize-direct — called by the frontend after game-end to upload
#       the GameRecord to 0G Storage and commit on-chain. Returns the
#       on-chain matchId so the frontend can link to /keeper/{matchId}.
#
#   POST /settle — KeeperHub relayer endpoint. Receives a keeper-signed
#       payload (step 7 of keeperhub/match-settle.yaml) and calls
#       recordMatch on 0G Chain. Returns {tx_hash}.
#
#   POST /replay — GNUBG replay validation endpoint. Receives {archive_uri,
#       match_id} from KeeperHub's fetch-and-replay step, fetches the
#       GameRecord from 0G Storage, and validates every move through gnubg.
#       Returns {valid: bool, winner: str}.
# ---------------------------------------------------------------------------


class DirectFinalizeRequest(BaseModel):
    """Finalize a match from the gnubg service state without a server game_id.

    The match page drives gameplay through gnubg_service directly (port 8001)
    and never registers a game at this server. At game-end the frontend calls
    this endpoint so the audit pipeline runs automatically: 0G Storage upload
    → recordMatch on-chain → overlay updates → ENS push.
    """

    winner_agent_id: int = 0
    winner_human_address: str = "0x0000000000000000000000000000000000000000"
    loser_agent_id: int = 0
    loser_human_address: str = "0x0000000000000000000000000000000000000000"
    winner_label: str = ""
    loser_label: str = ""
    match_length: int = 3
    # Final gnubg state from the match page
    position_id: str = ""
    gnubg_match_id: str = ""
    score: list[int] = [0, 0]
    # Optional move history (empty for MVP; full history improves audit quality)
    moves: list[dict] = []


@app.post("/finalize-direct", response_model=FinalizeResponse)
def finalize_direct(req: DirectFinalizeRequest):
    """Finalize a match from the match page without a pre-registered game_id.

    Builds a synthetic GameState from the provided final position, runs the
    same finalization pipeline as /games/{id}/finalize, and returns the
    on-chain matchId. The frontend uses that matchId to trigger and link to
    the KeeperHub audit workflow via /keeper-workflow/{matchId}/run and
    /keeper/{matchId}.
    """
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

    # Synthetic GameState — only the four fields build_from_state reads.
    synthetic_state = GameState(
        game_id="direct",
        match_id=req.gnubg_match_id or "AAAAAAAAAAAAAAAAAAAAAAAA",
        position_id=req.position_id or "AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        board=[0] * 24,
        bar=[0, 0],
        off=[0, 0],
        turn=0,
        dice=None,
        match_length=req.match_length,
        score=req.score if len(req.score) == 2 else [0, 0],
        game_over=True,
        winner=0,
    )

    move_entries: list[MoveEntry] = []
    for m in req.moves:
        try:
            move_entries.append(MoveEntry(**m))
        except Exception:
            pass

    record = build_from_state(
        synthetic_state,
        winner=winner,
        loser=loser,
        moves=move_entries,
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
            match_length=int(req.match_length),
            game_record_hash=upload.root_hash,
        )
    except ChainError as e:
        raise HTTPException(status_code=502, detail=f"recordMatch failed: {e}") from e

    overlay_updates: list[dict] = []
    if chain.agent_registry is not None:
        for agent_id, won in [
            (req.winner_agent_id, True),
            (req.loser_agent_id, False),
        ]:
            if agent_id == 0:
                continue
            try:
                overlay_updates.append(
                    _update_agent_overlay(chain, agent_id, won=won, moves=move_entries)
                )
            except (OgStorageError, ChainError) as e:
                overlay_updates.append({"agent_id": agent_id, "error": str(e)})

    ens_updates: list[dict] = []
    for side_name, label, agent_id, human_addr in [
        ("winner", req.winner_label, req.winner_agent_id, req.winner_human_address),
        ("loser", req.loser_label, req.loser_agent_id, req.loser_human_address),
    ]:
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


class SettleRequest(BaseModel):
    """KeeperHub relayer payload — emitted by match-settle.yaml step 7.

    KeeperHub signs this payload with KEEPER_PRIVKEY and POSTs it to
    RELAYER_URL/settle. The relayer calls MatchRegistry.recordMatch on
    0G Chain so the result is committed even if the loser abandons the
    frontend before clicking the manual settle button.
    """

    matchId: str
    winner: str = "0x0000000000000000000000000000000000000000"
    forfeit: bool = False
    forfeitingPlayer: str = "0x0000000000000000000000000000000000000000"
    eloDelta: int = 0
    archiveUri: str = ""
    keeperSig: str = ""


@app.post("/settle")
def settle_endpoint(req: SettleRequest):
    """KeeperHub relayer: receive signed settlement and commit to 0G Chain.

    Fetches the GameRecord from 0G Storage (via archiveUri) to recover agent
    IDs and match_length, then calls MatchRegistry.recordMatch. For the
    hackathon MVP the keeper signature is logged but not verified on-chain;
    verification via a new contract function is a post-hackathon follow-up.

    Returns {tx_hash} on success or raises HTTP 502 on chain failure.
    """
    # Fetch game record from 0G Storage to recover match parameters.
    winner_agent_id = 0
    winner_human = "0x0000000000000000000000000000000000000000"
    loser_agent_id = 0
    loser_human = "0x0000000000000000000000000000000000000000"
    match_length = 3
    game_record_hash = "0x" + "00" * 32

    if req.archiveUri:
        try:
            blob = get_blob(req.archiveUri)
            record_data = json.loads(blob)
            match_length = int(record_data.get("match_length", 3))
            winner_ref = record_data.get("winner", {})
            loser_ref = record_data.get("loser", {})
            if winner_ref.get("kind") == "agent":
                winner_agent_id = int(winner_ref.get("agent_id", 0))
            else:
                winner_human = winner_ref.get("address", winner_human)
            if loser_ref.get("kind") == "agent":
                loser_agent_id = int(loser_ref.get("agent_id", 0))
            else:
                loser_human = loser_ref.get("address", loser_human)
            # The archive URI is itself the 0G Storage root hash.
            game_record_hash = req.archiveUri if req.archiveUri.startswith("0x") else game_record_hash
        except (OgStorageError, json.JSONDecodeError, KeyError) as e:
            # Non-fatal: proceed with zeros rather than blocking settlement.
            pass

    try:
        chain = ChainClient.from_env()
    except ChainError as e:
        raise HTTPException(status_code=503, detail=f"chain client not configured: {e}") from e

    try:
        finalized = chain.record_match(
            winner_agent_id=winner_agent_id,
            winner_human=winner_human,
            loser_agent_id=loser_agent_id,
            loser_human=loser_human,
            match_length=match_length,
            game_record_hash=game_record_hash,
        )
    except ChainError as e:
        raise HTTPException(status_code=502, detail=f"recordMatch failed: {e}") from e

    return {"tx_hash": finalized.tx_hash, "match_id": finalized.match_id}


class ReplayRequest(BaseModel):
    """Replay validation request from KeeperHub's fetch-and-replay step.

    KeeperHub POSTs this to GNUBG_REPLAY_URL/replay after fetching the
    archive_uri from the on-game-end webhook. The server fetches the
    GameRecord, replays every move through gnubg, and asserts the final
    position matches the recorded value.
    """

    archive_uri: str
    match_id: str = ""
    storage_indexer: str = ""


@app.post("/replay")
def replay_endpoint(req: ReplayRequest):
    """Fetch a GameRecord from 0G Storage and validate every move through gnubg.

    Returns {valid: true, winner: address-or-agent-id} on success, or
    {valid: false, error: message} on move validation failure. Used by the
    KeeperHub workflow's fetch-and-replay step (step 5 of match-settle.yaml).
    """
    try:
        blob = get_blob(req.archive_uri)
    except OgStorageError as e:
        raise HTTPException(status_code=502, detail=f"0G Storage fetch failed: {e}") from e

    try:
        record_data = json.loads(blob)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=422, detail=f"Invalid GameRecord JSON: {e}") from e

    # Replay each recorded move through gnubg and verify the final position.
    try:
        res = gnubg.new_match(int(record_data.get("match_length", 1)))
        pos = res["position_id"]
        match = res["match_id"]
        for i, move in enumerate(record_data.get("moves", [])):
            m_str = move.get("move", "")
            if not m_str or m_str == "(auto-played)":
                continue
            out = gnubg.submit_move(pos, match, m_str)
            new_pos = out.get("position_id")
            if not new_pos:
                return {
                    "valid": False,
                    "error": f"gnubg rejected move #{i} ({m_str!r}): {out.get('output', '')[:120]}",
                }
            pos = new_pos
            match = out.get("match_id", match)

        expected = record_data.get("final_position_id")
        if expected and pos != expected:
            return {
                "valid": False,
                "error": f"final position mismatch: replayed {pos!r}, recorded {expected!r}",
            }
    except Exception as e:
        return {"valid": False, "error": f"replay error: {e}"}

    winner_ref = record_data.get("winner", {})
    if winner_ref.get("kind") == "agent":
        winner = f"agent:{winner_ref.get('agent_id')}"
    else:
        winner = winner_ref.get("address", "unknown")

    return {"valid": True, "winner": winner}


# KeeperHub YAML helper endpoints — consumed by match-settle.yaml steps 2 and 3.
#
# GET  /games/{matchId}/dice          → per-turn-drand step: return a fresh
#                                       drand round + derived dice for this turn.
# POST /matches/{matchId}/forfeit-check → forfeit-poll step: check if either
#                                         side exceeded the move clock.
# POST /webhooks/match/{matchId}/end  → on-game-end step: receive the game-end
#                                         webhook from the server itself when the
#                                         frontend calls /finalize-direct.


import threading as _threading
import httpx as _httpx

# Per-match game-end events: populated by /finalize-direct (or a future
# explicit POST), consumed by the KeeperHub on-game-end webhook step.
_game_end_events: dict[str, dict] = {}
_game_end_waiters: dict[str, _threading.Event] = {}


@app.get("/games/{match_id}/dice")
def get_match_dice(match_id: str):
    """Return a fresh drand round + derived dice for `match_id`.

    Used by the KeeperHub YAML per-turn-drand step. Pulls the latest round
    from the drand League of Entropy mainnet HTTP endpoint, then derives
    two dice as `keccak256(round_digest ‖ turn_index_be8) mod 36` (unpacked
    into d1, d2 ∈ [1, 6]).

    Returns {dice: [d1, d2], round: int, digest: hex} or 503 if drand is
    unreachable.
    """
    import hashlib as _hashlib
    try:
        r = _httpx.get("https://api.drand.sh/public/latest", timeout=5)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"drand unreachable: {e}") from e

    round_num = int(data.get("round", 0))
    randomness = data.get("randomness", "")
    # Derive turn index from stored state if available, else use round_num.
    turn_index = 0
    digest_bytes = bytes.fromhex(randomness) if randomness else b""
    turn_bytes = turn_index.to_bytes(8, "big")
    raw = _hashlib.sha3_256(digest_bytes + turn_bytes).digest()
    val = int.from_bytes(raw, "big") % 36
    d1 = (val // 6) + 1
    d2 = (val % 6) + 1
    return {"dice": [d1, d2], "round": round_num, "digest": randomness}


@app.post("/matches/{match_id}/forfeit-check")
def forfeit_check(match_id: str):
    """Check whether either player exceeded the per-turn move clock.

    MVP: no server-side move clock is tracked, so this always returns
    {forfeit: false}. A full implementation would store the last-move
    timestamp per match and compare it against the configured timeout.
    """
    return {"forfeit": False, "expired_player": None}


@app.post("/webhooks/match/{match_id}/end")
def game_end_webhook(match_id: str, body: dict):
    """Receive a game-end notification from the client or /finalize-direct.

    KeeperHub's on-game-end step waits on this webhook before proceeding
    to the replay + settlement steps. The body shape mirrors the YAML
    on-game-end output: {winner, archive_uri, elo_delta}.
    """
    _game_end_events[match_id] = body
    ev = _game_end_waiters.get(match_id)
    if ev:
        ev.set()
    return {"received": True}


# ---------------------------------------------------------------------------
# Phase 37 — Real KeeperHub workflow orchestrator
#
# The Phase 36 deterministic-seed mock has been replaced with a real
# 8-step sequential workflow (server/app/keeper_workflow.py). The
# canonical step IDs, response shape, and field names from Phase 36
# remain unchanged — frontend + tests don't need updating.
#
# GET /keeper-workflow/{match_id} — read the persisted workflow JSON;
# returns the canonical "all pending" shape if no run has happened yet.
# POST /keeper-workflow/{match_id}/run — trigger a workflow on a
# background thread; returns immediately with the running state.
# ---------------------------------------------------------------------------

from . import keeper_workflow as _keeper_workflow_module


@app.get("/keeper-workflow/{match_id}")
def keeper_workflow_status(match_id: str):
    """Return the current KeeperHub workflow state for matchId.

    Reads the persisted JSON for any prior run; falls through to the
    canonical 8-step "all pending" shape when no run has happened. The
    shape (matchId, status, steps[]) is the same contract Phase 36
    locked in for the frontend.
    """
    workflow = _keeper_workflow_module.get_workflow(match_id)
    return workflow.to_dict()


def _try_drand_check() -> bool:
    """Best-effort drand reachability probe. Returns True if the
    drand mainnet HTTP endpoint answers quickly. Used by Phase 37's
    vrf_rolls workflow step."""
    try:
        import urllib.request
        urllib.request.urlopen(
            "https://api.drand.sh/public/latest", timeout=5,
        ).read()
        return True
    except Exception:
        return False


@app.post("/keeper-workflow/{match_id}/run")
def keeper_workflow_run(match_id: str):
    """Trigger a fresh KeeperHub workflow run for matchId.

    Spawns the 8-step orchestrator on a background thread so the HTTP
    caller doesn't block on the full ~10s sequential walk; the frontend
    polls /keeper-workflow/{match_id} every ~1s to render mid-run
    progress. Returns the workflow's initial 'running' state so the
    UI has something to render immediately.
    """
    try:
        chain = ChainClient.from_env()
    except ChainError:
        chain = None
    try:
        ens = EnsClient.from_env()
    except EnsError:
        ens = None

    _keeper_workflow_module.run_workflow_in_thread(
        match_id,
        chain=chain,
        og_get_blob=get_blob,
        og_put_blob=put_blob,
        gnubg=gnubg,
        ens=ens,
        drand_check=_try_drand_check,
    )
    # Give the orchestrator a moment to flip the persisted state to
    # "running" before we read it back, so polling doesn't see a stale
    # "pending" on the very first call.
    import time as _t
    _t.sleep(0.05)
    return _keeper_workflow_module.get_workflow(match_id).to_dict()




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

    # Phase G: when use_0g_inference, wire the eval bridge in. The
    # bridge returns available=False if no backgammon-net provider is
    # registered, and estimate_run preserves that flag to the frontend
    # so the toggle disables itself with a tooltip.
    eval_estimator = None
    if use_0g_inference:
        try:
            from og_compute_eval_client import estimate as og_estimate

            eval_estimator = og_estimate
        except ImportError:
            # Bridge wrapper not available — fall through to placeholder.
            pass
    return estimate_run(
        epochs=epochs,
        agent_ids=ids,
        use_0g_inference=use_0g_inference,
        eval_estimator=eval_estimator,
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
    → `load_profile` content-sniff → `{match_count, summary, kind, owner_ens}`.

    Mirrors the resolver path /games/{id}/agent-move (overlay) and
    /agents/{id}/recommend-teammate (model) already use. Returns the
    NullProfile shape for cold-start agents (frontend renders a
    'no measurable style yet' chip).

    `owner_ens` is the ENS name of the agent's ERC-721 owner, resolved
    via web3 reverse lookup on Sepolia. Falls back to a truncated address
    when ENS resolution is unavailable (e.g. on 0G testnet)."""
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

    # Resolve the agent's ERC-721 owner and their ENS name.
    # Best-effort: missing env vars or chain errors return None gracefully.
    owner_ens: Optional[str] = None
    try:
        owner_addr = chain.agent_owner(agent_id)
        # Try ENS reverse lookup on the connected network (works on Sepolia).
        # Returns None if the address has no reverse record set.
        try:
            resolved = chain.w3.ens.name(owner_addr)
            owner_ens = resolved if resolved else _truncate_address(owner_addr)
        except Exception:
            owner_ens = _truncate_address(owner_addr)
    except ChainError:
        pass

    return {
        "agent_id": agent_id,
        "kind": kind,
        "match_count": int(metrics.get("match_count", 0)),
        "summary": profile.summarize(),
        "owner_ens": owner_ens,
    }


def _truncate_address(addr: str) -> str:
    """Return a short display form like `0x1234…abcd` for a hex address."""
    if not addr or len(addr) < 10:
        return addr
    return f"{addr[:6]}…{addr[-4:]}"
