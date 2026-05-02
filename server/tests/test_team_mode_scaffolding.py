"""Tests for Phase K.1+K.2+K.6 — team scaffolding (no live advisors yet).

Run with:  cd server && uv run pytest tests/test_team_mode_scaffolding.py -v

K.1 — POST /games accepts optional team_a/team_b; stashes in _game_teams.
K.2 — captain_index alternating + fixed_first + per_turn_vote degrade.
K.6 — finalize_game (well, build_from_state) carries teams into GameRecord.

The match flow itself doesn't yet emit advisor signals (that's K.3-5);
this commit lays the foundation so K.3+ can light up.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import main as main_module  # noqa: E402
from app.game_record import (             # noqa: E402
    AdvisorSignal,
    PlayerRef,
    Team,
    build_from_state,
)
from app.team_mode import (               # noqa: E402
    captain_index,
    captain_member,
    non_captain_members,
    reset_warnings_for_tests,
)


client = TestClient(main_module.app)


# ─── K.2 captain rotation logic ───────────────────────────────────────────


def _two_member_team(rotation):
    return Team(
        members=[
            PlayerRef(kind="agent", agent_id=1),
            PlayerRef(kind="agent", agent_id=2),
        ],
        captain_rotation=rotation,
    )


def _three_member_team(rotation):
    return Team(
        members=[
            PlayerRef(kind="agent", agent_id=1),
            PlayerRef(kind="agent", agent_id=2),
            PlayerRef(kind="human", address="0x" + "11" * 20),
        ],
        captain_rotation=rotation,
    )


def test_captain_index_alternating_two_members():
    team = _two_member_team("alternating")
    assert captain_index(team, 0) == 0
    assert captain_index(team, 1) == 1
    assert captain_index(team, 2) == 0
    assert captain_index(team, 3) == 1


def test_captain_index_alternating_three_members():
    team = _three_member_team("alternating")
    assert [captain_index(team, i) for i in range(7)] == [0, 1, 2, 0, 1, 2, 0]


def test_captain_index_fixed_first_always_zero():
    team = _three_member_team("fixed_first")
    for i in range(20):
        assert captain_index(team, i) == 0


def test_captain_index_per_turn_vote_degrades_with_warning(caplog):
    reset_warnings_for_tests()
    team = _two_member_team("per_turn_vote")
    with caplog.at_level("WARNING"):
        idxs = [captain_index(team, i) for i in range(4)]
    assert idxs == [0, 1, 0, 1]  # degraded to alternating
    assert any("per_turn_vote" in r.message for r in caplog.records)


def test_per_turn_vote_warning_only_once(caplog):
    reset_warnings_for_tests()
    team = _two_member_team("per_turn_vote")
    with caplog.at_level("WARNING"):
        for i in range(10):
            captain_index(team, i)
    warnings = [r for r in caplog.records if "per_turn_vote" in r.message]
    assert len(warnings) == 1


def test_non_captain_members_preserves_roster_order():
    team = _three_member_team("alternating")
    # Move 0: cap=0, advisors are members[1], members[2] in order.
    advisors = non_captain_members(team, 0)
    assert advisors == [team.members[1], team.members[2]]
    # Move 1: cap=1, advisors are members[0], members[2] in order.
    advisors = non_captain_members(team, 1)
    assert advisors == [team.members[0], team.members[2]]


def test_captain_member_returns_correct_ref():
    team = _three_member_team("alternating")
    assert captain_member(team, 0) == team.members[0]
    assert captain_member(team, 5) == team.members[2]


def test_captain_index_unknown_rotation_raises():
    team = Team(
        members=[PlayerRef(kind="agent", agent_id=1)],
        captain_rotation="alternating",
    )
    object.__setattr__(team, "captain_rotation", "frob")  # bypass pydantic
    with pytest.raises(ValueError, match="frob"):
        captain_index(team, 0)


def test_captain_index_empty_team_raises():
    team = Team(
        members=[PlayerRef(kind="agent", agent_id=1)],
        captain_rotation="alternating",
    )
    object.__setattr__(team, "members", [])
    with pytest.raises(ValueError, match="no members"):
        captain_index(team, 0)


# ─── K.1 create_game stashes teams ─────────────────────────────────────────


@pytest.fixture(autouse=True)
def _patch_gnubg_for_create(monkeypatch):
    """Stub gnubg.new_match + decode_board so /games doesn't spawn a real
    gnubg subprocess in these tests."""
    monkeypatch.setattr(main_module.gnubg, "new_match",
                        lambda match_length: {
                            "position_id": "4HPwATDgc/ABMA",
                            "match_id": "cAkAAAAAAAAA",
                        })
    monkeypatch.setattr(main_module.gnubg, "decode_board",
                        lambda pos, mid: {"points": [0] * 24, "bar": [0, 0]})
    monkeypatch.setattr(main_module, "decode_match_id", lambda mid: {
        "turn": 0, "dice": None, "cube": 1, "cube_owner": -1,
        "match_length": 1, "score": [0, 0], "game_over": False,
    })
    # Reset team store between tests so they don't leak.
    main_module._game_teams.clear()


def test_create_game_solo_does_not_populate_game_teams():
    r = client.post("/games", json={"match_length": 3, "agent_id": 1})
    assert r.status_code == 200
    body = r.json()
    gid = body["game_id"]
    assert gid not in main_module._game_teams


def test_create_game_with_teams_populates_game_teams():
    team_a = {
        "members": [
            {"kind": "agent", "agent_id": 1},
            {"kind": "agent", "agent_id": 2},
        ],
        "captain_rotation": "alternating",
    }
    team_b = {
        "members": [
            {"kind": "agent", "agent_id": 3},
            {"kind": "agent", "agent_id": 4},
        ],
        "captain_rotation": "fixed_first",
    }
    r = client.post(
        "/games",
        json={"match_length": 3, "agent_id": 1,
              "team_a": team_a, "team_b": team_b},
    )
    assert r.status_code == 200
    gid = r.json()["game_id"]
    assert gid in main_module._game_teams
    a, b = main_module._game_teams[gid]
    assert len(a.members) == 2
    assert a.captain_rotation == "alternating"
    assert b.captain_rotation == "fixed_first"


def test_create_game_one_sided_teams_skips_population():
    """If only team_a is set (or only team_b), don't populate — team
    mode requires both rosters."""
    team_a = {
        "members": [{"kind": "agent", "agent_id": 1}],
        "captain_rotation": "alternating",
    }
    r = client.post(
        "/games",
        json={"match_length": 3, "agent_id": 1, "team_a": team_a},
    )
    assert r.status_code == 200
    gid = r.json()["game_id"]
    assert gid not in main_module._game_teams


# ─── K.6 build_from_state propagates teams ─────────────────────────────────


def test_build_from_state_omits_teams_when_solo():
    class FakeState:
        match_length = 3
        score = [3, 1]
        position_id = "p"
        match_id = "m"
    record = build_from_state(
        FakeState(),
        winner=PlayerRef(kind="agent", agent_id=1),
        loser=PlayerRef(kind="human", address="0x" + "11" * 20),
    )
    assert record.team_a is None
    assert record.team_b is None


def test_build_from_state_carries_teams_when_provided():
    team_a = Team(
        members=[PlayerRef(kind="agent", agent_id=1)],
        captain_rotation="alternating",
    )
    team_b = Team(
        members=[PlayerRef(kind="agent", agent_id=2)],
        captain_rotation="fixed_first",
    )

    class FakeState:
        match_length = 3
        score = [3, 1]
        position_id = "p"
        match_id = "m"
    record = build_from_state(
        FakeState(),
        winner=PlayerRef(kind="agent", agent_id=1),
        loser=PlayerRef(kind="agent", agent_id=2),
        team_a=team_a,
        team_b=team_b,
    )
    assert record.team_a == team_a
    assert record.team_b == team_b
    assert record.team_b.captain_rotation == "fixed_first"
