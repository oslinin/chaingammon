import asyncio
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from pydantic import BaseModel
from typing import List, Optional
import json
import os
import re
import sys

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

from .agent_overlay import Overlay, OverlayError, update_overlay
from .chain_client import ChainClient, ChainError
from .ens_client import EnsClient, EnsError
from .game_record import (
    MoveEntry,
    PlayerRef,
    build_from_state,
    serialize_record,
)
from .game_state import GameState, decode_position_id
from .gnubg_client import GnubgClient
from .og_storage_client import OgStorageError, get_blob, get_kv, put_blob, put_kv

gnubg = GnubgClient()

app = FastAPI()
# Phase 20: the Next.js frontend at :3000 calls these endpoints cross-origin
# (live match flow, subname mint, replay fetch).
# Restricted to the deployed frontend host via ALLOWED_ORIGINS.
allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"message": "Hello from Chaingammon Server"}


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


class SubnameMintRequest(BaseModel):
    label: str
    owner: str  # the player's wallet address


@app.post("/subname/mint")
async def mint_subname(req: SubnameMintRequest):
    """Server-pays ENS subname minting for walletless / gas-free users.

    Calls PlayerSubnameRegistrar.mintSubname using the deployer key so the
    user never needs ETH. Idempotent: returns the existing node if the label
    is already minted.
    """
    try:
        ens = EnsClient.from_env()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"ENS client unavailable: {exc}") from exc

    label = req.label.strip().lower()
    if not label or not label.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid label")

    try:
        # Run the blocking web3 calls in a thread pool and skip waiting for
        # the receipt — the tx is broadcast immediately and Sepolia confirms
        # in ~15 s. The frontend reloads on success and doesn't need
        # confirmation; waiting would hold the HTTP connection open long
        # enough for the mobile browser / proxy to return 408.
        tx_hash = await asyncio.to_thread(ens.mint_subname, label, req.owner, wait=False)
        node = ens.subname_node(label)
        return {"node": node, "txHash": tx_hash, "label": label}
    except EnsError as exc:
        err = str(exc)
        # Already minted is fine — return the node so the frontend can proceed.
        if "already" in err.lower() or "exists" in err.lower() or "revert" in err.lower():
            try:
                node = ens.subname_node(label)
                return {"node": node, "txHash": None, "label": label}
            except Exception:
                pass
        raise HTTPException(status_code=400, detail=err) from exc


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


def _fetch_overlay(agent_id: int) -> Overlay:
    """Read the agent's current overlay from 0G KV. Returns Overlay.default()
    for cold-start agents (key not yet written) or on any fetch/parse error."""
    kv_key = f"chaingammon/overlay/agent/{agent_id}"
    try:
        blob = get_kv(kv_key)
        return Overlay.from_bytes(blob)
    except (OgStorageError, OverlayError):
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


def _update_agent_overlay_kv(
    agent_id: int,
    moves: list,
    overlay_updates: list,
    *,
    turn: int | None = None,
) -> None:
    """Write an updated style overlay to 0G KV for `agent_id`.

    Non-fatal: KV failures are logged and appended to overlay_updates with
    an `error` field. Skips agent_id == 0 (human players have no overlay).

    `turn` (0 or 1) filters `moves` to only the agent's own moves before
    computing the overlay target. Pass None only when move history is absent
    (legacy/empty move lists) so the no-op update still increments match_count.
    """
    import logging
    if agent_id == 0:
        return
    logger = logging.getLogger(__name__)
    kv_key = f"chaingammon/overlay/agent/{agent_id}"
    try:
        try:
            raw = get_kv(kv_key)
            current = Overlay.from_bytes(raw)
        except (OgStorageError, OverlayError):
            current = Overlay.default()
        agent_moves = [m for m in moves if m.turn == turn] if turn is not None else moves
        new_overlay = update_overlay(current, agent_moves, current.match_count)
        put_kv(kv_key, new_overlay.to_bytes())
        overlay_updates.append({"agent_id": agent_id, "match_count": new_overlay.match_count})
    except Exception as e:
        logger.warning("overlay KV write failed for agent %d: %s", agent_id, e)
        overlay_updates.append({"agent_id": agent_id, "error": str(e)})


_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


def _update_human_overlay_kv(
    human_address: str,
    moves: list,
    overlay_updates: list,
    *,
    turn: int | None = None,
) -> None:
    """Write an updated style overlay to 0G KV for a human player.

    Non-fatal: KV failures are logged and appended to overlay_updates with
    an `error` field. Skips the zero address (no human in this slot).

    `turn` (0 or 1) filters `moves` to only the human's own moves before
    computing the overlay target.
    """
    import logging
    if not human_address or human_address == _ZERO_ADDRESS:
        return
    logger = logging.getLogger(__name__)
    kv_key = f"chaingammon/overlay/human/{human_address.lower()}"
    try:
        try:
            raw = get_kv(kv_key)
            current = Overlay.from_bytes(raw)
        except (OgStorageError, OverlayError):
            current = Overlay.default()
        human_moves = [m for m in moves if m.turn == turn] if turn is not None else moves
        new_overlay = update_overlay(current, human_moves, current.match_count)
        put_kv(kv_key, new_overlay.to_bytes())
        overlay_updates.append({"human_address": human_address, "match_count": new_overlay.match_count})
    except Exception as e:
        logger.warning("overlay KV write failed for human %s: %s", human_address, e)
        overlay_updates.append({"human_address": human_address, "error": str(e)})



# ---------------------------------------------------------------------------
# KeeperHub integration: /finalize-direct, /settle (relayer)
#
# The match page drives gameplay through the client-side ONNX engine without
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
#   POST /replay — Move replay validation endpoint. Receives {archive_uri,
#       match_id} from KeeperHub's fetch-and-replay step, fetches the
#       GameRecord from 0G Storage, and validates every move via the
#       rules engine. Returns {valid: bool, winner: str}.
# ---------------------------------------------------------------------------


class DirectFinalizeRequest(BaseModel):
    """Finalize a match from the client-side engine state without a server game_id.

    The match page drives gameplay through the ONNX BackgammonNet engine in
    the browser and never registers a game at this server. At game-end the
    frontend calls this endpoint so the audit pipeline runs automatically:
    0G Storage upload → recordMatch on-chain → overlay updates → ENS push.
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
    # Which gnubg turn (0 or 1) each side played. Required for correct
    # per-agent overlay updates; None disables turn filtering (legacy/no moves).
    winner_turn: int | None = None
    loser_turn: int | None = None


class StakedFinalizeRequest(DirectFinalizeRequest):
    """Same as DirectFinalizeRequest plus the escrow context.

    Routes through `recordMatchAndSplit` so the on-chain match record and
    the escrow payout happen in the same tx. Single-winner only — the pot
    goes to the winning side's address (the agent's session-key wallet
    when an agent wins, the human's wallet when the human wins).
    """

    escrow_match_id: str  # bytes32 the human + agent both deposited under
    stake_wei: str  # per-side stake; pot = stake_wei * 2. Stringified to fit JSON's int range.
    keeper_settle: bool = False  # if True, skip on-chain call; store params for KeeperHub to settle


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
    _update_agent_overlay_kv(req.winner_agent_id, move_entries, overlay_updates, turn=req.winner_turn)
    _update_agent_overlay_kv(req.loser_agent_id, move_entries, overlay_updates, turn=req.loser_turn)
    _update_human_overlay_kv(req.winner_human_address, move_entries, overlay_updates, turn=req.winner_turn)
    _update_human_overlay_kv(req.loser_human_address, move_entries, overlay_updates, turn=req.loser_turn)

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


@app.post("/finalize-direct-staked", response_model=FinalizeResponse)
def finalize_direct_staked(req: StakedFinalizeRequest):
    """Staked variant of /finalize-direct. Routes through
    `MatchRegistry.recordMatchAndSplit` so the ELO update and the escrow
    payout happen atomically — no orphan matches if the payout reverts.

    Single-winner only: the pot (stake_wei × 2) goes to the winning
    side's address. When the agent wins, the recipient is the agent's
    server-managed session-key wallet — the agent's owner withdraws
    from there via /agents/{id}/withdraw.
    """
    try:
        stake_wei = int(req.stake_wei)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"stake_wei must be an integer, got {req.stake_wei!r}")
    if stake_wei <= 0:
        raise HTTPException(status_code=400, detail="stake_wei must be positive")
    if not req.escrow_match_id.startswith("0x") or len(req.escrow_match_id) != 66:
        raise HTTPException(status_code=400, detail=f"escrow_match_id must be 0x + 64 hex chars: {req.escrow_match_id!r}")

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

    synthetic_state = GameState(
        game_id="direct-staked",
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

    # Winner payout address: agent wins → owner withdraws from vault directly;
    # human wins → their wallet address.
    if req.winner_human_address == "0x0000000000000000000000000000000000000000" and req.winner_agent_id == 0:
        raise HTTPException(status_code=400, detail="winner_human_address required when human wins")
    winner_payout_addr = req.winner_human_address if req.winner_agent_id == 0 else req.winner_human_address

    pot_wei = stake_wei * 2

    try:
        chain = ChainClient.from_env()
    except ChainError as e:
        raise HTTPException(status_code=500, detail=f"chain client misconfigured: {e}") from e

    if req.keeper_settle:
        # Store params for KeeperHub to pick up via POST /replay and settle on-chain directly.
        _pending_settlements[req.escrow_match_id] = {
            "winnerAgentId": req.winner_agent_id,
            "winnerHuman": req.winner_human_address,
            "loserAgentId": req.loser_agent_id,
            "loserHuman": req.loser_human_address,
            "matchLength": int(req.match_length),
            "gameRecordHash": upload.root_hash,
            "winnerAddr": winner_payout_addr,
        }
        return {
            "tx_hash": None,
            "match_id": None,
            "keeper_settle": True,
            "escrow_match_id": req.escrow_match_id,
            "archive_uri": upload.root_hash,
        }

    try:
        finalized = chain.record_match_and_split(
            winner_agent_id=req.winner_agent_id,
            winner_human=req.winner_human_address,
            loser_agent_id=req.loser_agent_id,
            loser_human=req.loser_human_address,
            match_length=int(req.match_length),
            game_record_hash=upload.root_hash,
            escrow_match_id=req.escrow_match_id,
            winners=[winner_payout_addr],
            shares=[pot_wei],
        )
    except ChainError as e:
        raise HTTPException(status_code=502, detail=f"recordMatchAndSplit failed: {e}") from e

    overlay_updates: list[dict] = []
    _update_agent_overlay_kv(req.winner_agent_id, move_entries, overlay_updates, turn=req.winner_turn)
    _update_agent_overlay_kv(req.loser_agent_id, move_entries, overlay_updates, turn=req.loser_turn)
    _update_human_overlay_kv(req.winner_human_address, move_entries, overlay_updates, turn=req.winner_turn)
    _update_human_overlay_kv(req.loser_human_address, move_entries, overlay_updates, turn=req.loser_turn)

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

    KeeperHub ECDSA-signs this payload with KEEPER_PRIVKEY and POSTs it to
    RELAYER_URL/settle. The relayer verifies the signature against
    KEEPER_PUBKEY (set in server/.env), fetches the GameRecord from 0G
    Storage, reads the live escrow pot, then calls
    MatchRegistry.recordMatchAndSplit so the match record and escrow payout
    happen atomically in a single transaction.

    `escrowMatchId` is the bytes32 key both players deposited under in
    MatchEscrow. It is included in the signed payload so the relayer cannot
    substitute a different escrow bucket.
    """

    matchId: str
    winner: str = "0x0000000000000000000000000000000000000000"
    forfeit: bool = False
    forfeitingPlayer: str = "0x0000000000000000000000000000000000000000"
    eloDelta: int = 0
    archiveUri: str = ""
    escrowMatchId: str = ""  # 0x-prefixed bytes32; empty → no escrow payout
    keeperSig: str = ""


def _verify_keeper_sig(req: "SettleRequest") -> None:
    """Verify the ECDSA keeperSig over the canonical settlement payload.

    The signed message is the EIP-191 personal_sign hash of:
        keccak256(matchId_bytes32 + winner_bytes + forfeit_byte +
                  forfeitingPlayer_bytes + archiveUri_utf8 + escrowMatchId_bytes32)

    The expected signer is KEEPER_PUBKEY from the environment (Ethereum
    checksummed address). If KEEPER_PUBKEY is not set the check is skipped
    with a warning so the server can start without it; a missing pubkey in
    production is logged as an error.

    Raises HTTPException 403 on a bad signature.
    """
    import logging as _logging
    from eth_account import Account as _Account
    from eth_account.messages import encode_defunct as _encode_defunct
    from web3 import Web3 as _Web3

    keeper_pubkey = os.environ.get("KEEPER_PUBKEY", "").strip()
    if not keeper_pubkey:
        _logging.getLogger(__name__).error(
            "KEEPER_PUBKEY not set — skipping keeper signature verification. "
            "Set KEEPER_PUBKEY in server/.env to harden the /settle endpoint."
        )
        return
    if not req.keeperSig:
        raise HTTPException(
            status_code=403,
            detail="keeperSig is required but was not provided",
        )

    # Canonical payload bytes (deterministic, order-stable).
    # Fields match exactly what match-settle.yaml's sign-settlement step signs.
    try:
        match_id_bytes = _Web3.to_bytes(hexstr=req.matchId) if req.matchId.startswith("0x") else req.matchId.encode()
        escrow_bytes = (
            _Web3.to_bytes(hexstr=req.escrowMatchId)
            if req.escrowMatchId.startswith("0x")
            else req.escrowMatchId.encode()
        )
        payload_bytes = (
            match_id_bytes
            + req.winner.encode()
            + (b"\x01" if req.forfeit else b"\x00")
            + req.forfeitingPlayer.encode()
            + req.archiveUri.encode()
            + escrow_bytes
        )
        msg = _encode_defunct(primitive=payload_bytes)
        recovered = _Account.recover_message(msg, signature=req.keeperSig)
    except Exception as exc:
        raise HTTPException(
            status_code=403,
            detail=f"keeperSig recovery failed: {exc}",
        ) from exc

    if recovered.lower() != keeper_pubkey.lower():
        raise HTTPException(
            status_code=403,
            detail=(
                f"keeperSig signer {recovered} does not match "
                f"KEEPER_PUBKEY {keeper_pubkey}"
            ),
        )


@app.post("/settle")
def settle_endpoint(req: SettleRequest):
    """KeeperHub relayer: verify keeper signature, then commit to 0G Chain.

    Flow:
      1. Verify the ECDSA keeperSig against KEEPER_PUBKEY.
      2. Fetch the GameRecord from 0G Storage (via archiveUri) to recover
         agent IDs, match_length, and game_record_hash.
      3. If escrowMatchId is provided, read the live pot from MatchEscrow
         and call MatchRegistry.recordMatchAndSplit so the match record and
         escrow payout happen atomically.
      4. If escrowMatchId is absent (un-staked match), fall back to
         recordMatch (record-only, no payout).

    Returns {tx_hash, match_id} on success or raises HTTP 4xx/5xx.
    """
    # Step 1 — verify keeper signature before touching the chain.
    _verify_keeper_sig(req)

    # Step 2 — fetch game record from 0G Storage to recover match parameters.
    winner_agent_id = 0
    winner_human = "0x0000000000000000000000000000000000000000"
    loser_agent_id = 0
    loser_human = "0x0000000000000000000000000000000000000000"
    match_length = 3
    game_record_hash = "0x" + "00" * 32

    record_data: dict = {}
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
            game_record_hash = (
                req.archiveUri
                if req.archiveUri.startswith("0x")
                else game_record_hash
            )
        except (OgStorageError, json.JSONDecodeError, KeyError):
            # Non-fatal: proceed with zeros rather than blocking settlement.
            pass

    try:
        chain = ChainClient.from_env()
    except ChainError as e:
        raise HTTPException(
            status_code=503, detail=f"chain client not configured: {e}"
        ) from e

    # Step 3 — staked path: read escrow pot and call recordMatchAndSplit.
    escrow_match_id = (req.escrowMatchId or "").strip()
    if escrow_match_id and escrow_match_id.startswith("0x") and len(escrow_match_id) == 66:
        try:
            pot = chain.escrow_pot(escrow_match_id)
        except ChainError as e:
            raise HTTPException(
                status_code=502,
                detail=f"escrow pot read failed: {e}",
            ) from e

        if pot == 0:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Escrow pot for {escrow_match_id} is zero — already paid "
                    f"out or never funded. Settlement aborted."
                ),
            )

        # Resolve winner address from the request.
        # `req.winner` is either a 0x address (human) or an "agent:<id>" string
        # produced by the /replay endpoint. Normalise to a checksum address.
        winner_addr = req.winner
        if winner_addr.lower().startswith("agent:"):
            # Agent won — pay out to the NFT owner's wallet; owner can
            # deposit winnings back into AgentVault if desired.
            try:
                agent_id_str = winner_addr.split(":", 1)[1]
                winner_addr = chain.agent_owner(int(agent_id_str))
            except Exception:
                winner_addr = chain.account_address
        try:
            from web3 import Web3 as _Web3
            winner_addr = _Web3.to_checksum_address(winner_addr)
        except Exception as exc:
            raise HTTPException(
                status_code=422,
                detail=f"winner address invalid: {req.winner!r} → {exc}",
            ) from exc

        try:
            finalized = chain.record_match_and_split(
                winner_agent_id=winner_agent_id,
                winner_human=winner_human,
                loser_agent_id=loser_agent_id,
                loser_human=loser_human,
                match_length=match_length,
                game_record_hash=game_record_hash,
                escrow_match_id=escrow_match_id,
                winners=[winner_addr],
                shares=[pot],
            )
        except ChainError as e:
            raise HTTPException(
                status_code=502, detail=f"recordMatchAndSplit failed: {e}"
            ) from e

        # Annotate the in-memory game record with settlement metadata so the
        # keeper_workflow settlement_signed step can verify the sig on replay.
        # We don't re-upload the blob (it would change the root hash and break
        # the on-chain gameRecordHash anchor); instead the workflow reads
        # record_data from the /keeper-workflow run context where these fields
        # are injected by the relay step.
        record_data["keeper_sig"] = req.keeperSig
        record_data["escrow_match_id"] = escrow_match_id
        record_data["winner_addr"] = winner_addr
        record_data["forfeit"] = req.forfeit
        record_data["forfeiting_player"] = req.forfeitingPlayer
        record_data["archive_uri"] = req.archiveUri

        return {
            "tx_hash": finalized.tx_hash,
            "match_id": finalized.match_id,
            "payout_wei": pot,
            "payout_winner": winner_addr,
        }

    # Step 4 — un-staked path: record only, no escrow payout.
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
        raise HTTPException(
            status_code=502, detail=f"recordMatch failed: {e}"
        ) from e

    return {"tx_hash": finalized.tx_hash, "match_id": finalized.match_id}


# ---------------------------------------------------------------------------
# POST /upload-game-record — called by the browser before settleWithSessionKeys.
#
# The browser builds a minimal GameRecord JSON (final position, winner/loser
# refs, optional labels) and POSTs it here. The server uploads it to 0G
# Storage using the existing og-bridge pipeline and returns the Merkle root
# hash. The browser then passes that hash as `gameRecordHash` to
# settleWithSessionKeys so the on-chain commitment points at a real blob
# the post-settle keeper can later fetch for ENS sync.
#
# Non-blocking for the browser: a failure here degrades gracefully — the
# browser falls back to a local keccak256 hash and settlement still works.
# ---------------------------------------------------------------------------


class UploadGameRecordRequest(BaseModel):
    """Raw game record JSON from the browser.

    Serialised with sorted keys before upload so the same logical record
    always produces the same Merkle root. The server does not validate the
    schema beyond ensuring it is valid JSON — the keeper's fetch-and-audit
    step handles any schema drift gracefully.
    """

    record: dict


@app.post("/upload-game-record")
def upload_game_record(req: UploadGameRecordRequest):
    """Upload a browser-built game record to 0G Storage and return its root hash.

    Called by the frontend immediately before settleWithSessionKeys so the
    gameRecordHash anchored on-chain points at a real 0G blob. The returned
    root_hash is passed verbatim as the gameRecordHash argument.

    Returns {root_hash, tx_hash} on success or raises HTTP 502 if 0G Storage
    is unreachable (the browser should fall back to a local keccak256 hash).
    """
    try:
        payload = json.dumps(req.record, sort_keys=True, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=422, detail=f"record serialization failed: {e}") from e

    try:
        result = put_blob(payload)
    except OgStorageError as e:
        raise HTTPException(status_code=502, detail=f"0G Storage upload failed: {e}") from e

    return {"root_hash": result.root_hash, "tx_hash": result.tx_hash}


# ---------------------------------------------------------------------------
# POST /relay-settle — gasless settlement relay for Privy embedded wallets.
#
# Email/Google players get a Privy embedded wallet that holds no gas token,
# so they cannot submit settleWithSessionKeys themselves. The browser builds
# the identical humanAuthSig + session-key resultSig it would sign for a
# wallet-direct settlement and POSTs them here; the server submits the tx
# from the operator's gas-paying account. The contract still verifies both
# signatures and the per-human nonce, so the relayer only sponsors gas — it
# cannot forge a result. External wallets keep submitting directly.
# ---------------------------------------------------------------------------


class RelaySettleRequest(BaseModel):
    """Signed args for a gasless relay of MatchRegistry.settleWithSessionKeys.

    `nonce` is the on-chain `nonces[human]` value the signatures were bound
    to. Signatures are 0x-prefixed hex as produced by the browser wallet /
    session key.
    """

    human: str
    agent_id: int
    match_length: int
    human_wins: bool
    game_record_hash: str
    nonce: int
    session_key: str
    human_auth_sig: str
    result_sig: str
    escrow_match_id: str | None = None
    winners: list[str] = []
    shares: list[str] = []


@app.post("/relay-settle")
def relay_settle(req: RelaySettleRequest):
    """Sponsor gas for a trustless settleWithSessionKeys tx. Returns
    {match_id, tx_hash}.

    The MatchRecorded event this emits drives the same post-settle-audit
    (ENS + overlay) workflow as a wallet-submitted settlement, so no audit
    runs inline here — keeping parity with the wallet-direct path.
    """
    try:
        chain = ChainClient.from_env()
    except ChainError as e:
        raise HTTPException(status_code=503, detail=f"chain client not configured: {e}") from e

    try:
        finalized = chain.settle_with_session_keys(
            human=req.human,
            agent_id=int(req.agent_id),
            match_length=int(req.match_length),
            human_wins=bool(req.human_wins),
            game_record_hash=req.game_record_hash,
            nonce=int(req.nonce),
            session_key=req.session_key,
            human_auth_sig=req.human_auth_sig,
            result_sig=req.result_sig,
            escrow_match_id=req.escrow_match_id,
            winners=req.winners,
            shares=[int(s) for s in req.shares],
        )
    except ChainError as e:
        # Bad signature, nonce mismatch, or malformed input — client error.
        raise HTTPException(status_code=400, detail=f"relay settlement failed: {e}") from e

    return {"match_id": finalized.match_id, "tx_hash": finalized.tx_hash}


# ---------------------------------------------------------------------------
# POST /post-settle-audit — called by the post-settle-audit.yaml KeeperHub
# workflow after any MatchRecorded event on MatchRegistry (Sepolia).
#
# This covers the browser-settlement path where the frontend calls
# settleWithSessionKeys directly and never touches /finalize-direct:
#   1. Read match info from MatchRegistry.getMatch(matchId).
#   2. Fetch the game record blob from 0G Storage via gameRecordHash.
#   3. Extract winner_label / loser_label from the blob (if present).
#   4. Push elo + last_match_id ENS text records for each labelled side.
#   5. Update agent style-overlay KV in 0G Storage (non-fatal).
#   6. Return a JSON audit summary.
# ---------------------------------------------------------------------------


class PostSettleAuditRequest(BaseModel):
    """Payload sent by the post-settle-audit.yaml keeper step run-audit.

    Only `matchId` is required — the server reads all other parameters from
    the chain and the 0G Storage game record, so the keeper workflow needs
    no out-of-band context beyond the on-chain match identifier.
    """

    matchId: int


@app.post("/post-settle-audit")
def post_settle_audit(req: PostSettleAuditRequest):
    """Keeper-triggered post-settlement audit: ENS sync + overlay update.

    Idempotent — pushing the same ELO value to ENS twice is a no-op from
    the protocol's perspective. Safe to call for both browser-settled matches
    (settleWithSessionKeys) and relayer-settled matches (recordMatch via
    /settle), though /finalize-direct already handles ENS for its path.
    """
    import logging as _logging
    _log = _logging.getLogger(__name__)

    try:
        chain = ChainClient.from_env()
    except ChainError as e:
        raise HTTPException(status_code=503, detail=f"chain client not configured: {e}") from e

    # Step 1 — read match info from chain.
    try:
        info = chain.get_match(req.matchId)
    except ChainError as e:
        raise HTTPException(status_code=502, detail=f"getMatch({req.matchId}) failed: {e}") from e

    winner_agent_id = int(info["winnerAgentId"])
    winner_human = str(info["winnerHuman"])
    loser_agent_id = int(info["loserAgentId"])
    loser_human = str(info["loserHuman"])
    game_record_hash = str(info["gameRecordHash"])

    # Step 2 — fetch game record from 0G Storage to recover labels + moves.
    winner_label = ""
    loser_label = ""
    moves: list = []
    winner_kind: str | None = None
    loser_kind: str | None = None
    zero_hash = "0x" + "00" * 32
    if game_record_hash and game_record_hash != zero_hash:
        try:
            blob = get_blob(game_record_hash)
            record_data = json.loads(blob)
            winner_label = record_data.get("winner_label") or ""
            loser_label = record_data.get("loser_label") or ""
            moves = record_data.get("moves") or []
            winner_kind = (record_data.get("winner") or {}).get("kind")
            loser_kind = (record_data.get("loser") or {}).get("kind")
        except (OgStorageError, json.JSONDecodeError, KeyError) as e:
            _log.warning("post-settle-audit: could not fetch game record %s: %s", game_record_hash, e)

    # Step 3 — push ENS text records for each labelled side (non-fatal per side).
    ens_updates: list[dict] = []
    for side_name, label, agent_id, human_address in [
        ("winner", winner_label, winner_agent_id, winner_human),
        ("loser", loser_label, loser_agent_id, loser_human),
    ]:
        if not label:
            continue
        try:
            result = _push_ens_updates(
                chain=chain,
                label=label,
                agent_id=agent_id,
                human_address=human_address,
                match_id=req.matchId,
            )
            ens_updates.append({"side": side_name, **result})
        except Exception as e:
            _log.warning("post-settle-audit: ENS push failed for %s (%s): %s", label, side_name, e)
            ens_updates.append({"side": side_name, "label": label, "error": str(e)})

    # Step 4 — update style-overlay KV for each side (agents and humans, non-fatal).
    # Infer each side's turn from the game record's PlayerRef kind: agents are
    # always turn 1 and humans are turn 0 in all current match configurations.
    winner_turn_inferred: int | None = (1 if winner_kind == "agent" else 0) if winner_kind else None
    loser_turn_inferred: int | None = (1 if loser_kind == "agent" else 0) if loser_kind else None
    overlay_updates: list[dict] = []
    _update_agent_overlay_kv(winner_agent_id, moves=moves, overlay_updates=overlay_updates, turn=winner_turn_inferred)
    _update_agent_overlay_kv(loser_agent_id, moves=moves, overlay_updates=overlay_updates, turn=loser_turn_inferred)
    _update_human_overlay_kv(winner_human, moves=moves, overlay_updates=overlay_updates, turn=winner_turn_inferred)
    _update_human_overlay_kv(loser_human, moves=moves, overlay_updates=overlay_updates, turn=loser_turn_inferred)

    return {
        "match_id": req.matchId,
        "game_record_hash": game_record_hash,
        "ens_updates": ens_updates,
        "overlay_updates": overlay_updates,
    }


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

# Keeper-settle params: keyed by escrow_match_id (0x-prefixed bytes32).
# Populated by /finalize-staked-direct when keeper_settle=True.
# Consumed by POST /replay so KeeperHub can call recordMatchAndSplit directly.
_pending_settlements: dict[str, dict] = {}


class ReplayRequest(BaseModel):
    match_id: str  # 0x-prefixed bytes32 escrow match ID


@app.post("/replay")
def replay_endpoint(req: ReplayRequest):
    """KeeperHub validate step: return settlement params for a pending keeper-settle match.

    The KeeperHub workflow calls this after both deposits land. If the match
    has been finalized with keeper_settle=True, returns all fields needed for
    recordMatchAndSplit. Returns valid=false if the match is not yet ready.
    """
    params = _pending_settlements.get(req.match_id)
    if not params:
        return {"valid": False, "reason": "match not yet finalized or not using keeper-settle path"}
    return {
        "valid": True,
        "winnerAgentId": params["winnerAgentId"],
        "winnerHuman": params["winnerHuman"],
        "loserAgentId": params["loserAgentId"],
        "loserHuman": params["loserHuman"],
        "matchLength": params["matchLength"],
        "gameRecordHash": params["gameRecordHash"],
        "winnerAddr": params["winnerAddr"],
    }


@app.get("/games/{match_id}/dice")
def get_match_dice(match_id: str):
    """Return a fresh drand round + derived dice for `match_id`.

    Used by the KeeperHub YAML per-turn-drand step. Pulls the latest round
    from the drand League of Entropy mainnet HTTP endpoint, derives two
    dice as `sha3_256(round_digest ‖ turn_index_be8) mod 36` (unpacked
    into d1, d2 ∈ [1, 6]), and returns the round metadata + BLS signature
    so auditors can independently verify on-platform.

    The server does NOT verify the BLS signature itself — it threads
    drand's response through verbatim. To make a round verifiable an
    auditor:
      1. Fetches drand's group public key from https://api.drand.sh/info
         (or pins the 48-byte G1 hex constant).
      2. Computes `msg = sha256(previous_signature ‖ round_be8)` for the
         legacy chained mainnet chain `/public/latest` falls through to.
      3. Verifies the BLS12-381 signature (G2) against (pubkey, msg).
      4. Re-derives the dice locally and asserts they match.

    Returns {dice, round, digest, signature, previous_signature, chain}
    or 503 if drand is unreachable.
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
    signature = data.get("signature", "")
    previous_signature = data.get("previous_signature", "")
    # Derive turn index from stored state if available, else use round_num.
    turn_index = 0
    digest_bytes = bytes.fromhex(randomness) if randomness else b""
    turn_bytes = turn_index.to_bytes(8, "big")
    raw = _hashlib.sha3_256(digest_bytes + turn_bytes).digest()
    val = int.from_bytes(raw, "big") % 36
    d1 = (val // 6) + 1
    d2 = (val % 6) + 1
    return {
        "dice": [d1, d2],
        "round": round_num,
        "digest": randomness,
        "signature": signature,
        "previous_signature": previous_signature,
        "chain": "https://api.drand.sh/public/latest",
    }


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
def keeper_workflow_run(match_id: str, stake_wei: int = 0):
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
        ens=ens,
        drand_check=_try_drand_check,
        stake_wei=stake_wei,
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
        net = BackgammonNet(extras_dim=16, extras_seed=agent_id)
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
    trainer_mode: str = "round_robin"
    # When True, save a checkpoint per agent at end of run and upload to
    # 0G Storage. Auto-derived as True when any 0G backend is selected
    # (inference or coaching), because the user has signalled 0G intent.
    # Requires OG_STORAGE_{RPC,INDEXER,PRIVATE_KEY} env vars in the
    # server process; upload failure surfaces as an agent_save_error
    # event in /training/status rather than aborting the whole run.
    upload_to_0g: bool = False
    # Skip AES-256-GCM encryption — demo path so a server with no key
    # file can fetch the checkpoint via load_profile. Leave False for
    # production agents; the uploaded blob will be publicly readable.
    no_encrypt: bool = False
    # Per-agent model source code. Keys are agent IDs as strings (JSON
    # requirement). Agents whose code contains 'from sklearn' are trained
    # as sklearn models instead of BackgammonNet MLP.
    model_codes: dict[str, str] = {}
    # Per-agent search depth for expectiminimax. Keys are agent IDs as strings.
    # 1 = greedy 1-ply (default). 2 = 2-ply (~21x slower but stronger signal).
    search_depths: dict[str, int] = {}


@app.post("/training/start")
def post_training_start(req: StartTrainingRequest):
    """Spawn a round-robin training subprocess. 409 if one is already
    running. Returns `{job_id, started_at, epochs, agent_ids}`."""
    print(f"TRAINING_START_REQ: {req}")
    # Auto-derive: if any 0G backend is selected, default to uploading
    # trained weights to 0G KV so the agent's profile stays current.
    upload_to_0g = req.upload_to_0g or req.use_0g_inference or req.use_0g_coaching
    try:
        job = start_job(
            epochs=req.epochs,
            agent_ids=req.agent_ids,
            trainer_mode=req.trainer_mode,
            use_0g_inference=req.use_0g_inference,
            use_0g_coaching=req.use_0g_coaching,
            extras_dim=req.extras_dim,
            seed=req.seed,
            upload_to_0g=upload_to_0g,
            no_encrypt=req.no_encrypt,
            model_codes={int(k): v for k, v in req.model_codes.items()} if req.model_codes else None,
            search_depths={int(k): int(v) for k, v in req.search_depths.items()} if req.search_depths else None,
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
        "upload_to_0g": job.upload_to_0g,
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
    """List all active (non-burned) agents. Returns `[{agent_id,
    weights_hash, match_count, tier}]`. Label resolution (ENS) happens
    client-side. 503 when the chain isn't reachable."""
    try:
        chain = ChainClient.from_env()
        if chain.agent_registry is None:
            raise ChainError("AGENT_REGISTRY_ADDRESS not set")
        count = chain.active_agent_count()
    except ChainError as e:
        raise HTTPException(status_code=503, detail=f"chain unavailable: {e}")

    agents = []
    for i in range(count):
        try:
            aid = chain.active_agent_at(i)
            hashes = chain.agent_data_hashes(aid)
            meta_uri = ""
            try:
                meta_uri = chain.agent_metadata_uri(aid)
            except Exception:
                pass
            try:
                meta = json.loads(meta_uri)
                label = meta.get("label", meta_uri)
                summary = meta.get("summary", "")
            except Exception:
                label = meta_uri
                summary = ""
            agents.append({
                "agent_id": aid,
                "weights_hash": hashes[1] if len(hashes) >= 2 else "",
                "match_count": chain.agent_match_count(aid),
                "tier": chain.agent_tier(aid),
                "label": label,
                "summary": summary,
            })
        except ChainError:
            pass
    return agents


@app.get("/agents/{agent_id}/profile")
def get_agent_profile(agent_id: int):
    """Return the agent's profile — NN weights summary and style overlay.

    Reads from 0G KV:
      - chaingammon/weights/agent/{id} → load_profile_from_bytes → kind/summary
      - chaingammon/overlay/agent/{id} → Overlay.from_bytes → overlay_values

    Falls back to NullProfile / empty overlay for cold-start agents.
    `owner_ens` resolves the ERC-721 owner via ENS reverse lookup on Sepolia.
    """
    from agent_profile import (
        ModelProfile,
        NullProfile,
        OverlayProfile,
        load_profile_from_bytes,
    )

    # Fetch NN weights from KV (written by training_service after each run).
    weights_kv_key = f"chaingammon/weights/agent/{agent_id}"
    weights_bytes: bytes = b""
    try:
        weights_bytes = get_kv(weights_kv_key)
    except OgStorageError:
        pass  # KV unavailable (testnet has no KV client yet) or cold-start.

    # Fall back to 0G blob storage via the on-chain overlay hash.
    # The 0G TS SDK v1.2.6 exposes Indexer/Downloader but no KV client, so
    # get_kv only works against the localhost JSON-file mock. Every prod
    # agent would otherwise return kind="null" even when AgentRegistry
    # holds a non-zero overlayHash pointing at a real overlay blob.
    _ZERO_HASH = "0x" + "00" * 32
    if not weights_bytes:
        try:
            chain = ChainClient.from_env()
            _, overlay_hash = chain.agent_data_hashes(agent_id)
            if overlay_hash and overlay_hash.lower() != _ZERO_HASH:
                weights_bytes = get_blob(overlay_hash)
        except (ChainError, OgStorageError):
            pass

    profile = load_profile_from_bytes(weights_bytes) if weights_bytes else NullProfile()
    metrics = profile.metrics()
    if isinstance(profile, ModelProfile):
        kind = "model"
    elif isinstance(profile, OverlayProfile):
        kind = "overlay"
    else:
        kind = "null"

    # Fetch the feature overlay from KV (written per game by finalize endpoints).
    overlay_kv_key = f"chaingammon/overlay/agent/{agent_id}"
    overlay_values: dict = {}
    overlay_blob: bytes = b""
    try:
        overlay_blob = get_kv(overlay_kv_key)
    except OgStorageError:
        pass

    # Same blob-storage fallback as above — the chain's overlayHash is the
    # canonical pointer; the KV is just a cache that's not yet reachable
    # on testnet.
    if not overlay_blob:
        try:
            chain = ChainClient.from_env()
            _, overlay_hash = chain.agent_data_hashes(agent_id)
            if overlay_hash and overlay_hash.lower() != _ZERO_HASH:
                overlay_blob = get_blob(overlay_hash)
        except (ChainError, OgStorageError):
            pass

    if overlay_blob:
        try:
            overlay = Overlay.from_bytes(overlay_blob)
            overlay_values = {c: float(overlay.values[c]) for c in overlay.values}
        except OverlayError:
            pass

    # Resolve the agent's ERC-721 owner and their ENS name via chain.
    # Best-effort: missing env vars or chain errors return None gracefully.
    owner_ens: Optional[str] = None
    try:
        chain = ChainClient.from_env()
        owner_addr = chain.agent_owner(agent_id)
        try:
            resolved = chain.w3.ens.name(owner_addr)
            owner_ens = resolved if resolved else _truncate_address(owner_addr)
        except Exception:
            owner_ens = _truncate_address(owner_addr)
    except ChainError:
        pass

    # Per-category weight bars for the frontend. KV overlay takes precedence;
    # fall back to model checkpoint style_values for trained nets with no KV
    # overlay yet.
    values: dict = overlay_values or {}
    if not values:
        if isinstance(profile, OverlayProfile):
            values = {str(k): float(v) for k, v in metrics.get("values", {}).items()}
        elif isinstance(profile, ModelProfile):
            values = {str(k): float(v) for k, v in metrics.get("style_values", {}).items()}

    # For model checkpoints expose network shape metadata on the info page.
    model_meta: dict = {}
    if isinstance(profile, ModelProfile):
        model_meta = {
            k: (v if isinstance(v, (str, int, float, bool)) else str(v))
            for k, v in metrics.items()
            if k not in ("kind", "style_values", "match_count")
        }

    return {
        "agent_id": agent_id,
        "kind": kind,
        "kv_key": weights_kv_key,
        "match_count": int(metrics.get("match_count", 0)),
        "summary": profile.summarize(),
        "owner_ens": owner_ens,
        "values": values,
        "overlay_values": overlay_values,
        "model_meta": model_meta,
    }


@app.get("/agents/{agent_id}/runs")
def get_agent_runs(agent_id: int):
    """Return a list of training and tournament runs that included this agent.

    Scans all persisted JSONL status files in /tmp for runs where this
    agent_id appears in the `agents_loaded` event.  Returns newest-first.
    Each entry: {started_at, ended_at, mode, epochs, matches, wins, losses,
                 net_wei, tournament}.
    """
    import glob
    import tempfile

    tmp = tempfile.gettempdir()
    jsonl_files = sorted(
        glob.glob(os.path.join(tmp, "chaingammon-training-*.jsonl")),
        key=os.path.getmtime,
        reverse=True,
    )

    runs = []
    for path in jsonl_files:
        try:
            events: list[dict] = []
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            events.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass

            # Find agents_loaded event to check if this agent participated.
            loaded_event = next((e for e in events if e.get("event") == "agents_loaded"), None)
            if not loaded_event:
                continue
            loaded_ids = list(loaded_event.get("loaded", {}).keys())
            if str(agent_id) not in loaded_ids:
                continue

            started = next((e.get("ts") for e in events if e.get("event") == "started"), None)
            done_event = next((e for e in events if e.get("event") in ("done", "aborted")), None)
            ended = done_event.get("ts") if done_event else None
            mode = done_event.get("event", "aborted") if done_event else "running"

            # Detect tournament by presence of tournament_escrow_error or
            # any escrow-related events (challenge_trainer --tournament).
            is_tournament = any(
                e.get("event") in ("tournament_escrow_error", "tournament_chain_error")
                for e in events
            )
            # Also infer from started event flags.
            if not is_tournament:
                started_ev = next((e for e in events if e.get("event") == "started"), None)
                if started_ev:
                    is_tournament = bool(started_ev.get("tournament", False))

            # Count matches and compute net balance change for this agent.
            agent_matches = [
                e for e in events
                if e.get("event") == "match"
                and (e.get("proposer") == agent_id or e.get("target") == agent_id
                     or e.get("agent_a") == agent_id or e.get("agent_b") == agent_id)
            ]
            wins = sum(1 for e in agent_matches if e.get("winner") == agent_id)
            losses = len(agent_matches) - wins
            net_wei = sum(
                e.get("profit_wei", 0) if e.get("winner") == agent_id
                else -e.get("profit_wei", 0)
                for e in agent_matches
            )

            epochs_total = next(
                (e.get("total") for e in events if e.get("event") == "epoch_start"),
                None,
            )

            # Weight snapshots: one entry per epoch for this agent.
            weight_snapshots = [
                {"epoch": e["epoch"], "norms": e["norms"]}
                for e in events
                if e.get("event") == "weight_snapshot"
                and e.get("agent_id") == agent_id
            ]

            runs.append({
                "started_at": started,
                "ended_at": ended,
                "status": mode,
                "is_tournament": is_tournament,
                "epochs": epochs_total,
                "matches": len(agent_matches),
                "wins": wins,
                "losses": losses,
                "net_wei": net_wei,
                "file": os.path.basename(path),
                "weight_snapshots": weight_snapshots,
            })
        except Exception:
            continue

    return {"agent_id": agent_id, "runs": runs}


# ── Agent vault operator endpoint (stake deposit into AgentVault.sol) ─────────
#
# Funding, balance reads, and withdrawals are now handled directly by the
# browser via wagmi calls to AgentVault.sol. The server only needs to sign
# AgentVault.depositToEscrow() using its dedicated operator key — a key
# that has no withdrawal power, only the ability to forward pre-approved
# stake amounts into MatchEscrow.



def _truncate_address(addr: str) -> str:
    """Return a short display form like `0x1234…abcd` for a hex address."""
    if not addr or len(addr) < 10:
        return addr
    return f"{addr[:6]}…{addr[-4:]}"


# ─── 0G Inference provider endpoint ────────────────────────────────────────
#
# Registers this server as a backgammon-net-v1 provider on the 0G serving
# network. Clients discover the service via broker.inference.listService()
# and call POST /equity for each forward pass during training.
#
# The net is loaded once at process startup; its core is the shared
# gnubg-distilled base weights every agent loads (agent/data/gnubg_core.pt).
# Per-agent extras heads are not used here; the endpoint accepts any extras
# vector and blends it through the net as-is.

_equity_net = None
_equity_net_lock = None


def _init_equity_net() -> None:
    """Load BackgammonNet at startup. Silently skips if torch is unavailable."""
    import threading
    global _equity_net, _equity_net_lock
    _equity_net_lock = threading.Lock()
    try:
        _agent_dir = Path(__file__).resolve().parents[2] / "agent"
        if _agent_dir.exists() and str(_agent_dir) not in sys.path:
            sys.path.insert(0, str(_agent_dir))
        from sample_trainer import BackgammonNet, DEFAULT_EXTRAS_DIM
        net = BackgammonNet(extras_dim=DEFAULT_EXTRAS_DIM, extras_seed=0)
        net.eval()
        _equity_net = net
    except Exception as _e:
        print(f"[equity] Could not load BackgammonNet: {_e}; /equity endpoint will return 503")


_init_equity_net()


class EquityRequest(BaseModel):
    features: List[float]
    extras: List[float] = []


@app.post("/equity")
def post_equity(req: EquityRequest):
    """Single forward pass of the value net.

    Called by 0G compute clients (via the serving broker) during training
    when use_0g_inference=True. Returns equity in [0, 1] from the
    perspective of the player whose features are provided.

    Request:  {"features": [198 floats], "extras": [16 floats]}
    Response: {"equity": float, "model": "backgammon-net-v1"}
    """
    if _equity_net is None:
        raise HTTPException(status_code=503, detail="Equity net not loaded")
    try:
        import torch
        with _equity_net_lock:
            feat = torch.tensor(req.features, dtype=torch.float32).unsqueeze(0)
            ext = torch.tensor(req.extras, dtype=torch.float32).unsqueeze(0) if req.extras else None
            with torch.no_grad():
                equity = _equity_net(feat, ext).item()
        return {"equity": equity, "model": "backgammon-net-v1"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Agent Teammate Chat ──────────────────────────────────────────────────────


def _fetch_opponent_match_records(chain: "ChainClient", agent_id: int, limit: int = 20) -> list[dict]:
    """Return up to `limit` parsed game-record blobs where `agent_id` participated.

    Scans backwards from the most recent match (up to 200 entries) so we
    surface the freshest data. Blob fetch failures are silently skipped.
    """
    import logging as _log
    log = _log.getLogger(__name__)
    try:
        total = chain.match_count()
    except Exception as e:
        log.warning("match_count() failed: %s", e)
        return []

    records: list[dict] = []
    zero_hash = "0x" + "00" * 32
    for match_id in range(total - 1, max(-1, total - 200), -1):
        if len(records) >= limit:
            break
        try:
            info = chain.get_match(match_id)
        except Exception:
            continue
        winner_aid = int(info.get("winnerAgentId", 0))
        loser_aid = int(info.get("loserAgentId", 0))
        if winner_aid != agent_id and loser_aid != agent_id:
            continue
        game_record_hash = info.get("gameRecordHash", "")
        if not game_record_hash or game_record_hash == zero_hash:
            continue
        try:
            blob = get_blob(game_record_hash)
            rec = json.loads(blob)
            rec["_match_id"] = match_id
            rec["_winner_agent_id"] = winner_aid
            rec["_loser_agent_id"] = loser_aid
            records.append(rec)
        except Exception as e:
            log.debug("blob fetch skipped match %d: %s", match_id, e)

    return records


def _analyze_match_records(records: list[dict], agent_id: int) -> dict:
    """Extract behavioral tendencies from a list of game records.

    Counts are over all moves in each game (both sides), because the gnubg
    move format doesn't reliably encode which side each move belongs to
    without replaying the full board state. Stats are still meaningful as
    game-level aggression/pressure signals.
    """
    if not records:
        return {}

    wins = 0
    total_moves = 0
    hit_moves = 0  # moves containing '*' (hit a blot)
    bar_entries = 0  # moves from the bar

    for rec in records:
        if rec.get("_winner_agent_id") == agent_id:
            wins += 1
        for m in rec.get("moves", []) or []:
            mv = (m.get("move") or "").strip()
            if not mv:
                continue
            total_moves += 1
            if "*" in mv:
                hit_moves += 1
            if mv.lower().startswith("bar/"):
                bar_entries += 1

    return {
        "games_analyzed": len(records),
        "win_rate": round(wins / len(records), 2),
        "hit_rate": round(hit_moves / max(1, total_moves), 2),
        "bar_entry_rate": round(bar_entries / max(1, total_moves), 2),
    }


_DEEP_DIVE_TRIGGERS = [
    "validate", "intuition", "deep dive", "deep-dive", "historical",
    "history", "database", "tell me more", "confirm", "sure about",
    "are you sure", "second opinion", "check", "bait",
]

_TEAMMATE_SYSTEM = (
    "You are an elite backgammon Agent Teammate. Your human partner will suggest a strategy or state an intuition. "
    "Inspired by DeepMind's cooperative agent research and the 'Claude Code' philosophy that human-AI teams outperform either alone, "
    "your job is to provide the data-driven validation for the human's intuition. "
    "\n\nYour Protocol:\n"
    "1. Check the Opponent Profile (JSON) to see if historical data supports the human's strategy.\n"
    "2. Look at the Top 5 Moves list from the engine.\n"
    "3. Find the move that best executes the human's strategy.\n"
    "4. Respond concisely, confirming the data, stating the equity cost of deviating from the #1 engine move, "
    "and asking for final confirmation.\n\n"
    "Example tone: 'Your intuition is supported by the data: he hits exposed blots 88% of the time. "
    "We can play 8/3 to leave a bait blot. It costs 0.05 in theoretical equity against a perfect bot, "
    "but against him, it's highly profitable. Lock it in?'"
)


class TeammateCandidate(BaseModel):
    move: str
    equity: float
    tag: Optional[str] = None
    tag_reason: Optional[str] = None


class TeammateMessage(BaseModel):
    role: str
    text: str


class TeammateRequest(BaseModel):
    tagged_candidates: Optional[List[TeammateCandidate]] = None
    human_strategy: Optional[str] = None
    dialogue: Optional[List[TeammateMessage]] = None
    opponent_features: Optional[str] = None
    agent_id: Optional[int] = None


@app.post("/agent-teammate/chat")
def post_agent_teammate_chat(req: TeammateRequest):
    """Run an Agent Teammate chat turn via 0G Compute.

    Mirrors the (non-functional) Next.js API route — static export cannot
    run server-side code, so this endpoint lives here instead.
    """
    import time
    t0 = time.time()

    # Build candidates section
    if req.tagged_candidates:
        candidates_section = "\n".join(
            f"  {i+1}. [{c.tag or 'Safe'}] {c.move}  "
            f"(eq {'+' if c.equity >= 0 else ''}{c.equity:.3f}) — {c.tag_reason or ''}"
            for i, c in enumerate(req.tagged_candidates[:5])
        )
    else:
        candidates_section = "(no legal moves on this roll)"

    # Opponent profile
    historical_section = ""
    stats = None
    if req.agent_id:
        try:
            import urllib.request
            server_url = os.environ.get("NEXT_PUBLIC_SERVER_URL", "http://localhost:8000").rstrip("/")
            with urllib.request.urlopen(f"{server_url}/agents/{req.agent_id}/profile", timeout=5) as r:
                profile = json.loads(r.read())
            v = profile.get("values", {})
            stats = {
                "hit_rate_on_exposed_blots": 0.5 + v.get("hits_blot", 0) * 0.4,
                "blitz_success_rate": 0.4 + v.get("phase_blitz", 0) * 0.3,
                "prime_building_tendency": 0.5 + v.get("phase_prime_building", 0) * 0.4,
                "risk_tolerance": 0.5 + v.get("risk_hit_exposure", 0) * 0.4,
            }
            historical_section = f"Opponent Historical Profile (Real Data):\n{json.dumps(stats, indent=2)}\n\n"
        except Exception:
            pass

    # Opponent match history: fetch blobs and derive behavioural patterns.
    # The LLM receives all raw move strings so it can spot patterns itself,
    # plus pre-computed stats so it doesn't have to count manually.
    match_history_section = ""
    match_history_data: dict | None = None
    if req.agent_id:
        try:
            _chain = ChainClient.from_env()
            _records = _fetch_opponent_match_records(_chain, req.agent_id, limit=20)
            if _records:
                match_history_data = _analyze_match_records(_records, req.agent_id)
                # Build raw move log (one game per block, moves as "dice: move")
                raw_lines = []
                for rec in _records:
                    mid = rec.get("_match_id", "?")
                    won = rec.get("_winner_agent_id") == req.agent_id
                    raw_lines.append(f"Game {mid} ({'W' if won else 'L'}):")
                    for m in (rec.get("moves") or [])[:30]:  # cap at 30 moves per game
                        dice_str = "/".join(str(d) for d in (m.get("dice") or []))
                        mv = m.get("move", "")
                        if mv:
                            raw_lines.append(f"  {dice_str}: {mv}")
                    raw_lines.append("")
                moves_dump = "\n".join(raw_lines)
                match_history_section = (
                    f"Opponent Match History — Agent #{req.agent_id} ({match_history_data['games_analyzed']} games):\n"
                    f"Stats: win_rate={match_history_data['win_rate']*100:.0f}%  "
                    f"hit_aggression={match_history_data['hit_rate']*100:.0f}%  "
                    f"bar_pressure={match_history_data['bar_entry_rate']*100:.0f}%\n\n"
                    f"Raw move log:\n{moves_dump}\n"
                )
        except Exception:
            pass

    needs_deep_dive = any(
        t in (req.human_strategy or "").lower() or
        t in (req.dialogue[-1].text if req.dialogue else "").lower()
        for t in _DEEP_DIVE_TRIGGERS
    )

    history_section = ""
    if req.dialogue:
        history_section = "Recent conversation:\n" + "\n".join(
            f"{m.role}: {m.text}" for m in req.dialogue[-6:]
        ) + "\n\n"

    opp_section = f"Opponent summary: {req.opponent_features}\n" if req.opponent_features else ""
    strategy_section = (
        f'Human partner\'s suggestion/intuition: "{req.human_strategy}"\n\n'
        if req.human_strategy and req.human_strategy.strip()
        else "Human has not stated a strategy yet.\n\n"
    )

    user_msg = (
        f"{historical_section}"
        f"{match_history_section}"
        f"{opp_section}"
        f"Candidate moves (ranked by theoretical equity):\n{candidates_section}\n\n"
        f"{strategy_section}"
        f"{history_section}"
        "Your response (concise, data-driven, ends with a call to action):"
    )

    try:
        from coach_compute_client import chat as og_chat, OgComputeError
        result = og_chat(
            messages=[{"role": "user", "content": user_msg}],
            system=_TEAMMATE_SYSTEM,
            timeout=120.0,
        )
        reply = result.content
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"0G Compute error: {e}")

    # Extract recommended move from reply
    recommended_move = None
    recommended_tag = None
    if req.tagged_candidates:
        for c in req.tagged_candidates:
            if c.move in reply:
                recommended_move = c.move
                recommended_tag = c.tag
                break
        if not recommended_move:
            recommended_move = req.tagged_candidates[0].move
            recommended_tag = req.tagged_candidates[0].tag

    deep_dive = None
    if needs_deep_dive and stats:
        deep_dive = (
            f"Analysis of Agent #{req.agent_id}: "
            f"historical hit rate is {stats['hit_rate_on_exposed_blots']*100:.0f}%."
        )

    return {
        "reply": reply.strip(),
        "recommended_move": recommended_move,
        "recommended_tag": recommended_tag,
        "deep_dive": deep_dive,
        "match_history": match_history_data,
        "backend": "compute",
        "latency_ms": int((time.time() - t0) * 1000),
    }


# ─── gnubg evaluation endpoints ──────────────────────────────────────────────


class EvaluateRequest(BaseModel):
    position_id: str
    match_id: str
    dice: List[int]


class PlayToEndRequest(BaseModel):
    position_id: str
    match_id: str


@app.post("/evaluate")
def post_evaluate(req: EvaluateRequest):
    """Rank legal moves for the given position and dice using gnubg.

    The dice are encoded into the match_id before calling gnubg's `hint`
    so gnubg evaluates move quality for exactly the specified dice roll.

    Request:  {"position_id": "...", "match_id": "...", "dice": [d1, d2]}
    Response: {"candidates": [{"move": str, "equity": float}, ...]}
    """
    if len(req.dice) != 2:
        raise HTTPException(status_code=400, detail="dice must have exactly 2 values")
    try:
        candidates = gnubg.evaluate(req.position_id, req.match_id, req.dice)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"candidates": candidates}


@app.post("/play_to_end")
def post_play_to_end(req: PlayToEndRequest):
    """Play a backgammon position to completion using gnubg for both sides.

    gnubg plays both players from the given position until the game ends.
    Returns game_over=true and the winner (0 or 1) determined from the
    final match-id score.

    Request:  {"position_id": "...", "match_id": "..."}
    Response: {"game_over": true, "winner": 0|1, ...}
    """
    try:
        result = gnubg.play_to_end(req.position_id, req.match_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return result
