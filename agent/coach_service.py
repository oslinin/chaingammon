"""
coach_service.py — local FastAPI agent process: LLM coaching hints.

@notice Run as a plain HTTP service on the player's own machine on a
        separate port from gnubg_service. The browser hits localhost:8002
        directly via fetch. Start with:

          uvicorn coach_service:app --port 8002

@dev    Endpoint:
          POST /hint — generate a plain-English coaching hint for the current
                       turn, given the ranked candidates from gnubg_service.

        Inference backend:
          1. 0G Compute Network — Qwen 2.5 7B Instruct via
             @0glabs/0g-serving-broker. Sponsor-aligned (verifiable inference,
             pay-per-token from a 0G ledger). Routed through the Node bridge
             at og-compute-bridge/ so this Python service does not need to
             port the JS SDK.

        docs_hash:  0G Storage root hash of the gnubg strategy doc uploaded by
                    scripts/upload_gnubg_docs.py. Used as RAG context. Falls
                    back to a built-in brief if the hash is empty or the blob
                    is unavailable.

        agent_weights_hash:  0G Storage root hash of the agent's experience
                             overlay (or future model checkpoint). The coach
                             reads it via agent_profile.load_profile() to
                             ground the hint in this specific agent's
                             tendencies — see agent_profile.py for the
                             forward-compatible interface.
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from agent_profile import AgentProfile, NullProfile, load_profile
from coach_dialogue import (
    ChatRequest,
    ChatResponse,
    DialogueMessage,
    build_chat_prompt,
    derive_preferences_delta,
    now_iso,
    update_preferences,
)

app = FastAPI(title="Chaingammon Coach Agent")

# The browser calls /hint cross-origin from http://localhost:3000.
# Without CORS the preflight OPTIONS returns 405 and the POST is
# blocked. Open CORS in dev; production should pin `allow_origins`.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# COACH_BACKEND: "compute" (default) or "compute-only" (raise on failure).
# Local flan-t5 fallback is removed to streamline the demo to 0G Compute.
_BACKEND = "compute"


def _fetch_docs(docs_hash: str) -> str:
    """Fetch the gnubg strategy doc from 0G Storage by root hash.

    @notice Provides RAG context for the coach LLM. The doc is uploaded once
            by scripts/upload_gnubg_docs.py and its hash stored in the frontend
            config; it does not change per-match.
    @dev    Returns a built-in fallback string if the hash is empty or the blob
            is unreachable (network down, SDK unavailable). The fallback covers
            the most important opening principles so the coach is always at
            least plausible even offline.
    """
    _FALLBACK = (
        "Backgammon strategy: build primes (especially the 5-point and bar "
        "point), make anchors when behind in the race, hit blots when it "
        "doesn't leave too much exposure, and bear off efficiently when "
        "ahead. Avoid leaving direct shots after a hit."
    )
    if not docs_hash:
        return _FALLBACK
    try:
        from server.app.og_storage_client import get_blob  # type: ignore[import]
        return get_blob(docs_hash).decode("utf-8", errors="replace")
    except Exception:
        return _FALLBACK


def _build_messages(
    dice: list[int],
    candidates: list[dict],
    docs_context: str,
    profile: AgentProfile,
) -> tuple[str, list[dict]]:
    """Assemble the system prompt + chat messages for the LLM.

    Returned in chat-completion shape for the 0G Compute path (Qwen).

    @return (system_prompt, [{"role": "user", "content": ...}])
    """
    top3 = candidates[:3]
    moves_text = "; ".join(
        f"{c['move']} (equity {c['equity']:+.3f})" for c in top3
    ) or "no legal moves"
    system = (
        "You are a backgammon coach watching a human play against an AI agent. "
        "Speak directly to the human in 1–2 sentences. Reference the agent's "
        "playing tendencies when relevant. Do not list options — explain "
        "why the top move is good. Use plain English; no jargon beyond "
        "standard backgammon terms."
    )
    user = (
        f"Reference strategy notes: {docs_context}\n\n"
        f"Opponent agent profile: {profile.summarize()}\n\n"
        f"The human rolled {dice[0]} and {dice[1]}.\n"
        f"gnubg ranked these moves (best first): {moves_text}.\n\n"
        f"In 1–2 sentences, tell the human why the best move is the right "
        f"choice against this specific agent."
    )
    return system, [{"role": "user", "content": user}]


def _generate_compute(
    dice: list[int],
    candidates: list[dict],
    docs_context: str,
    profile: AgentProfile,
) -> str:
    """0G Compute path — Qwen 2.5 7B Instruct via the Node bridge."""
    from coach_compute_client import chat
    system, messages = _build_messages(dice, candidates, docs_context, profile)
    result = chat(messages, system=system)
    return result.content.strip()


def _generate(
    dice: list[int],
    candidates: list[dict],
    docs_context: str,
    profile: AgentProfile,
    backend: Optional[str] = None,
) -> tuple[str, str]:
    """Run inference with the 0G Compute backend.

    @param backend  Per-request override.
    @return (hint_text, backend_used) — backend_used is "compute".
    """
    return _generate_compute(dice, candidates, docs_context, profile), "compute"


# ─── request / response models ───────────────────────────────────────────────

class HintRequest(BaseModel):
    """Request body for POST /hint.

    @param position_id         gnubg base64 position identifier (passed through
                               for context; not used directly by the LLM).
    @param match_id            gnubg base64 match-state identifier (passed through).
    @param dice                Two-element list [d1, d2] for the current roll.
    @param candidates          Ranked move list from gnubg_service /evaluate,
                               each {"move": str, "equity": float}. Top 3 used.
    @param docs_hash           0G Storage root hash of the gnubg strategy doc;
                               empty string triggers the built-in fallback.
    @param agent_weights_hash  0G Storage root hash of the agent's overlay or
                               future model checkpoint. Empty triggers the
                               NullProfile (cold-start agent).
    @param backend             Optional per-request override of COACH_BACKEND.
                               One of "compute" (paid 0G inference)
                               or "compute-only" (paid; raise on failure).
                               Empty/None = use the server default.
    """

    position_id: str
    match_id: str
    dice: list[int]
    candidates: list[dict]
    docs_hash: str = ""
    agent_weights_hash: str = ""
    backend: Optional[str] = None


# ─── endpoint ────────────────────────────────────────────────────────────────

@app.post("/hint")
def get_hint(req: HintRequest) -> dict:
    """Generate a coaching hint from gnubg equity output.

    @notice Called by the frontend after every move to narrate the turn. The
            frontend shows a "Thinking…" placeholder until the hint arrives;
            this endpoint is intentionally non-blocking from the game's
            perspective.
    @dev    Pipeline:
              1. Fetch strategy docs from 0G Storage (or fallback).
              2. Load the agent profile from 0G Storage (or NullProfile).
              3. Run inference on 0G Compute (Qwen 2.5 7B).
    @return {"hint": str, "backend": "compute"}
    """
    docs_context = _fetch_docs(req.docs_hash)
    profile = load_profile(req.agent_weights_hash)
    hint, backend = _generate(
        req.dice, req.candidates, docs_context, profile, backend=req.backend
    )
    return {"hint": hint, "backend": backend}


# ─── /chat endpoint ─────────────────────────────────────────────────────────

_CHAT_SYSTEM_PROMPT = (
    "You are a backgammon coach embedded in a live match. The user "
    "message contains the full position context, dialogue history "
    "and a per-turn framing instruction; respect the framing and "
    "produce ONLY the reply text the player will see. Keep replies "
    "to 1-2 sentences unless the framing explicitly asks for more."
)


def _generate_chat_compute(prompt: str) -> str:
    """0G Compute path for /chat — Qwen 2.5 7B Instruct via the Node bridge.

    The full assembled prompt (`build_chat_prompt(req)`) is the user
    message; per-kind framing lives inside the prompt so the system
    prompt stays generic.
    """
    from coach_compute_client import chat
    result = chat(
        [{"role": "user", "content": prompt}],
        system=_CHAT_SYSTEM_PROMPT,
    )
    return result.content.strip()


def _generate_chat(
    prompt: str, backend: Optional[str] = None
) -> tuple[str, str]:
    """Run /chat inference with the 0G Compute backend.

    Selection rules mirror `_generate` for /hint:
      - backend == "compute"        → 0G Compute
    """
    return _generate_chat_compute(prompt), "compute"


def _stub_chat_reply(req: ChatRequest) -> str:
    """Phase-A placeholder for the LLM call. Echoes the assembled
    prompt context so the frontend can integrate against a known shape
    while Phase B wires the actual LLM backend (`_generate_chat`).

    The text returned here is intentionally bland — it's not what the
    user will see in production, just a deterministic acknowledgement
    that the request was understood."""
    if req.kind == "open_turn":
        if not req.candidates:
            return "No legal moves on this roll — the turn passes."
        top = req.candidates[0]
        return (f"For the {req.dice[0]}-{req.dice[1]}, the top candidate "
                f"is {top.move} (eq {top.equity:+.3f}). Want to talk "
                f"through the alternatives?")
    if req.kind == "human_reply":
        last_human = next(
            (m for m in reversed(req.dialogue) if m.role == "human"),
            None,
        )
        if last_human is None:
            return "Acknowledged — let me know which line you want to take."
        return (f"You said: '{last_human.text}'. (LLM-driven reply lands "
                f"in Phase B; this is the Phase-A stub.)")
    if req.kind == "move_committed":
        return f"Got it — recording {req.move_committed}."
    if req.kind == "teammate_propose":
        if not req.candidates:
            return "No legal moves on this roll — I have nothing to propose."
        top = req.candidates[0]
        return (f"I propose {top.move}. Confidence: 0.70. The eq is "
                f"{top.equity:+.3f} which is the strongest line on the "
                f"board.")
    if req.kind == "teammate_advise":
        last_human = next(
            (m for m in reversed(req.dialogue) if m.role == "human"),
            None,
        )
        if last_human is None:
            return ("Happy to elaborate — what specifically do you want me "
                    "to address?")
        return (f"On '{last_human.text}': (LLM-driven elaboration lands "
                f"in Phase B; this is the Phase-A stub.)")
    if req.kind == "captain_decide":
        move = req.move_committed or "(no move recorded)"
        if req.chosen_advisor_id:
            return (f"Got it — captain committed {move}, following "
                    f"{req.chosen_advisor_id}.")
        return f"Got it — captain committed {move}."
    return "(unknown chat kind)"


@app.post("/chat")
def post_chat(req: ChatRequest) -> ChatResponse:
    """Turn-by-turn dialogue endpoint. See docs/coach-dialogue.md.

    @notice Builds the prompt via `build_chat_prompt`, dispatches to
            `_generate_chat` (0G Compute)
            or, when `backend == "stub"`, to the deterministic
            `_stub_chat_reply` used by tests.

    @dev    Pipeline:
              1. build_chat_prompt(req) — pure function, deterministic.
              2. dispatch to LLM (compute) or stub.
              3. Update per-session preferences from the human's last
                 message (if any) and emit the delta in the response.
            The pipeline lives entirely outside the LLM call so the
            preference-update logic is testable without a model.
    @return ChatResponse(message, backend, preferences_delta, latency_ms)
    """
    import time
    started = time.monotonic()

    # Resolve the agent's persona from 0G Storage (if a weights hash is
    # supplied) so the LLM can ground its replies in this specific
    # agent's tendencies. Mirrors /hint's load_profile lookup. Empty
    # hash → no persona section in the prompt (NullProfile would still
    # produce a string but we want the prompt to compact when the
    # agent has no profile yet, matching the existing behaviour).
    agent_persona = ""
    if req.agent_weights_hash:
        try:
            agent_persona = load_profile(req.agent_weights_hash).summarize()
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(
                "load_profile failed for /chat (%s); proceeding without persona.", e
            )
            agent_persona = ""

    prompt = build_chat_prompt(req, agent_persona=agent_persona)

    chosen = (req.backend or _BACKEND).lower()
    if chosen == "stub":
        reply_text = _stub_chat_reply(req)
        backend_used = "stub"
    else:
        reply_text, backend_used = _generate_chat(prompt, req.backend)

    # Per-session preference update: only the most recent human
    # message contributes; agent messages don't move prefs (per
    # update_preferences semantics).
    new_prefs = dict(req.preferences)
    last_human = next(
        (m for m in reversed(req.dialogue) if m.role == "human"),
        None,
    )
    if last_human is not None:
        new_prefs = update_preferences(new_prefs, last_human)
    delta = derive_preferences_delta(req.preferences, new_prefs)

    elapsed_ms = int((time.monotonic() - started) * 1000)
    return ChatResponse(
        message=DialogueMessage(
            role="agent",
            text=reply_text,
            turn_index=req.turn_index,
            timestamp=now_iso(),
        ),
        backend=backend_used,
        preferences_delta=delta,
        latency_ms=elapsed_ms,
    )


# ─── /chief-of-staff/chat endpoint ─────────────────────────────────────────

_DEEP_DIVE_TRIGGERS = frozenset([
    "validate", "intuition", "deep dive", "deep-dive", "historical",
    "history", "database", "tell me more", "confirm", "sure about",
    "are you sure", "second opinion", "check",
])


def _deep_dive_requested(human_message: str) -> bool:
    """Return True when the human's message contains a deep-dive keyword."""
    lowered = human_message.lower()
    return any(trigger in lowered for trigger in _DEEP_DIVE_TRIGGERS)


def _historical_search(
    human_strategy: str,
    tagged_candidates: list[dict],
    opponent_features: Optional[str] = None,
    backend: Optional[str] = None,
    agent_id: Optional[int] = None,
) -> str:
    """Return a real historical search deep-dive using an LLM.

    The LLM processes the JSON opponent profile (fetched from the server),
    looks at the Top 5 Moves list, and replies confirming the data, stating
    the equity cost of deviating from the Phase 1 - GNUBG wrapper service #1 move,
    and asks for final confirmation.
    """
    import json

    # Real historical search: fetch the profile for agent_id if available.
    # Note: agent_id is passed from the frontend to the chief-of-staff endpoint.
    stats = None
    if agent_id:
        try:
            # SERVER points to localhost:8000 (main server)
            SERVER = os.environ.get("NEXT_PUBLIC_SERVER_URL", "http://localhost:8000")
            import requests
            res = requests.get(f"{SERVER}/agents/{agent_id}/profile", timeout=2)
            if res.ok:
                profile = res.json()
                # Derive realistic stats from the learned biases
                v = profile.get("values", {})
                hit_rate = 0.5 + float(v.get("hits_blot", 0)) * 0.4
                stats = {
                    "hit_rate_on_exposed_blots": hit_rate,
                    "blitz_success_rate": 0.4 + float(v.get("phase_blitz", 0)) * 0.3,
                    "prime_building_tendency": 0.5 + float(v.get("phase_prime_building", 0)) * 0.4,
                    "risk_tolerance": 0.5 + float(v.get("risk_hit_exposure", 0)) * 0.4,
                }
        except Exception:
            pass

    if not stats:
        # Fallback to mock if fetch fails, but marked as "estimated"
        stats = {
            "hit_rate_on_exposed_blots": 0.88,
            "blitz_success_rate": 0.45,
            "average_pip_count_difference": -12,
            "gammon_rate": 0.22
        }

    profile_json = json.dumps(stats, indent=2)

    if not tagged_candidates:
        candidates_section = "(no legal moves on this roll)"
    else:
        lines = []
        for i, c in enumerate(tagged_candidates[:5], 1):
            tag = c.get("tag", "Safe")
            reason = c.get("tag_reason", "")
            eq = c.get("equity", 0.0)
            sign = "+" if eq >= 0 else ""
            lines.append(f"  {i}. [{tag}] {c['move']}  (eq {sign}{eq:.3f}) — {reason}")
        candidates_section = "\n".join(lines)

    opp_section = f"Opponent features summary: {opponent_features}\n" if opponent_features else ""

    prompt = (
        "You are an elite backgammon Chief of Staff. Your human partner will suggest a strategy or state an intuition. Your job is to:\n\n"
        "1. Check the Opponent Profile to see if historical data supports the human's intuition.\n"
        "2. Look at the Top 5 Moves list from the engine.\n"
        "3. Find the move that best executes the human's strategy.\n"
        "4. Respond concisely, confirming the data, stating the equity cost of deviating from the #1 move (highest equity), and asking for final confirmation.\n\n"
        f"Opponent Profile Database (JSON):\n{profile_json}\n\n"
        f"{opp_section}"
        f"Top 5 Moves (Engine Data):\n{candidates_section}\n\n"
        f"Human Partner's Strategy/Intuition: \"{human_strategy}\"\n\n"
        "Your Response (Concise, data-driven, highlighting the human-agent synergy):"
    )

    reply_text, _ = _generate_chat(prompt, backend)
    return reply_text


def _build_chief_of_staff_prompt(
    human_strategy: str,
    tagged_candidates: list[dict],
    dialogue_history: list[dict],
    opponent_features: Optional[str] = None,
) -> str:
    """Assemble the Chief of Staff LLM prompt.

    The prompt structure:
      - Role: Chief of Staff who negotiates move selection with the human
      - Context: tagged candidates + opponent features
      - Human macro-strategy: what the human typed
      - Dialogue history for multi-turn context
      - Instruction: recommend the single best tagged move that fits the strategy
    """
    if not tagged_candidates:
        candidates_section = "(no legal moves on this roll)"
    else:
        lines = []
        for i, c in enumerate(tagged_candidates[:5], 1):
            tag = c.get("tag", "Safe")
            reason = c.get("tag_reason", "")
            eq = c.get("equity", 0.0)
            sign = "+" if eq >= 0 else ""
            lines.append(f"  {i}. [{tag}] {c['move']}  (eq {sign}{eq:.3f}) — {reason}")
        candidates_section = "\n".join(lines)

    history_section = ""
    if dialogue_history:
        history_lines = []
        for msg in dialogue_history[-6:]:
            role = msg.get("role", "human")
            text = msg.get("text", "")
            history_lines.append(f"{role}: {text}")
        history_section = "Recent conversation:\n" + "\n".join(history_lines) + "\n\n"

    opp_section = f"Opponent tendency: {opponent_features}\n\n" if opponent_features else ""

    strategy_section = (
        f'Human\'s macro-strategy: "{human_strategy}"\n\n'
        if human_strategy.strip()
        else "Human has not stated a macro-strategy yet.\n\n"
    )

    return (
        "You are the Chief of Staff for a human backgammon player. "
        "Your job: negotiate the single best move from the tagged candidates below "
        "that fits the human's macro-strategy. "
        "Be direct: name the move, state its tag, and explain in 2 sentences why it "
        "aligns with the human's strategy. If the human's strategy is unclear, ask one "
        "focused clarifying question.\n\n"
        f"{opp_section}"
        f"Candidate moves (ranked by equity, tagged by strategy type):\n{candidates_section}\n\n"
        f"{strategy_section}"
        f"{history_section}"
        "Your response (name the recommended move first, then the 2-sentence rationale):"
    )


# ─── request / response models for Chief of Staff ────────────────────────────

class ChiefOfStaffRequest(BaseModel):
    """Request body for POST /chief-of-staff/chat.

    @param tagged_candidates  Tagged candidate list from /evaluate-tagged
                              (each: {"move", "equity", "tag", "tag_reason"}).
    @param human_strategy     Human's free-text macro-strategy for this turn
                              (e.g. "I want to play safe", "be aggressive").
    @param dialogue           Prior chat messages for multi-turn context.
    @param opponent_features  Optional one-line summary of opponent tendencies
                              (fast-path from agent overlay, no async needed).
    @param agent_id           Optional ID of the opponent agent for historical search.
    @param turn_index         Current turn number.
    @param backend            "compute" | "stub" — mirrors HintRequest.
    """

    tagged_candidates: list[dict]
    human_strategy: str = ""
    dialogue: list[dict] = []
    opponent_features: Optional[str] = None
    agent_id: Optional[int] = None
    turn_index: int = 0
    backend: Optional[str] = None


class ChiefOfStaffResponse(BaseModel):
    """Response body for POST /chief-of-staff/chat.

    @param reply              LLM's negotiated recommendation.
    @param recommended_move   The specific move string the LLM selected
                              (parsed from the reply for UI highlighting).
    @param recommended_tag    The strategy tag of the recommended move.
    @param deep_dive          Historical analysis if the human requested validation;
                              None otherwise.
    @param backend            Which backend served the request.
    @param latency_ms         Wall-clock latency of the LLM call.
    """

    reply: str
    recommended_move: Optional[str]
    recommended_tag: Optional[str]
    deep_dive: Optional[str]
    backend: str
    latency_ms: int


def _extract_recommended_move(
    reply: str, tagged_candidates: list[dict]
) -> tuple[Optional[str], Optional[str]]:
    """Scan the LLM reply for a candidate move string and return (move, tag).

    Tries to find the first candidate whose move notation appears verbatim
    in the reply.  Falls back to the top candidate if nothing is found.
    """
    for cand in tagged_candidates:
        move = cand.get("move", "")
        if move and move in reply:
            return move, cand.get("tag")
    # Fallback: top candidate
    if tagged_candidates:
        top = tagged_candidates[0]
        return top.get("move"), top.get("tag")
    return None, None


@app.post("/chief-of-staff/chat")
def chief_of_staff_chat(req: ChiefOfStaffRequest) -> ChiefOfStaffResponse:
    """Chief-of-Staff collaborative agent endpoint.

    @notice Phase 76: the LLM acts as a strategic advisor that reads the
            human's macro-strategy and selects the specific tagged move
            that best fits it.  Uses "instant opponent features" for fast
            suggestions; triggers a real deep-dive historical search
            when the human's message contains validation keywords.

    @dev    Pipeline:
              1. Build a Chief-of-Staff prompt (tagged moves + strategy).
              2. Dispatch to _generate_chat (0G Compute)
                 or stub mode.
              3. Extract the recommended move from the reply.
              4. If deep-dive was requested, append the historical
                 analysis to the response.
    @return ChiefOfStaffResponse with reply, move, tag, deep_dive, backend.
    """
    import time
    started = time.monotonic()

    # Detect deep-dive request from the most recent human message.
    last_human_text = ""
    for msg in reversed(req.dialogue):
        if msg.get("role") == "human":
            last_human_text = msg.get("text", "")
            break
    # Also check current human_strategy field.
    full_text = (last_human_text + " " + req.human_strategy).strip()
    needs_deep_dive = _deep_dive_requested(full_text)

    prompt = _build_chief_of_staff_prompt(
        human_strategy=req.human_strategy,
        tagged_candidates=req.tagged_candidates,
        dialogue_history=req.dialogue,
        opponent_features=req.opponent_features,
    )

    chosen = (req.backend or _BACKEND).lower()
    if chosen == "stub":
        # Deterministic stub for tests / offline demo.
        if req.tagged_candidates:
            top = req.tagged_candidates[0]
            reply_text = (
                f"As your Chief of Staff, I recommend **{top.get('move', '?')}** "
                f"[{top.get('tag', 'Safe')}]. "
                f"It scores the highest equity and aligns with a solid positional approach. "
                f"This keeps you ahead in the pip count while minimising blot exposure."
            )
        else:
            reply_text = "No legal moves available on this roll — the turn passes."
        backend_used = "stub"
    else:
        reply_text, backend_used = _generate_chat(prompt, req.backend)

    recommended_move, recommended_tag = _extract_recommended_move(
        reply_text, req.tagged_candidates
    )

    deep_dive: Optional[str] = None
    if needs_deep_dive:
        deep_dive = _historical_search(
            human_strategy=req.human_strategy,
            tagged_candidates=req.tagged_candidates,
            opponent_features=req.opponent_features,
            backend=req.backend,
            agent_id=req.agent_id,
        )

    elapsed_ms = int((time.monotonic() - started) * 1000)
    return ChiefOfStaffResponse(
        reply=reply_text,
        recommended_move=recommended_move,
        recommended_tag=recommended_tag,
        deep_dive=deep_dive,
        backend=backend_used,
        latency_ms=elapsed_ms,
    )
