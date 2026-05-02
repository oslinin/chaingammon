"""test_phase76_chief_of_staff.py — tests for the /chief-of-staff/chat endpoint.

Phase 76: Chaingammon hackathon MVP collaborative-agent feature.

Tests cover:
  - Stub mode returns a reply naming the top candidate
  - No-legal-moves path in stub mode
  - Deep-dive is triggered by validation keywords in human_strategy
  - Deep-dive is triggered by a keyword in the most recent dialogue message
  - Deep-dive is None when no trigger keyword is present
  - Recommended move is extracted from the reply
  - Recommended move falls back to top candidate when not found in reply
  - _deep_dive_requested correctly detects all registered trigger words
  - _mock_historical_search returns tag-appropriate text
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from fastapi.testclient import TestClient
from coach_service import (
    app,
    _deep_dive_requested,
    _mock_historical_search,
    _extract_recommended_move,
)

client = TestClient(app)

_TOP5 = [
    {"move": "8/5 6/5", "equity": 0.45, "tag": "Safe", "tag_reason": "low blot exposure"},
    {"move": "13/10 13/9", "equity": 0.30, "tag": "Priming", "tag_reason": "extends prime"},
    {"move": "24/20", "equity": 0.15, "tag": "Anchor", "tag_reason": "home board anchor"},
    {"move": "8/3 6/3", "equity": 0.10, "tag": "Aggressive", "tag_reason": "dominant equity"},
    {"move": "13/8", "equity": 0.02, "tag": "Blitz", "tag_reason": "hits 2 blots"},
]


# ─── stub mode ───────────────────────────────────────────────────────────────

def test_stub_returns_reply():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": _TOP5,
        "human_strategy": "play safe",
        "backend": "stub",
    })
    assert res.status_code == 200
    data = res.json()
    assert "reply" in data
    assert len(data["reply"]) > 0
    assert data["backend"] == "stub"


def test_stub_reply_names_top_move():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": _TOP5,
        "human_strategy": "",
        "backend": "stub",
    })
    data = res.json()
    assert "8/5 6/5" in data["reply"]


def test_stub_no_legal_moves():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": [],
        "human_strategy": "anything",
        "backend": "stub",
    })
    assert res.status_code == 200
    data = res.json()
    assert "no legal moves" in data["reply"].lower() or "passes" in data["reply"].lower()


def test_stub_recommended_move_is_top_candidate():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": _TOP5,
        "human_strategy": "",
        "backend": "stub",
    })
    data = res.json()
    # recommended_move should be the top candidate since stub reply names it
    assert data["recommended_move"] == "8/5 6/5"


def test_stub_recommended_tag():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": _TOP5,
        "human_strategy": "",
        "backend": "stub",
    })
    data = res.json()
    assert data["recommended_tag"] == "Safe"


# ─── deep-dive trigger detection ─────────────────────────────────────────────

def test_deep_dive_not_triggered_by_default():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": _TOP5,
        "human_strategy": "play safe",
        "backend": "stub",
    })
    assert res.json()["deep_dive"] is None


def test_deep_dive_triggered_by_human_strategy():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": _TOP5,
        "human_strategy": "validate my intuition",
        "backend": "stub",
    })
    data = res.json()
    assert data["deep_dive"] is not None
    assert len(data["deep_dive"]) > 10


def test_deep_dive_triggered_by_dialogue():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": _TOP5,
        "human_strategy": "",
        "dialogue": [
            {"role": "agent", "text": "I recommend 8/5 6/5."},
            {"role": "human", "text": "are you sure about this?"},
        ],
        "backend": "stub",
    })
    data = res.json()
    assert data["deep_dive"] is not None


def test_deep_dive_triggered_by_historical_keyword():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": _TOP5,
        "human_strategy": "what does historical data say?",
        "backend": "stub",
    })
    assert res.json()["deep_dive"] is not None


def test_deep_dive_not_triggered_for_other_message():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": _TOP5,
        "human_strategy": "I want to play aggressively",
        "backend": "stub",
    })
    assert res.json()["deep_dive"] is None


# ─── _deep_dive_requested unit tests ─────────────────────────────────────────

def test_deep_dive_requested_validate():
    assert _deep_dive_requested("can you validate this?") is True


def test_deep_dive_requested_intuition():
    assert _deep_dive_requested("going with my intuition") is True


def test_deep_dive_requested_history():
    assert _deep_dive_requested("what does history say") is True


def test_deep_dive_requested_check():
    assert _deep_dive_requested("check if this is right") is True


def test_deep_dive_not_requested():
    assert _deep_dive_requested("I want to be aggressive") is False


def test_deep_dive_case_insensitive():
    assert _deep_dive_requested("VALIDATE my strategy") is True


# ─── _mock_historical_search unit tests ──────────────────────────────────────

def test_mock_historical_safe():
    result = _mock_historical_search("8/5 6/5", "Safe")
    assert "Historical analysis" in result
    assert "68%" in result or "race" in result.lower()


def test_mock_historical_aggressive():
    result = _mock_historical_search("13/7", "Aggressive")
    assert "54%" in result or "aggressive" in result.lower()


def test_mock_historical_blitz():
    result = _mock_historical_search("10/5 13/8", "Blitz")
    assert "blitz" in result.lower() or "60%" in result


def test_mock_historical_anchor():
    result = _mock_historical_search("13/20", "Anchor")
    assert "anchor" in result.lower() or "82%" in result


def test_mock_historical_priming():
    result = _mock_historical_search("17/12", "Priming")
    assert "prime" in result.lower() or "71%" in result


def test_mock_historical_unknown_tag():
    result = _mock_historical_search("8/5", "Unknown")
    assert "Historical analysis" in result


# ─── _extract_recommended_move unit tests ────────────────────────────────────

def test_extract_found_in_reply():
    reply = "I recommend 8/5 6/5 as the best Safe move here."
    move, tag = _extract_recommended_move(reply, _TOP5)
    assert move == "8/5 6/5"
    assert tag == "Safe"


def test_extract_second_candidate():
    reply = "The best line is 13/10 13/9 for a strong priming formation."
    move, tag = _extract_recommended_move(reply, _TOP5)
    assert move == "13/10 13/9"
    assert tag == "Priming"


def test_extract_fallback_to_top():
    """When the reply doesn't contain any candidate move, fall back to top."""
    reply = "You should play defensively right now."
    move, tag = _extract_recommended_move(reply, _TOP5)
    assert move == "8/5 6/5"
    assert tag == "Safe"


def test_extract_empty_candidates():
    move, tag = _extract_recommended_move("some reply", [])
    assert move is None
    assert tag is None


# ─── response schema ─────────────────────────────────────────────────────────

def test_response_schema_complete():
    res = client.post("/chief-of-staff/chat", json={
        "tagged_candidates": _TOP5,
        "human_strategy": "play safe",
        "backend": "stub",
        "turn_index": 3,
        "opponent_features": "tends to blitz aggressively",
    })
    assert res.status_code == 200
    data = res.json()
    assert "reply" in data
    assert "recommended_move" in data
    assert "recommended_tag" in data
    assert "deep_dive" in data
    assert "backend" in data
    assert "latency_ms" in data
    assert isinstance(data["latency_ms"], int)
