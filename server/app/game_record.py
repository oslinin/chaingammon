"""
Game record envelope — what we upload to 0G Storage Log after each match.

The `gameRecordHash` field on the on-chain MatchRegistry struct is the
keccak/Merkle root of the bytes we produce here, so this envelope is the
canonical archive of a Chaingammon match: any third-party tool can read
it (no decryption), reconstruct the play, and analyse style.

Phase 9 (agent experience overlay) consumes these records to compute the
per-agent overlay updates.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class PlayerRef(BaseModel):
    """One side of the match. Exactly one of address / agent_id is set."""

    kind: Literal["human", "agent"]
    address: Optional[str] = None  # 0x… for humans
    agent_id: Optional[int] = None  # ERC-7857 token id for agents


class MoveEntry(BaseModel):
    """One move in the play sequence."""

    turn: int = Field(description="0 = player 0, 1 = player 1 (gnubg's turn convention)")
    dice: list[int]
    move: str = Field(description="gnubg-format move string, e.g. '8/5 6/5'")
    position_id_after: Optional[str] = None
    # Optional drand round number that produced `dice`. Set when the
    # match runs through KeeperHub's drand-derived dice path; left
    # unset for legacy / standalone-demo records that used a local
    # PRNG. With this field, an audit replayer can re-fetch the same
    # drand round and re-derive the same dice via
    # `agent.drand_dice.derive_dice(round_digest, turn_index)`.
    drand_round: Optional[int] = None


class SeriesEnvelope(BaseModel):
    """Optional envelope identifying a single match as part of a
    multi-match series (best-of-N, tournament round, etc.).

    `series_id` is the off-chain identifier that ties the matches
    together (typically `keccak256(participantsA || participantsB ||
    nonce)`); `series_index` is this match's position in the series
    (0-based); `series_total` is the total number of matches in the
    series. All three fields are required when the envelope is
    present, so that any downstream tool can validate completeness.
    """

    series_id: str = Field(description="Off-chain identifier shared across all matches in the series")
    series_index: int = Field(ge=0, description="0-based position of this match within the series")
    series_total: int = Field(ge=1, description="Total number of matches in the series")


class CubeAction(BaseModel):
    """A doubling-cube event."""

    turn: int
    action: Literal["offer", "take", "drop", "beaver", "raccoon"]
    cube_value_after: int


class GameRecord(BaseModel):
    """Full per-match archive. JSON-encoded and uploaded to 0G Storage."""

    envelope_version: int = 1
    match_length: int = Field(description="Match-point target (e.g. 1 for a one-pointer)")
    final_score: list[int]
    winner: PlayerRef
    loser: PlayerRef

    # gnubg's native state at game end. Lets any tool with gnubg installed
    # reconstruct the final position bit-perfectly without trusting our parse.
    final_position_id: str
    final_match_id: str

    # Ordered play history. May be empty in v1 if move history wasn't tracked.
    moves: list[MoveEntry] = []
    cube_actions: list[CubeAction] = []

    started_at: Optional[str] = None  # ISO-8601 UTC
    ended_at: Optional[str] = None
    notes: Optional[str] = None

    # Optional series membership. Populated when this match is one of
    # several played as a unit (best-of-N, tournament round). Left as
    # None for solo / one-off matches.
    series: Optional[SeriesEnvelope] = None

    # Reserved for v2: a literal `.mat` text export from gnubg's
    # `export match` command. Left as None for v1.
    mat_format: Optional[str] = None


def serialize_record(record: GameRecord) -> bytes:
    """JSON-encode a GameRecord to canonical bytes for 0G Storage upload.

    Sorted keys + UTF-8 so the same record always serializes to the same
    bytes (and therefore the same Merkle root on 0G Storage).
    """
    return record.model_dump_json(exclude_none=True).encode("utf-8")


def build_from_state(
    state: Any,
    *,
    winner: PlayerRef,
    loser: PlayerRef,
    moves: Optional[list[MoveEntry]] = None,
    cube_actions: Optional[list[CubeAction]] = None,
    started_at: Optional[str] = None,
    ended_at: Optional[str] = None,
) -> GameRecord:
    """Build a GameRecord from a final-state GameState plus the participants.

    `state` is duck-typed against `app.game_state.GameState` so this module
    doesn't pull pydantic-cycle imports during testing.
    """
    return GameRecord(
        match_length=int(state.match_length),
        final_score=list(state.score),
        winner=winner,
        loser=loser,
        final_position_id=state.position_id,
        final_match_id=state.match_id,
        moves=moves or [],
        cube_actions=cube_actions or [],
        started_at=started_at,
        ended_at=ended_at,
    )
