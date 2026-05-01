"""
coach_service.py — local FastAPI agent process: LLM coaching hints.

@notice Run as a plain HTTP service on the player's own machine on a
        separate port from gnubg_service. The browser hits localhost:8002
        directly via fetch. Start with:

          uvicorn coach_service:app --port 8002

@dev    Endpoint:
          POST /hint — generate a plain-English coaching hint for the current
                       turn, given the ranked candidates from gnubg_service.

        Inference backend (priority):
          1. 0G Compute Network — Qwen 2.5 7B Instruct via
             @0glabs/0g-serving-broker. Sponsor-aligned (verifiable inference,
             pay-per-token from a 0G ledger). Routed through the Node bridge
             at og-compute-bridge/ so this Python service does not need to
             port the JS SDK.
          2. Local flan-t5-base — fallback when 0G Compute is unreachable
             (testnet down, wallet unfunded, network outage). Lower quality
             but keeps the demo alive. Forced via COACH_BACKEND=local.

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

# COACH_BACKEND: "compute" (default — try 0G first, fall back on error),
# "local" (force flan-t5-base), or "compute-only" (raise on compute failure;
# useful in CI when we want to guarantee the live path works).
_BACKEND = os.environ.get("COACH_BACKEND", "compute").lower()

_local_model = None
_local_tokenizer = None


def _load_local_model() -> None:
    """Lazy-load flan-t5-base for the local fallback path. Called on first
    fallback only — the import alone costs >1s and ~250 MB RAM, so we defer
    it until we actually need it.

    @dev Newer transformers (>= 4.40) removed `T5ForConditionalGeneration`
         and `T5Tokenizer` from the top-level namespace. Use the Auto*
         wrappers, which resolve to the same classes and are forward-
         compatible.
    """
    global _local_model, _local_tokenizer
    if _local_model is None:
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        _local_tokenizer = AutoTokenizer.from_pretrained("google/flan-t5-base")
        _local_model = AutoModelForSeq2SeqLM.from_pretrained("google/flan-t5-base")


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

    Returned in chat-completion shape so the same payload feeds either the
    0G Compute path (Qwen) or the local flan-t5-base path (after we collapse
    it back into a single prompt string).

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


def _generate_local(
    dice: list[int],
    candidates: list[dict],
    docs_context: str,
    profile: AgentProfile,
) -> str:
    """Local fallback — flan-t5-base seq2seq generation."""
    _load_local_model()
    system, messages = _build_messages(dice, candidates, docs_context, profile)
    # flan-t5 is a single-prompt seq2seq model — concatenate.
    prompt = system + "\n\n" + messages[0]["content"]
    inputs = _local_tokenizer(prompt, return_tensors="pt", max_length=512, truncation=True)
    outputs = _local_model.generate(**inputs, max_new_tokens=120)
    return _local_tokenizer.decode(outputs[0], skip_special_tokens=True).strip()


def _generate(
    dice: list[int],
    candidates: list[dict],
    docs_context: str,
    profile: AgentProfile,
    backend: Optional[str] = None,
) -> tuple[str, str]:
    """Run inference with the requested backend (or the server default).

    @param backend  Per-request override. None → use COACH_BACKEND env.
    @return (hint_text, backend_used) — backend_used is "compute" or "local"
            so the response can surface which path served the request.
    """
    chosen = (backend or _BACKEND).lower()
    if chosen == "local":
        return _generate_local(dice, candidates, docs_context, profile), "local"
    try:
        return _generate_compute(dice, candidates, docs_context, profile), "compute"
    except Exception as e:
        if chosen == "compute-only":
            raise
        # Fall back to the local model and keep going. The frontend never
        # sees the compute error — the demo stays online.
        import logging
        logging.getLogger(__name__).warning(
            "0G Compute coach failed (%s); falling back to local flan-t5.", e
        )
        return _generate_local(dice, candidates, docs_context, profile), "local"


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
                               One of "compute" (paid 0G inference, falls back
                               to local on failure), "local" (free flan-t5),
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
              3. Run inference on 0G Compute (Qwen 2.5 7B) — fall back to
                 local flan-t5-base if compute is unreachable.
    @return {"hint": str, "backend": "compute"|"local"}
    """
    docs_context = _fetch_docs(req.docs_hash)
    profile = load_profile(req.agent_weights_hash)
    hint, backend = _generate(
        req.dice, req.candidates, docs_context, profile, backend=req.backend
    )
    return {"hint": hint, "backend": backend}


# ─── /chat endpoint ─────────────────────────────────────────────────────────
#
# Phase A landed the deterministic stub. Phase B (this commit) wires the
# real LLM path: build_chat_prompt → 0G Compute (Qwen 2.5 7B) with flan-
# t5 local fallback, mirroring `/hint`'s _generate_compute / _generate_
# local / _generate selector. The stub stays callable so tests that
# assert on deterministic output keep working — they pass
# `backend="stub"` in the request.


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


def _generate_chat_local(prompt: str) -> str:
    """Local fallback for /chat — flan-t5-base seq2seq on the same prompt.

    flan-t5 is a single-prompt seq2seq model; concatenate the system
    prompt and the user message into one input sequence. Mirrors the
    existing `_generate_local` for /hint.
    """
    _load_local_model()
    text = _CHAT_SYSTEM_PROMPT + "\n\n" + prompt
    inputs = _local_tokenizer(
        text, return_tensors="pt", max_length=1024, truncation=True
    )
    outputs = _local_model.generate(**inputs, max_new_tokens=160)
    return _local_tokenizer.decode(
        outputs[0], skip_special_tokens=True
    ).strip()


def _generate_chat(
    prompt: str, backend: Optional[str] = None
) -> tuple[str, str]:
    """Run /chat inference with the requested backend (or the server default).

    Selection rules mirror `_generate` for /hint:
      - backend == "local"        → local flan-t5 only
      - backend == "compute-only" → 0G Compute; raise on failure
      - backend in ("compute", None) → 0G Compute, fall back to local on error
    `backend == "stub"` is handled by `post_chat` directly and never
    reaches this function.
    """
    chosen = (backend or _BACKEND).lower()
    if chosen == "local":
        return _generate_chat_local(prompt), "local"
    try:
        return _generate_chat_compute(prompt), "compute"
    except Exception as e:
        if chosen == "compute-only":
            raise
        import logging
        logging.getLogger(__name__).warning(
            "0G Compute /chat failed (%s); falling back to local flan-t5.", e
        )
        return _generate_chat_local(prompt), "local"


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
            `_generate_chat` (0G Compute → flan-t5 local fallback)
            or, when `backend == "stub"`, to the deterministic
            `_stub_chat_reply` used by tests. Same backend-selection
            shape as the existing `/hint` endpoint.

    @dev    Pipeline:
              1. build_chat_prompt(req) — pure function, deterministic.
              2. dispatch to LLM (compute → local fallback) or stub.
              3. Update per-session preferences from the human's last
                 message (if any) and emit the delta in the response.
            The pipeline lives entirely outside the LLM call so the
            preference-update logic is testable without a model.
    @return ChatResponse(message, backend, preferences_delta, latency_ms)
    """
    import time
    started = time.monotonic()

    prompt = build_chat_prompt(req)

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
