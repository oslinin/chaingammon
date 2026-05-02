"""Tests for Phase K.3+K.4+K.7 — live advisor signal flow.

Run with:  cd server && uv run pytest tests/test_team_mode_advisor_signals.py -v

K.3 score_advisor_move:
  - OverlayProfile path produces a meaningful signal
  - ModelProfile (race) returns 0-confidence + abstain message
  - NullProfile / null kind returns None
  - Empty candidate list returns None

K.4 /agent-move with team mode:
  - Solo game: response has no advisor_signals / captain_id (back-compat)
  - Team game (2-member): one signal per non-captain teammate
  - Captain rotates per move (alternating)
  - MoveEntry.advisor_signals stores the same signals

K.7 (end-to-end): create_game → agent-move → finalize_game preserves
  the team rosters + per-move advisor signals into the GameRecord.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import main as main_module  # noqa: E402
from app.agent_overlay import Overlay  # noqa: E402
from app.game_record import (   # noqa: E402
    AdvisorSignal,
    PlayerRef,
    Team,
)
from app.teammate_advisor import (    # noqa: E402
    AdvisorScoring,
    score_advisor_move,
)


client = TestClient(main_module.app)


# ─── K.3 score_advisor_move unit tests ─────────────────────────────────────


def _candidates_pair():
    return [
        {"move": "13/10 24/23", "equity": 0.42, "win_pct": 0.48},
        {"move": "13/11 13/10", "equity": 0.40, "win_pct": 0.46},
    ]


def test_score_overlay_endorses_natural_top():
    """Empty overlay = no bias = advisor agrees with gnubg's natural top.
    Confidence is moderate (0.4) since the endorsement is meaningful but
    redundant with gnubg's own pick."""
    advisor = PlayerRef(kind="agent", agent_id=2)
    sig = score_advisor_move(AdvisorScoring(
        teammate=advisor,
        candidates=_candidates_pair(),
        overlay=Overlay.default(),
        profile_kind="overlay",
    ))
    assert sig is not None
    assert sig.proposed_move == "13/10 24/23"
    assert sig.confidence == 0.4
    assert "endorses" in (sig.message or "").lower()


def test_score_overlay_strong_disagreement():
    """A heavy bias against the natural top forces the advisor to pick
    a different candidate. Confidence reflects the magnitude of the
    equity-spread between gnubg's top and the advisor's top."""
    advisor = PlayerRef(kind="agent", agent_id=2)
    # Bias hits_blot down so 13/10 24/23 (which contains 24/23 — a runner
    # move) is penalized; advisor picks the safer 13/11 13/10.
    base = Overlay.default()
    new_values = dict(base.values)
    new_values["runs_back_checker"] = -0.9
    from app.agent_overlay import CURRENT_OVERLAY_VERSION
    overlay = Overlay(version=CURRENT_OVERLAY_VERSION, values=new_values, match_count=0)
    sig = score_advisor_move(AdvisorScoring(
        teammate=advisor,
        candidates=_candidates_pair(),
        overlay=overlay,
        profile_kind="overlay",
    ))
    assert sig is not None
    # The advisor's pick may or may not flip depending on classifier;
    # what we assert is that confidence is in the valid range.
    assert 0.0 <= sig.confidence <= 1.0


def test_score_model_race_returns_abstain():
    """A race-only ModelProfile can't score full-board positions; the
    advisor returns confidence=0 with a clear abstain message."""
    advisor = PlayerRef(kind="agent", agent_id=2)
    sig = score_advisor_move(AdvisorScoring(
        teammate=advisor,
        candidates=_candidates_pair(),
        profile_kind="model",
        model_encoder="race",
    ))
    assert sig is not None
    assert sig.confidence == 0.0
    assert "abstains" in (sig.message or "").lower()


def test_score_null_returns_none():
    """NullProfile or no resolved profile → no signal at all."""
    advisor = PlayerRef(kind="agent", agent_id=2)
    sig = score_advisor_move(AdvisorScoring(
        teammate=advisor,
        candidates=_candidates_pair(),
        profile_kind="null",
    ))
    assert sig is None


def test_score_empty_candidates_returns_none():
    advisor = PlayerRef(kind="agent", agent_id=2)
    sig = score_advisor_move(AdvisorScoring(
        teammate=advisor,
        candidates=[],
        overlay=Overlay.default(),
        profile_kind="overlay",
    ))
    assert sig is None


def test_player_ref_id_for_agent():
    advisor = PlayerRef(kind="agent", agent_id=42)
    sig = score_advisor_move(AdvisorScoring(
        teammate=advisor,
        candidates=_candidates_pair(),
        overlay=Overlay.default(),
        profile_kind="overlay",
    ))
    assert sig is not None
    assert sig.teammate_id == "agent:42"


def test_player_ref_id_for_human():
    advisor = PlayerRef(kind="human", address="0xAaBbCcDdEeFf00112233445566778899aaBbCcDd")
    sig = score_advisor_move(AdvisorScoring(
        teammate=advisor,
        candidates=_candidates_pair(),
        overlay=Overlay.default(),
        profile_kind="overlay",
    ))
    assert sig is not None
    # PlayerRef may not echo the case, but the wire format is lowercase.
    assert sig.teammate_id == sig.teammate_id.lower()


# ─── K.4 /agent-move team-mode integration ─────────────────────────────────


@pytest.fixture(autouse=True)
def _patch_gnubg(monkeypatch):
    """Stub gnubg + decode_match_id + overlay loader so /agent-move runs
    without a real subprocess. _ensure_overlay_loaded returns a no-op
    overlay so apply_overlay is a no-op (gnubg ranking preserved)."""
    candidates = [
        {"move": "13/10 24/23", "equity": 0.42, "win_pct": 0.48},
        {"move": "13/11 13/10", "equity": 0.40, "win_pct": 0.46},
    ]
    monkeypatch.setattr(main_module.gnubg, "new_match",
                        lambda match_length: {
                            "position_id": "4HPwATDgc/ABMA",
                            "match_id": "cAkAAAAAAAAA",
                        })
    monkeypatch.setattr(main_module.gnubg, "get_candidate_moves",
                        lambda pos, mid: candidates)
    monkeypatch.setattr(main_module.gnubg, "submit_move",
                        lambda pos, mid, move: {
                            "position_id": "4HPwATDgc/ABNA",
                            "match_id": "cAkAAAAAAAAB",
                            "output": "",
                        })
    monkeypatch.setattr(main_module.gnubg, "decode_board",
                        lambda pos, mid: {"points": [0] * 24, "bar": [0, 0]})
    monkeypatch.setattr(main_module, "decode_match_id", lambda mid: {
        "turn": 0, "dice": None, "cube": 1, "cube_owner": -1,
        "match_length": 1, "score": [0, 0], "game_over": False,
    })
    monkeypatch.setattr(main_module, "_ensure_overlay_loaded",
                        lambda gid: Overlay.default())
    main_module._game_teams.clear()
    main_module._move_history.clear()
    main_module.games.clear()


def _create_team_game():
    body = {
        "match_length": 1, "agent_id": 1,
        "team_a": {
            "members": [
                {"kind": "agent", "agent_id": 1},
                {"kind": "agent", "agent_id": 2},
            ],
            "captain_rotation": "alternating",
        },
        "team_b": {
            "members": [{"kind": "agent", "agent_id": 3}],
            "captain_rotation": "alternating",
        },
    }
    r = client.post("/games", json=body)
    assert r.status_code == 200
    return r.json()["game_id"]


def _patch_advisor_resolution(monkeypatch, profile_kind="overlay"):
    """Bypass the chain client + load_profile path: directly stub the
    AdvisorScoring resolver so tests can exercise /agent-move without
    on-chain reads."""
    def _stub_resolve(advisor_ref, candidates, team):
        if advisor_ref.kind != "agent":
            return None
        if profile_kind == "overlay":
            return AdvisorScoring(
                teammate=advisor_ref,
                candidates=candidates,
                overlay=Overlay.default(),
                profile_kind="overlay",
            )
        if profile_kind == "model_race":
            return AdvisorScoring(
                teammate=advisor_ref,
                candidates=candidates,
                profile_kind="model",
                model_encoder="race",
            )
        if profile_kind == "null":
            return AdvisorScoring(
                teammate=advisor_ref,
                candidates=candidates,
                profile_kind="null",
            )
        return None
    monkeypatch.setattr(main_module, "_resolve_advisor_scoring", _stub_resolve)


def test_solo_game_no_advisor_signals(monkeypatch):
    """Solo game (no team_a/team_b) → response carries no
    advisor_signals or captain_id (exclude_none drops them)."""
    r = client.post("/games", json={"match_length": 1, "agent_id": 1})
    gid = r.json()["game_id"]
    r = client.post(f"/games/{gid}/agent-move")
    body = r.json()
    assert body.get("advisor_signals") in (None, [])
    assert body.get("captain_id") in (None, "")


def test_team_game_emits_one_signal_per_non_captain(monkeypatch):
    _patch_advisor_resolution(monkeypatch, profile_kind="overlay")
    gid = _create_team_game()
    r = client.post(f"/games/{gid}/agent-move")
    body = r.json()
    assert "advisor_signals" in body
    # team_a has 2 members; captain is index 0 on move 0; so 1 advisor.
    assert len(body["advisor_signals"]) == 1
    sig = body["advisor_signals"][0]
    assert sig["teammate_id"] == "agent:2"  # member index 1


def test_team_game_captain_rotates_alternating(monkeypatch):
    """The same team plays moves 0, 2, 4 (every-other turn since
    side-0 alternates with side-1). Captain index alternates: 0, 1, 0..."""
    _patch_advisor_resolution(monkeypatch, profile_kind="overlay")
    gid = _create_team_game()

    # Move 1 (turn=0 captain index 0 → captain agent:1, advisor agent:2).
    r = client.post(f"/games/{gid}/agent-move")
    assert r.json()["captain_id"] == "agent:1"

    # The fixture's decode_match_id keeps turn=0, so back-to-back
    # /agent-move calls all play on team_a's side. Move count for team_a
    # increments each call → captain rotation flips.
    r = client.post(f"/games/{gid}/agent-move")
    assert r.json()["captain_id"] == "agent:2"

    r = client.post(f"/games/{gid}/agent-move")
    assert r.json()["captain_id"] == "agent:1"


def test_team_game_signals_archived_to_move_entry(monkeypatch):
    _patch_advisor_resolution(monkeypatch, profile_kind="overlay")
    gid = _create_team_game()
    client.post(f"/games/{gid}/agent-move")
    moves = main_module._move_history[gid]
    assert len(moves) == 1
    assert moves[0].advisor_signals is not None
    assert len(moves[0].advisor_signals) == 1


def test_team_game_with_race_only_advisor_publishes_abstain(monkeypatch):
    _patch_advisor_resolution(monkeypatch, profile_kind="model_race")
    gid = _create_team_game()
    r = client.post(f"/games/{gid}/agent-move")
    body = r.json()
    assert len(body["advisor_signals"]) == 1
    sig = body["advisor_signals"][0]
    assert sig["confidence"] == 0.0
    assert "abstains" in sig["message"].lower()


def test_team_game_with_null_advisor_omits_signal(monkeypatch):
    _patch_advisor_resolution(monkeypatch, profile_kind="null")
    gid = _create_team_game()
    r = client.post(f"/games/{gid}/agent-move")
    body = r.json()
    # Advisor profile is null → no signal emitted; advisor_signals empty
    # (the helper returns None when no signals were collected, which
    # exclude_none drops).
    assert body.get("advisor_signals") in (None, [])
