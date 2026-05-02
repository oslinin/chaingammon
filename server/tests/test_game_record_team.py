"""Tests for the team-mode GameRecord extensions.

The new `AdvisorSignal`, `Team`, `MoveEntry.advisor_signals`,
`GameRecord.team_a` / `team_b` types support the doubles / chouette /
human+agent flow described in `docs/team-mode.md`.

This file pins:
  - AdvisorSignal accepts a normal proposal, rejects out-of-range
    confidence and empty proposed_move
  - Team accepts a 1+ roster, rejects empty members, accepts each
    captain_rotation enum value, rejects unknown rotations
  - MoveEntry.advisor_signals round-trips and defaults to None
  - GameRecord.team_a / team_b round-trip and default to None
  - serialize_record omits all four new fields when None — the
    byte-stable invariant that lets existing 0G Storage records
    keep their Merkle roots after the schema change
  - serialize_record emits the new fields when populated
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Make `app` importable when running pytest from server/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app.game_record import (  # noqa: E402
    AdvisorSignal,
    GameRecord,
    MoveEntry,
    PlayerRef,
    Team,
    serialize_record,
)


# ---------------------------------------------------------------------------
# AdvisorSignal shape
# ---------------------------------------------------------------------------


def test_advisor_signal_accepts_normal_proposal():
    sig = AdvisorSignal(
        teammate_id="agent:42",
        proposed_move="13/8 13/10",
        confidence=0.7,
        message="safer line; keeps a builder",
    )
    assert sig.teammate_id == "agent:42"
    assert sig.proposed_move == "13/8 13/10"
    assert sig.confidence == 0.7
    assert sig.message == "safer line; keeps a builder"


def test_advisor_signal_message_optional():
    sig = AdvisorSignal(
        teammate_id="0xabc",
        proposed_move="8/5 6/5",
        confidence=1.0,
    )
    assert sig.message is None


def test_advisor_signal_rejects_confidence_out_of_range():
    with pytest.raises(ValidationError):
        AdvisorSignal(teammate_id="agent:1", proposed_move="8/5", confidence=1.1)
    with pytest.raises(ValidationError):
        AdvisorSignal(teammate_id="agent:1", proposed_move="8/5", confidence=-0.01)


def test_advisor_signal_rejects_empty_proposed_move():
    with pytest.raises(ValidationError):
        AdvisorSignal(teammate_id="agent:1", proposed_move="", confidence=0.5)


def test_advisor_signal_rejects_empty_teammate_id():
    with pytest.raises(ValidationError):
        AdvisorSignal(teammate_id="", proposed_move="8/5", confidence=0.5)


# ---------------------------------------------------------------------------
# Team shape
# ---------------------------------------------------------------------------


def test_team_accepts_solo_roster():
    """A team-of-one is valid — covers human+agent (the human is one
    team, the agent is the other)."""
    team = Team(members=[PlayerRef(kind="human", address="0xabc")])
    assert len(team.members) == 1
    assert team.captain_rotation == "alternating"  # default


def test_team_accepts_doubles_roster():
    team = Team(members=[
        PlayerRef(kind="human", address="0xabc"),
        PlayerRef(kind="agent", agent_id=42),
    ])
    assert len(team.members) == 2


def test_team_rejects_empty_roster():
    with pytest.raises(ValidationError):
        Team(members=[])


def test_team_accepts_each_rotation_enum_value():
    for rot in ("alternating", "per_turn_vote", "fixed_first"):
        team = Team(
            members=[PlayerRef(kind="agent", agent_id=1)],
            captain_rotation=rot,
        )
        assert team.captain_rotation == rot


def test_team_rejects_unknown_rotation():
    with pytest.raises(ValidationError):
        Team(
            members=[PlayerRef(kind="agent", agent_id=1)],
            captain_rotation="random",  # not in enum
        )


# ---------------------------------------------------------------------------
# MoveEntry.advisor_signals
# ---------------------------------------------------------------------------


def test_move_entry_default_advisor_signals_is_none():
    m = MoveEntry(turn=0, dice=[3, 5], move="13/8 13/10")
    assert m.advisor_signals is None


def test_move_entry_round_trips_advisor_signals():
    sig = AdvisorSignal(
        teammate_id="agent:1", proposed_move="8/5 6/5", confidence=0.6,
    )
    m = MoveEntry(turn=0, dice=[3, 5], move="8/5 6/5", advisor_signals=[sig])
    assert m.advisor_signals == [sig]


# ---------------------------------------------------------------------------
# GameRecord.team_a / team_b
# ---------------------------------------------------------------------------


def _solo_record(**overrides) -> GameRecord:
    """Minimal solo (non-team) GameRecord factory."""
    base = dict(
        match_length=1,
        final_score=[1, 0],
        winner=PlayerRef(kind="agent", agent_id=1),
        loser=PlayerRef(kind="agent", agent_id=2),
        final_position_id="POS",
        final_match_id="MAT",
    )
    base.update(overrides)
    return GameRecord(**base)


def test_game_record_default_team_fields_are_none():
    rec = _solo_record()
    assert rec.team_a is None
    assert rec.team_b is None


def test_game_record_round_trips_team_rosters():
    team_a = Team(members=[
        PlayerRef(kind="human", address="0xa"),
        PlayerRef(kind="agent", agent_id=1),
    ])
    team_b = Team(members=[
        PlayerRef(kind="human", address="0xb"),
        PlayerRef(kind="agent", agent_id=2),
    ], captain_rotation="fixed_first")
    rec = _solo_record(team_a=team_a, team_b=team_b)
    assert rec.team_a == team_a
    assert rec.team_b == team_b


# ---------------------------------------------------------------------------
# serialize_record byte-stability
# ---------------------------------------------------------------------------


def test_serialize_omits_team_fields_when_none():
    """Solo records must serialize to bytes that DON'T mention any of
    the new team-mode fields. This is the invariant that lets existing
    0G Storage records keep their Merkle roots after the schema change."""
    rec = _solo_record(moves=[
        MoveEntry(turn=0, dice=[3, 5], move="13/8 13/10"),
    ])
    blob = serialize_record(rec)
    parsed = json.loads(blob.decode("utf-8"))

    assert "team_a" not in parsed
    assert "team_b" not in parsed
    # And the optional advisor_signals on the move is also omitted.
    assert "advisor_signals" not in parsed["moves"][0]


def test_serialize_emits_team_fields_when_populated():
    sig = AdvisorSignal(
        teammate_id="agent:1", proposed_move="8/5 6/5", confidence=0.6,
        message="play it safe",
    )
    team_a = Team(members=[
        PlayerRef(kind="human", address="0xa"),
        PlayerRef(kind="agent", agent_id=1),
    ])
    team_b = Team(members=[PlayerRef(kind="agent", agent_id=2)])
    rec = _solo_record(
        team_a=team_a, team_b=team_b,
        moves=[MoveEntry(turn=0, dice=[3, 5], move="8/5 6/5",
                         advisor_signals=[sig])],
    )
    blob = serialize_record(rec)
    parsed = json.loads(blob.decode("utf-8"))

    assert parsed["team_a"]["members"][0]["address"] == "0xa"
    assert parsed["team_a"]["captain_rotation"] == "alternating"
    assert parsed["team_b"]["members"][0]["agent_id"] == 2
    assert parsed["moves"][0]["advisor_signals"][0]["teammate_id"] == "agent:1"
    assert parsed["moves"][0]["advisor_signals"][0]["confidence"] == 0.6
    assert parsed["moves"][0]["advisor_signals"][0]["message"] == "play it safe"


def test_serialize_round_trips_via_model_validate_json():
    """An emitted record must parse back into an equal GameRecord."""
    team_a = Team(members=[PlayerRef(kind="agent", agent_id=1)],
                  captain_rotation="per_turn_vote")
    rec = _solo_record(team_a=team_a)
    blob = serialize_record(rec)
    reloaded = GameRecord.model_validate_json(blob)
    assert reloaded == rec
