"""Tests for coach_dialogue.py — Phase A data shapes and helpers.

Run with:  cd agent && uv run pytest tests/test_coach_dialogue.py -v

Coverage focuses on the contracts the rest of the dialogue system
relies on:
  - DialogueMessage / DialogueState round-trip cleanly
  - ChatRequest validates the three accepted `kind` values
  - build_chat_prompt produces stable, scannable output for each
    `kind` and includes the bits the LLM needs (candidates, dialogue
    history, opponent profile, persona, prefs)
  - update_preferences nudges the right keys for human messages,
    ignores agent messages, clips to [-1, 1]
  - derive_preferences_delta surfaces only the changes
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from coach_dialogue import (
    PREF_BOUND,
    CandidateRef,
    ChatRequest,
    ChatResponse,
    DialogueMessage,
    DialogueState,
    build_chat_prompt,
    derive_preferences_delta,
    now_iso,
    update_preferences,
)


# ---------------------------------------------------------------------------
# DialogueMessage / DialogueState
# ---------------------------------------------------------------------------


def _msg(role: str = "human", text: str = "hi", turn_index: int = 0,
         move_id: str | None = None) -> DialogueMessage:
    return DialogueMessage(role=role, text=text, turn_index=turn_index,
                           move_id=move_id, timestamp=now_iso())


def test_dialogue_message_requires_known_role():
    with pytest.raises(ValidationError):
        DialogueMessage(role="bot", text="x", turn_index=0, timestamp=now_iso())


def test_dialogue_message_rejects_negative_turn_index():
    with pytest.raises(ValidationError):
        DialogueMessage(role="human", text="x", turn_index=-1, timestamp=now_iso())


def test_dialogue_state_default_history_is_empty():
    s = DialogueState(match_id="0xabc")
    assert s.history == []
    assert s.preferences == {}


def test_dialogue_state_round_trip():
    msgs = [_msg(text="open"), _msg(role="agent", text="response")]
    s = DialogueState(match_id="0xabc", history=msgs,
                       preferences={"prefers_running": 0.4})
    assert len(s.history) == 2
    assert s.preferences["prefers_running"] == 0.4


# ---------------------------------------------------------------------------
# ChatRequest
# ---------------------------------------------------------------------------


def _req(kind: str = "open_turn", **overrides) -> ChatRequest:
    base = dict(
        kind=kind,
        match_id="0x" + "ab" * 32,
        turn_index=0,
        position_id="dummy_pos",
        dice=[3, 5],
        candidates=[
            CandidateRef(move="13/8 13/10", equity=0.012),
            CandidateRef(move="13/8 8/3",   equity=0.005),
        ],
    )
    base.update(overrides)
    return ChatRequest(**base)


def test_chat_request_validates_each_kind():
    for kind in ("open_turn", "human_reply", "move_committed"):
        _req(kind=kind)


def test_chat_request_rejects_unknown_kind():
    with pytest.raises(ValidationError):
        _req(kind="random_chat")


def test_chat_request_default_dialogue_is_empty():
    assert _req().dialogue == []


# ---------------------------------------------------------------------------
# build_chat_prompt
# ---------------------------------------------------------------------------


def test_prompt_includes_position_dice_and_candidates():
    p = build_chat_prompt(_req())
    assert "dice: 3-5" in p
    assert "13/8 13/10" in p
    assert "13/8 8/3" in p


def test_prompt_open_turn_framing_avoids_giving_away_the_pick():
    """The whole point of /chat over /hint is the agent talks the
    human through the trade-off, not just announces the answer."""
    p = build_chat_prompt(_req(kind="open_turn"))
    assert "without giving away" in p.lower() or "trade-off" in p.lower()


def test_prompt_human_reply_framing_addresses_the_human_directly():
    history = [
        _msg(role="agent", text="I'd lean 13/8 8/3 — slot the 3-point."),
        _msg(role="human", text="but doesn't 8/3 leave a blot?"),
    ]
    p = build_chat_prompt(_req(kind="human_reply", dialogue=history))
    assert "human: but doesn't 8/3 leave a blot?" in p
    assert "agent: I'd lean" in p
    assert "respond on the merits" in p.lower() or \
           "address their point" in p.lower()


def test_prompt_move_committed_includes_chosen_move():
    p = build_chat_prompt(_req(kind="move_committed",
                                move_committed="13/8 13/10"))
    assert "Move committed: 13/8 13/10" in p


def test_prompt_includes_persona_when_supplied():
    p = build_chat_prompt(_req(), agent_persona="prefers prime-building")
    assert "prefers prime-building" in p


def test_prompt_omits_persona_section_when_empty():
    p = build_chat_prompt(_req(), agent_persona="")
    assert "Agent persona:" not in p


def test_prompt_includes_session_preferences_when_present():
    p = build_chat_prompt(_req(preferences={"prefers_running": 0.6}))
    assert "Session preferences" in p
    assert "favours prefers running" in p


def test_prompt_omits_preferences_when_below_threshold():
    """Tiny prefs are noise, not signal — rendering them wastes prompt
    tokens and risks the LLM over-claiming."""
    p = build_chat_prompt(_req(preferences={"prefers_running": 0.01}))
    assert "Session preferences" not in p


# ---------------------------------------------------------------------------
# update_preferences
# ---------------------------------------------------------------------------


def test_human_message_with_running_keyword_nudges_prefs():
    msg = _msg(text="I want to play this as a running game")
    new = update_preferences({}, msg)
    assert new["prefers_running"] > 0


def test_agent_messages_do_not_change_preferences():
    msg = _msg(role="agent", text="aggressive blitz here is the right call")
    assert update_preferences({"x": 0.5}, msg) == {"x": 0.5}


def test_preferences_clipped_to_unit_interval():
    """Repeated nudges in the same direction can't run away."""
    prefs: dict[str, float] = {}
    text = "running game " * 20
    for _ in range(50):
        prefs = update_preferences(prefs, _msg(text=text))
    assert prefs["prefers_running"] == pytest.approx(PREF_BOUND)


def test_input_dict_not_mutated():
    """update_preferences must return a fresh dict (so the caller can
    safely keep the previous state for diffing)."""
    prev = {"prefers_running": 0.3}
    update_preferences(prev, _msg(text="play the running game"))
    assert prev == {"prefers_running": 0.3}


def test_unrelated_human_message_leaves_prefs_unchanged():
    msg = _msg(text="hello there")
    assert update_preferences({"prefers_running": 0.5}, msg) == \
           {"prefers_running": 0.5}


# ---------------------------------------------------------------------------
# derive_preferences_delta
# ---------------------------------------------------------------------------


def test_delta_surfaces_only_changes():
    """Keys whose value is the same on both sides (or zero in both) are
    dropped — the delta is the changes only."""
    prev = {"a": 0.1, "b": 0.5, "c": 0.0}
    post = {"a": 0.1, "b": 0.7, "d": 0.4}
    delta = derive_preferences_delta(prev, post)
    assert delta == {"b": pytest.approx(0.2), "d": 0.4}


def test_delta_empty_when_no_change():
    prev = {"a": 0.1}
    assert derive_preferences_delta(prev, dict(prev)) == {}


# ---------------------------------------------------------------------------
# ChatResponse
# ---------------------------------------------------------------------------


def test_chat_response_round_trip():
    msg = _msg(role="agent", text="acknowledged")
    resp = ChatResponse(message=msg, backend="stub", latency_ms=42)
    assert resp.message.text == "acknowledged"
    assert resp.backend == "stub"
    assert resp.preferences_delta == {}


# ---------------------------------------------------------------------------
# Team-mode kinds — see docs/team-mode.md
# ---------------------------------------------------------------------------


def test_chat_request_validates_team_mode_kinds():
    for kind in ("teammate_propose", "teammate_advise", "captain_decide"):
        _req(kind=kind)


def test_chat_request_accepts_chosen_advisor_id():
    r = _req(kind="captain_decide", chosen_advisor_id="agent:7",
             move_committed="13/8 13/10")
    assert r.chosen_advisor_id == "agent:7"


def test_chat_request_chosen_advisor_id_defaults_none():
    assert _req().chosen_advisor_id is None


def test_prompt_teammate_propose_framing_includes_proposal_format():
    """The teammate_propose framing must tell the LLM the exact shape
    the frontend will parse into an AdvisorSignal."""
    p = build_chat_prompt(_req(kind="teammate_propose"))
    assert "I propose" in p
    assert "Confidence" in p
    assert "team-mode" in p.lower()


def test_prompt_teammate_advise_framing_assumes_same_team():
    """The advise framing differs from human_reply: same-team good faith,
    not defending a position against an opposing player."""
    p = build_chat_prompt(_req(kind="teammate_advise"))
    assert "same team" in p.lower()
    assert "elaborate" in p.lower()


def test_prompt_captain_decide_with_chosen_advisor_id_credits_them():
    """When the captain credits a specific advisor, the framing must
    surface that advisor id so the LLM acknowledges them."""
    p = build_chat_prompt(_req(kind="captain_decide",
                                move_committed="13/8 13/10",
                                chosen_advisor_id="agent:7"))
    assert "agent:7" in p
    assert "Move committed: 13/8 13/10" in p
    assert "Chosen advisor: agent:7" in p


def test_prompt_captain_decide_without_chosen_advisor_id_omits_credit():
    """When the captain does NOT credit anyone, the prompt must not
    invent an advisor id — the LLM should just acknowledge the move."""
    p = build_chat_prompt(_req(kind="captain_decide",
                                move_committed="13/8 13/10"))
    assert "Chosen advisor:" not in p
    assert "without speculating" in p.lower()


def test_prompt_captain_decide_includes_chosen_advisor_in_body():
    """Both the framing and the body should carry chosen_advisor_id —
    the body so the LLM has the raw id to quote, the framing so it
    knows what to do with it."""
    p = build_chat_prompt(_req(kind="captain_decide",
                                move_committed="24/18 13/10",
                                chosen_advisor_id="0xDEADBEEF"))
    assert p.count("0xDEADBEEF") >= 2  # framing + body
