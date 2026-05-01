"""coach_dialogue.py — data shapes and helpers for the coach dialogue.

Phase A of the coach-dialogue work (see docs/coach-dialogue.md). This
module provides:

  - `DialogueMessage`            one bubble in the per-match dialogue
  - `DialogueState`              full per-match dialogue + session prefs
  - `ChatKind`                   the three message kinds the endpoint accepts
  - `ChatRequest` / `ChatResponse`  the wire shape of POST /chat
  - `build_chat_prompt`          assemble an LLM prompt from the state
  - `update_preferences`         derive a per-session preference signal from
                                 the human's accept/reject pattern

Pure data + pure functions — no HTTP, no LLM call, no IO. The
endpoint that wires this into coach_service is a follow-up commit.

Why a separate module from coach_service.py:
  - The data shapes are reusable: the frontend and the eventual
    training-feedback aggregator both consume them, and neither
    should pull in FastAPI to get at the dataclasses.
  - The prompt-assembly logic is the core asset. Keeping it in a
    pure module makes it easy to unit-test against fixed inputs
    (no LLM in the loop) and to swap LLM backends later without
    touching the prompt code.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field


ChatKind = Literal[
    # Solo flow (1 human + 1 agent advisor vs 1 opponent — see docs/coach-dialogue.md):
    "open_turn", "human_reply", "move_committed",
    # Team flow (captain + advisor(s) vs opponent team — see docs/team-mode.md):
    "teammate_propose", "teammate_advise", "captain_decide",
]
DialogueRole = Literal["human", "agent"]

# Per-session preference deltas are clipped to [-1, 1] so any single
# exchange has bounded influence — same convention as the agent overlay
# in server/app/agent_overlay.py.
PREF_BOUND = 1.0


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------


class DialogueMessage(BaseModel):
    """One bubble in the per-match dialogue. Append-only.

    `move_id` is an opaque identifier for the move under discussion
    so the frontend can group messages by turn even if the user
    scrolls back and asks a clarifying question about a prior turn."""
    role: DialogueRole
    text: str
    turn_index: int = Field(ge=0)
    move_id: Optional[str] = None
    timestamp: str  # ISO-8601 UTC; default helper below


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class DialogueState(BaseModel):
    """Per-match dialogue state. Lives in the browser's localStorage
    (`chaingammon:dialogue:<matchId>`) and is sent to the coach on
    every /chat request so the agent has full context.

    `preferences` is a session-local signal derived from the human's
    accept/reject pattern across this match — see `update_preferences`.
    It expires when the browser session ends and does NOT feed agent
    training. The human-in-the-loop training signal in Chaingammon
    comes from team mode (see `docs/team-mode.md`), not from solo
    coach dialogue."""
    match_id: str
    history: list[DialogueMessage] = Field(default_factory=list)
    preferences: dict[str, float] = Field(default_factory=dict)


class CandidateRef(BaseModel):
    """Slim duck-type of the candidate dicts gnubg_service returns. Kept
    here so this module doesn't import from gnubg_service."""
    move: str
    equity: float


class ChatRequest(BaseModel):
    """Request body for POST /chat. The frontend sends this on every
    interaction within a turn."""
    kind: ChatKind
    match_id: str
    turn_index: int = Field(ge=0)

    # Position context — same shape as /hint already accepts.
    position_id: str
    dice: list[int]
    candidates: list[CandidateRef]

    # Identity context.
    opponent_profile_uri: str = ""
    agent_weights_hash: str = ""

    # Conversation context.
    dialogue: list[DialogueMessage] = Field(default_factory=list)
    preferences: dict[str, float] = Field(default_factory=dict)

    # Only set when kind == "move_committed" or kind == "captain_decide".
    move_committed: Optional[str] = None

    # Only set when kind == "captain_decide" and the captain followed a
    # specific advisor's proposal. PlayerRef.id of the advisor (address
    # or "agent:N"); None means the captain chose independently.
    chosen_advisor_id: Optional[str] = None


class ChatResponse(BaseModel):
    """Response body for POST /chat."""
    message: DialogueMessage
    backend: Literal["compute", "local", "stub"]
    preferences_delta: dict[str, float] = Field(default_factory=dict)
    latency_ms: int


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------


def _format_candidates(candidates: list[CandidateRef], top_n: int = 3) -> str:
    """Render the top-N candidates as a compact bulleted list."""
    if not candidates:
        return "(no legal moves)"
    rows = []
    for i, c in enumerate(candidates[:top_n], start=1):
        sign = "+" if c.equity >= 0 else ""
        rows.append(f"  {i}. {c.move}    eq {sign}{c.equity:.3f}")
    return "\n".join(rows)


def _format_dialogue(history: list[DialogueMessage]) -> str:
    if not history:
        return "(this is the first message of the turn)"
    return "\n".join(f"{m.role}: {m.text}" for m in history)


def _format_preferences(prefs: dict[str, float]) -> str:
    """Render the running per-session preferences as a one-line summary
    suitable for inclusion in an LLM system prompt. Empty when the
    session has no signal yet."""
    if not prefs:
        return ""
    parts = []
    for key, value in sorted(prefs.items(), key=lambda kv: -abs(kv[1])):
        if abs(value) < 0.05:
            continue
        sign = "favours" if value > 0 else "avoids"
        parts.append(f"{sign} {key.replace('_', ' ')}")
    if not parts:
        return ""
    return "Session preferences so far: " + "; ".join(parts) + "."


def build_chat_prompt(req: ChatRequest, *, agent_persona: str = "") -> str:
    """Assemble the LLM prompt for a /chat request.

    The prompt is a single string with three sections:
      - Position summary (board state, dice, candidates)
      - Identity context (opponent profile, agent persona, prefs)
      - Conversation history + the current request kind

    Production code passes this to `coach_compute_client.chat`
    (Qwen 2.5 7B on 0G Compute) or to flan-t5-base for the local
    fallback. The prompt is the same for both backends.
    """
    pref_summary = _format_preferences(req.preferences)
    persona_line = (f"Agent persona: {agent_persona}\n"
                    if agent_persona.strip() else "")

    # Per-kind framing — the LLM responds differently for the opening
    # take vs a human reply vs an after-move acknowledgement.
    if req.kind == "open_turn":
        framing = (
            "The human just rolled. Give your opening take on this "
            "turn in 1-2 sentences. Discuss the trade-off between the "
            "top candidates without giving away the gnubg pick — the "
            "human should still feel like they're choosing."
        )
    elif req.kind == "human_reply":
        framing = (
            "The human has replied to your earlier message. Address "
            "their point directly in 1-2 sentences. If they're "
            "challenging your suggestion, respond on the merits "
            "(equity, blot exposure, race vs holding game). Don't "
            "concede unless they're correct."
        )
    elif req.kind == "move_committed":
        framing = (
            "The human just committed their move. Acknowledge it in "
            "one short sentence. If they took your suggestion, that's "
            "good. If not, note what the chosen move trades for vs the "
            "alternative without lecturing."
        )
    elif req.kind == "teammate_propose":
        framing = (
            "You are a teammate-advisor in a team-mode match — see "
            "docs/team-mode.md. The captain has the dice and is "
            "asking what you'd propose. Give your proposal in 1-2 "
            "sentences with a confidence in [0, 1] and a one-line "
            "rationale. Format: 'I propose <move>. Confidence: "
            "<0..1>. <rationale>'. The captain decides; you advise."
        )
    elif req.kind == "teammate_advise":
        framing = (
            "You are a teammate-advisor in a team-mode match. The "
            "captain has asked you to elaborate on your earlier "
            "proposal. Address their question directly in 1-2 "
            "sentences. You're on the same team — assume good faith, "
            "no need to defensively justify your proposal."
        )
    elif req.kind == "captain_decide":
        if req.chosen_advisor_id:
            framing = (
                f"The captain has committed their move and noted they "
                f"followed advisor '{req.chosen_advisor_id}'. "
                f"Acknowledge in one short sentence — credit the "
                f"advisor if it wasn't you, or briefly confirm your "
                f"earlier read if it was."
            )
        else:
            framing = (
                "The captain has committed their move without "
                "crediting a specific advisor. Acknowledge in one "
                "short sentence without speculating about whose "
                "advice was followed."
            )
    else:
        framing = "(unknown chat kind — produce a generic acknowledgement)"

    move_committed_line = (
        f"Move committed: {req.move_committed}\n"
        if req.move_committed else ""
    )
    chosen_advisor_line = (
        f"Chosen advisor: {req.chosen_advisor_id}\n"
        if req.chosen_advisor_id else ""
    )

    return (
        f"You are a backgammon coach in the middle of a match.\n"
        f"{persona_line}"
        f"\n"
        f"Position:\n"
        f"  position_id: {req.position_id}\n"
        f"  dice: {req.dice[0]}-{req.dice[1]}\n"
        f"  top candidates (equity is from the agent's value net):\n"
        f"{_format_candidates(req.candidates)}\n"
        f"\n"
        f"Opponent profile uri: {req.opponent_profile_uri or '(none)'}\n"
        f"Agent weights hash:   {req.agent_weights_hash or '(none)'}\n"
        f"{pref_summary + chr(10) if pref_summary else ''}"
        f"\n"
        f"Dialogue so far:\n"
        f"{_format_dialogue(req.dialogue)}\n"
        f"{move_committed_line}"
        f"{chosen_advisor_line}"
        f"\n"
        f"{framing}"
    )


# ---------------------------------------------------------------------------
# Preference signal
# ---------------------------------------------------------------------------


# Heuristic mapping: keywords in the human's message map to preference
# keys. Hand-coded for v1; an LLM-extracted v2 signal would still be
# session-scoped UX adaptation (it does not feed agent training).
_PREF_KEYWORDS: dict[str, list[str]] = {
    "prefers_running": ["running game", "race", "run my back checkers"],
    "prefers_holding": ["holding game", "hold the anchor", "keep the back point"],
    "prefers_aggressive": ["hit", "aggressive", "blitz", "double"],
    "prefers_safe": ["safe", "conservative", "avoid blots"],
    "wants_less_chat": ["stop", "quiet", "shut up", "less"],
    "wants_more_explanation": ["why", "explain", "what's a", "what is"],
}


def update_preferences(prev: dict[str, float], message: DialogueMessage,
                       *, learning_rate: float = 0.2) -> dict[str, float]:
    """Update the running session preferences from one new message.

    Hand-coded heuristic for v1: scan the human's message for keyword
    matches against `_PREF_KEYWORDS` and nudge the corresponding key
    by +`learning_rate`. Agent messages don't move preferences (only
    the human's words count).

    The output is consumed only by the next prompt assembly within
    this match's session — it is session-local UX adaptation, not
    persisted into agent training data.

    Output is a fresh dict (input is not mutated) clipped to
    [-PREF_BOUND, PREF_BOUND].
    """
    if message.role != "human":
        return dict(prev)
    text = message.text.lower()
    new = dict(prev)
    for pref_key, keywords in _PREF_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            current = new.get(pref_key, 0.0)
            updated = current + learning_rate
            new[pref_key] = max(-PREF_BOUND, min(PREF_BOUND, updated))
    return new


def derive_preferences_delta(prev: dict[str, float],
                             post: dict[str, float]) -> dict[str, float]:
    """Compute `post - prev` for each key. Used by ChatResponse so the
    frontend can show the user what the agent picked up from their
    message ('OK, easing off the aggressive suggestions')."""
    keys = set(prev) | set(post)
    return {k: post.get(k, 0.0) - prev.get(k, 0.0)
            for k in keys
            if post.get(k, 0.0) != prev.get(k, 0.0)}
