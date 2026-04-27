"""
Phase 7 unit tests for the GameRecord schema and serializer.

These are fast, no-network tests that pin down the canonical archive
format. Whatever bytes `serialize_record` produces become the Merkle
root on 0G Storage and the `gameRecordHash` on-chain — so any drift
in the schema or serialization is a content-addressing break.

The live round-trip integration test lives in
`test_phase7_game_record.py`.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

# Make `app` importable when running pytest from server/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from pydantic import ValidationError

from app.game_record import (  # noqa: E402
    CubeAction,
    GameRecord,
    MoveEntry,
    PlayerRef,
    build_from_state,
    serialize_record,
)


# Hardhat's well-known default test account #0. The schema tests don't touch
# any network — this string is just a 0x-prefixed value that lands in a
# GameRecord field. Using a recognizable fake address makes the intent clear.
HUMAN_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"


# --- PlayerRef ---------------------------------------------------------------


def test_player_ref_human_ok():
    p = PlayerRef(kind="human", address=HUMAN_ADDR)
    assert p.kind == "human"
    assert p.address == HUMAN_ADDR
    assert p.agent_id is None


def test_player_ref_agent_ok():
    p = PlayerRef(kind="agent", agent_id=42)
    assert p.kind == "agent"
    assert p.agent_id == 42
    assert p.address is None


def test_player_ref_rejects_unknown_kind():
    with pytest.raises(ValidationError):
        PlayerRef(kind="alien", address=HUMAN_ADDR)  # type: ignore[arg-type]


# --- GameRecord round-trip ---------------------------------------------------


def _example_record() -> GameRecord:
    return GameRecord(
        match_length=1,
        final_score=[1, 0],
        winner=PlayerRef(kind="human", address=HUMAN_ADDR),
        loser=PlayerRef(kind="agent", agent_id=1),
        final_position_id="4HPwATDgc/ABMA",
        final_match_id="cAkAAAAAAAAA",
        moves=[
            MoveEntry(turn=0, dice=[3, 1], move="8/5 6/5"),
            MoveEntry(turn=1, dice=[4, 2], move="24/22 13/9", position_id_after="abc"),
        ],
        cube_actions=[
            CubeAction(turn=0, action="offer", cube_value_after=2),
            CubeAction(turn=1, action="take", cube_value_after=2),
        ],
        started_at="2026-04-27T01:00:00+00:00",
        ended_at="2026-04-27T01:05:00+00:00",
        notes="schema-test",
    )


def test_serialize_round_trips_through_json():
    rec = _example_record()
    payload = serialize_record(rec)
    parsed = json.loads(payload.decode("utf-8"))
    rebuilt = GameRecord.model_validate(parsed)
    assert rebuilt == rec


def test_serialize_is_deterministic():
    """Same record → same bytes. Required: the hash is content-addressed,
    so non-determinism would make the same logical match produce different
    Merkle roots on 0G Storage and diverge from the on-chain hash."""
    rec = _example_record()
    a = serialize_record(rec)
    b = serialize_record(rec)
    assert a == b


def test_serialize_produces_valid_utf8_json():
    rec = _example_record()
    payload = serialize_record(rec)
    # Must decode as UTF-8 and parse as JSON.
    text = payload.decode("utf-8")
    json.loads(text)


def test_serialize_omits_none_fields():
    """Optional fields that aren't set should not appear in the JSON
    so the canonical form stays minimal and stable."""
    rec = GameRecord(
        match_length=1,
        final_score=[1, 0],
        winner=PlayerRef(kind="human", address=HUMAN_ADDR),
        loser=PlayerRef(kind="agent", agent_id=1),
        final_position_id="x",
        final_match_id="y",
    )
    payload = serialize_record(rec)
    text = payload.decode("utf-8")
    assert "started_at" not in text
    assert "ended_at" not in text
    assert "notes" not in text
    assert "mat_format" not in text


# --- field preservation ------------------------------------------------------


def test_envelope_version_defaults_to_1():
    rec = _example_record()
    assert rec.envelope_version == 1


def test_final_score_round_trips():
    rec = _example_record()
    parsed = json.loads(serialize_record(rec))
    assert parsed["final_score"] == [1, 0]


def test_moves_round_trip():
    rec = _example_record()
    parsed = json.loads(serialize_record(rec))
    assert len(parsed["moves"]) == 2
    assert parsed["moves"][0]["turn"] == 0
    assert parsed["moves"][0]["dice"] == [3, 1]
    assert parsed["moves"][0]["move"] == "8/5 6/5"
    assert parsed["moves"][1]["position_id_after"] == "abc"


def test_cube_actions_round_trip():
    rec = _example_record()
    parsed = json.loads(serialize_record(rec))
    assert len(parsed["cube_actions"]) == 2
    assert parsed["cube_actions"][0]["action"] == "offer"
    assert parsed["cube_actions"][0]["cube_value_after"] == 2


def test_final_position_and_match_id_preserved():
    rec = _example_record()
    parsed = json.loads(serialize_record(rec))
    assert parsed["final_position_id"] == "4HPwATDgc/ABMA"
    assert parsed["final_match_id"] == "cAkAAAAAAAAA"


def test_player_kinds_serialized_as_strings():
    rec = _example_record()
    parsed = json.loads(serialize_record(rec))
    assert parsed["winner"]["kind"] == "human"
    assert parsed["winner"]["address"] == HUMAN_ADDR
    assert parsed["loser"]["kind"] == "agent"
    assert parsed["loser"]["agent_id"] == 1


# --- build_from_state --------------------------------------------------------


@dataclass
class _FakeState:
    """Minimal duck-typed stand-in for GameState (which depends on gnubg
    and isn't worth importing for a serialization test)."""

    match_length: int
    score: list
    position_id: str
    match_id: str


def test_build_from_state_maps_required_fields():
    state = _FakeState(
        match_length=3,
        score=[2, 1],
        position_id="POSID",
        match_id="MATCHID",
    )
    rec = build_from_state(
        state,
        winner=PlayerRef(kind="human", address=HUMAN_ADDR),
        loser=PlayerRef(kind="agent", agent_id=7),
        started_at="2026-01-01T00:00:00+00:00",
        ended_at="2026-01-01T00:10:00+00:00",
    )
    assert rec.match_length == 3
    assert rec.final_score == [2, 1]
    assert rec.final_position_id == "POSID"
    assert rec.final_match_id == "MATCHID"
    assert rec.winner.address == HUMAN_ADDR
    assert rec.loser.agent_id == 7
    assert rec.started_at == "2026-01-01T00:00:00+00:00"
    assert rec.ended_at == "2026-01-01T00:10:00+00:00"
    # Defaults:
    assert rec.moves == []
    assert rec.cube_actions == []
    assert rec.envelope_version == 1


def test_build_from_state_passes_through_moves_and_cube_actions():
    state = _FakeState(match_length=1, score=[1, 0], position_id="p", match_id="m")
    moves = [MoveEntry(turn=0, dice=[6, 6], move="13/7 13/7 24/18 24/18")]
    cube = [CubeAction(turn=0, action="offer", cube_value_after=2)]
    rec = build_from_state(
        state,
        winner=PlayerRef(kind="agent", agent_id=1),
        loser=PlayerRef(kind="human", address=HUMAN_ADDR),
        moves=moves,
        cube_actions=cube,
    )
    assert rec.moves == moves
    assert rec.cube_actions == cube
