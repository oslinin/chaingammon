"""Tests for the new POST /chat endpoint on coach_service.

Run with: cd agent && uv run pytest tests/test_coach_service_chat.py -v

These tests exercise the Phase-A stub. Once Phase B replaces the stub
with a real LLM call, these tests stay green because they assert on
the response shape (and the preference-update behaviour, which lives
in coach_dialogue and is independent of the LLM backend).
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def app():
    """Import coach_service.app inside the fixture so collection works
    before the module's runtime deps (transformers etc.) are
    necessarily importable."""
    from coach_service import app as _app
    return _app


def _request_body(kind: str = "open_turn", **overrides) -> dict:
    body = {
        "kind": kind,
        "match_id": "0x" + "ab" * 32,
        "turn_index": 0,
        "position_id": "4HPwATDgc/ABMA",
        "dice": [3, 5],
        "candidates": [
            {"move": "13/8 13/10", "equity": 0.012},
            {"move": "13/8 8/3",   "equity": 0.005},
        ],
        "opponent_profile_uri": "",
        "agent_weights_hash": "",
        "dialogue": [],
        "preferences": {},
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# Open turn
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_open_turn_returns_agent_message(app):
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body())
    assert resp.status_code == 200
    body = resp.json()
    assert body["message"]["role"] == "agent"
    assert body["message"]["turn_index"] == 0
    assert body["message"]["text"]
    assert body["backend"] == "stub"
    assert body["latency_ms"] >= 0


@pytest.mark.anyio
async def test_open_turn_with_no_candidates_handles_pass(app):
    """Bar dance / no-legal-move position: the response must still
    succeed — frontend renders the 'turn passes' message."""
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(candidates=[]))
    assert resp.status_code == 200
    assert "pass" in resp.json()["message"]["text"].lower()


# ---------------------------------------------------------------------------
# Human reply
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_human_reply_echoes_human_text(app):
    """Phase-A stub echoes the human's last message; this confirms
    the dialogue is being read back correctly."""
    history = [
        {"role": "agent", "text": "I'd lean 13/8 8/3.",
         "turn_index": 0, "timestamp": "2026-05-01T12:00:00Z"},
        {"role": "human", "text": "but doesn't 8/3 leave a blot?",
         "turn_index": 0, "timestamp": "2026-05-01T12:00:05Z"},
    ]
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(
            kind="human_reply", dialogue=history,
        ))
    assert resp.status_code == 200
    body = resp.json()
    assert "8/3 leave a blot" in body["message"]["text"]


# ---------------------------------------------------------------------------
# Move committed
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_move_committed_acknowledges_chosen_move(app):
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(
            kind="move_committed", move_committed="13/8 13/10",
        ))
    assert resp.status_code == 200
    body = resp.json()
    assert "13/8 13/10" in body["message"]["text"]


# ---------------------------------------------------------------------------
# Preference update
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_human_keyword_updates_preferences(app):
    """A human message containing 'running game' should nudge
    prefers_running and surface in preferences_delta."""
    history = [
        {"role": "human", "text": "I want to play this as a running game",
         "turn_index": 0, "timestamp": "2026-05-01T12:00:00Z"},
    ]
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(
            kind="human_reply", dialogue=history,
        ))
    body = resp.json()
    assert "prefers_running" in body["preferences_delta"]
    assert body["preferences_delta"]["prefers_running"] > 0


@pytest.mark.anyio
async def test_no_human_message_means_no_preferences_delta(app):
    """If the dialogue contains only an agent message, nothing should
    move."""
    history = [
        {"role": "agent", "text": "your turn",
         "turn_index": 0, "timestamp": "2026-05-01T12:00:00Z"},
    ]
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(
            kind="human_reply", dialogue=history,
        ))
    assert resp.json()["preferences_delta"] == {}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_unknown_kind_returns_422(app):
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(kind="random_chat"))
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_negative_turn_index_returns_422(app):
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(turn_index=-1))
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Team-mode kinds — see docs/team-mode.md
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_teammate_propose_returns_proposal_text(app):
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(kind="teammate_propose"))
    assert resp.status_code == 200
    body = resp.json()
    text = body["message"]["text"]
    assert "I propose" in text
    assert "Confidence" in text
    # Top candidate's move should be in the proposal text.
    assert "13/8 13/10" in text


@pytest.mark.anyio
async def test_teammate_propose_with_no_candidates_handles_pass(app):
    """No legal moves: the advisor has nothing to propose. The endpoint
    must still 200 — frontend renders a 'no proposal' state."""
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(
            kind="teammate_propose", candidates=[],
        ))
    assert resp.status_code == 200
    assert "nothing to propose" in resp.json()["message"]["text"].lower()


@pytest.mark.anyio
async def test_teammate_advise_addresses_last_human_message(app):
    history = [
        {"role": "agent", "text": "I propose 13/8 8/3. Confidence: 0.70.",
         "turn_index": 0, "timestamp": "2026-05-01T12:00:00Z"},
        {"role": "human", "text": "but doesn't 8/3 leave a blot?",
         "turn_index": 0, "timestamp": "2026-05-01T12:00:05Z"},
    ]
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(
            kind="teammate_advise", dialogue=history,
        ))
    assert resp.status_code == 200
    text = resp.json()["message"]["text"]
    assert "8/3 leave a blot" in text


@pytest.mark.anyio
async def test_captain_decide_acknowledges_with_advisor_credit(app):
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(
            kind="captain_decide",
            move_committed="13/8 13/10",
            chosen_advisor_id="agent:7",
        ))
    assert resp.status_code == 200
    text = resp.json()["message"]["text"]
    assert "13/8 13/10" in text
    assert "agent:7" in text


@pytest.mark.anyio
async def test_captain_decide_acknowledges_without_advisor_credit(app):
    async with AsyncClient(transport=ASGITransport(app=app),
                            base_url="http://test") as c:
        resp = await c.post("/chat", json=_request_body(
            kind="captain_decide",
            move_committed="13/8 13/10",
        ))
    assert resp.status_code == 200
    text = resp.json()["message"]["text"]
    assert "13/8 13/10" in text
    # No advisor was credited — the reply should NOT name one.
    assert "following" not in text.lower()


@pytest.mark.anyio
async def test_team_mode_kinds_round_trip_chosen_advisor_id_field(app):
    """The chosen_advisor_id field must round-trip through the request
    parser without 422'ing on the other team-mode kinds either, even
    though only captain_decide reads it."""
    for kind in ("teammate_propose", "teammate_advise"):
        async with AsyncClient(transport=ASGITransport(app=app),
                                base_url="http://test") as c:
            resp = await c.post("/chat", json=_request_body(
                kind=kind, chosen_advisor_id="agent:3",
            ))
        assert resp.status_code == 200, f"{kind} should accept chosen_advisor_id"
