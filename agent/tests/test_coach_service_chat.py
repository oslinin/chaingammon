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
        # Phase B wired the real LLM path. These tests exercise the
        # deterministic stub handler — assertions on stub output must
        # stay stable. Tests of the LLM path live below and mock
        # _generate_chat_compute / _generate_chat_local directly.
        "backend": "stub",
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


# ---------------------------------------------------------------------------
# Phase B — real LLM path (compute → local fallback)
#
# Tests above force backend="stub" so they assert on deterministic text.
# These tests exercise the wired LLM path itself: build the prompt, ship
# it to the inner _generate_chat_compute / _generate_chat_local, return
# the model's content. Inner functions are mocked so the test suite
# stays offline.
# ---------------------------------------------------------------------------


from unittest.mock import patch


@pytest.mark.anyio
async def test_chat_compute_path_uses_compute_when_available(app):
    """When req.backend == 'compute' and the compute call succeeds,
    the response carries backend == 'compute' and the model's text."""
    with patch("coach_service._generate_chat_compute") as mock_compute:
        mock_compute.return_value = "Building a prime here is the best line."
        async with AsyncClient(transport=ASGITransport(app=app),
                                base_url="http://test") as c:
            resp = await c.post("/chat", json=_request_body(backend="compute"))
    assert resp.status_code == 200
    body = resp.json()
    assert body["backend"] == "compute"
    assert "prime" in body["message"]["text"].lower()
    # The wired path must build + ship the prompt — confirm the inner
    # function was actually called (not the stub).
    assert mock_compute.called
    prompt_arg = mock_compute.call_args[0][0]
    # build_chat_prompt should embed the dice + candidates in the prompt.
    assert "13/8 13/10" in prompt_arg
    assert "dice: 3-5" in prompt_arg


@pytest.mark.anyio
async def test_chat_falls_back_to_local_when_compute_fails(app):
    """If 0G Compute raises, /chat must fall back to the local model
    (same as /hint). Surface backend == 'local' in the response."""
    def boom(*_a, **_kw):
        raise RuntimeError("0G testnet unreachable")

    with patch("coach_service._generate_chat_compute", side_effect=boom), \
         patch("coach_service._generate_chat_local") as mock_local:
        mock_local.return_value = "Local fallback advice."
        async with AsyncClient(transport=ASGITransport(app=app),
                                base_url="http://test") as c:
            resp = await c.post("/chat", json=_request_body(backend="compute"))
    assert resp.status_code == 200
    body = resp.json()
    assert body["backend"] == "local"
    assert "fallback" in body["message"]["text"].lower()


@pytest.mark.anyio
async def test_chat_local_only_skips_compute_entirely(app):
    """backend == 'local' means do NOT attempt compute even on the
    happy path. This is the offline-development backend choice."""
    with patch("coach_service._generate_chat_compute") as mock_compute, \
         patch("coach_service._generate_chat_local") as mock_local:
        mock_local.return_value = "Local model output."
        async with AsyncClient(transport=ASGITransport(app=app),
                                base_url="http://test") as c:
            resp = await c.post("/chat", json=_request_body(backend="local"))
    assert resp.status_code == 200
    assert not mock_compute.called  # compute was skipped
    assert mock_local.called
    assert resp.json()["backend"] == "local"


@pytest.mark.anyio
async def test_chat_compute_only_raises_on_compute_failure(app):
    """backend == 'compute-only' surfaces the compute error to the
    caller instead of falling back. Used in CI when the demo path
    must work — the failure must NOT be swallowed by the local-fallback
    path. Under ASGITransport the unhandled exception propagates
    directly to the test (no error middleware); in production FastAPI
    converts it to a 500 response."""
    def boom(*_a, **_kw):
        raise RuntimeError("0G testnet unreachable")

    with patch("coach_service._generate_chat_compute", side_effect=boom), \
         patch("coach_service._generate_chat_local") as mock_local:
        mock_local.return_value = "should not be reached"
        with pytest.raises(RuntimeError, match="0G testnet unreachable"):
            async with AsyncClient(transport=ASGITransport(app=app),
                                    base_url="http://test") as c:
                await c.post("/chat", json=_request_body(backend="compute-only"))
        # Local was never reached — the whole point of compute-only.
        assert not mock_local.called


@pytest.mark.anyio
async def test_chat_resolves_agent_weights_hash_to_persona(app):
    """When agent_weights_hash is supplied, /chat must call
    load_profile and surface the persona summary in the LLM prompt
    so the agent's style grounds the reply."""
    fake_summary = "After 17 matches this agent favors building primes."

    class FakeProfile:
        def summarize(self):
            return fake_summary

    with patch("coach_service.load_profile") as mock_load, \
         patch("coach_service._generate_chat_compute") as mock_compute:
        mock_load.return_value = FakeProfile()
        mock_compute.return_value = "OK"
        async with AsyncClient(transport=ASGITransport(app=app),
                                base_url="http://test") as c:
            await c.post("/chat", json=_request_body(
                backend="compute",
                agent_weights_hash="0xabc123",
            ))
    assert mock_load.called
    assert mock_load.call_args[0][0] == "0xabc123"
    # The persona must end up in the prompt that was shipped to compute.
    prompt = mock_compute.call_args[0][0]
    assert fake_summary in prompt


@pytest.mark.anyio
async def test_chat_omits_persona_when_hash_is_empty(app):
    """Empty agent_weights_hash means no profile fetch — the prompt
    must not include an Agent persona: line."""
    with patch("coach_service.load_profile") as mock_load, \
         patch("coach_service._generate_chat_compute") as mock_compute:
        mock_compute.return_value = "OK"
        async with AsyncClient(transport=ASGITransport(app=app),
                                base_url="http://test") as c:
            await c.post("/chat", json=_request_body(
                backend="compute",
                agent_weights_hash="",
            ))
    # load_profile should NOT have been called when hash is empty.
    assert not mock_load.called
    prompt = mock_compute.call_args[0][0]
    assert "Agent persona:" not in prompt


@pytest.mark.anyio
async def test_chat_swallows_load_profile_errors(app):
    """If load_profile raises (0G Storage down, malformed blob,
    network blip), /chat must still produce a reply. Persona just
    becomes empty."""
    with patch("coach_service.load_profile", side_effect=RuntimeError("0G down")), \
         patch("coach_service._generate_chat_compute") as mock_compute:
        mock_compute.return_value = "Reply without persona."
        async with AsyncClient(transport=ASGITransport(app=app),
                                base_url="http://test") as c:
            resp = await c.post("/chat", json=_request_body(
                backend="compute",
                agent_weights_hash="0xdeadbeef",
            ))
    assert resp.status_code == 200
    assert resp.json()["message"]["text"] == "Reply without persona."


@pytest.mark.anyio
async def test_chat_preferences_update_runs_in_real_path_too(app):
    """Preference updates live outside the LLM call, so they must run
    on the LLM path identically to the stub path."""
    history = [
        {"role": "human", "text": "I want to play this as a running game",
         "turn_index": 0, "timestamp": "2026-05-01T12:00:00Z"},
    ]
    with patch("coach_service._generate_chat_compute") as mock_compute:
        mock_compute.return_value = "OK, leaning racing."
        async with AsyncClient(transport=ASGITransport(app=app),
                                base_url="http://test") as c:
            resp = await c.post("/chat", json=_request_body(
                kind="human_reply", dialogue=history, backend="compute",
            ))
    body = resp.json()
    assert "prefers_running" in body["preferences_delta"]
    assert body["preferences_delta"]["prefers_running"] > 0
