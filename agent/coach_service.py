"""
coach_service.py — AXL agent node: LLM coaching hints.

@notice Exposed via AXL (Gensyn Agent eXchange Layer) as an A2A service on a
        separate port from gnubg_service. Run alongside AXL:

          uvicorn coach_service:app --port 8002

@dev    Endpoint:
          POST /hint — generate a plain-English coaching hint for the current
                       turn, given the ranked candidates from gnubg_service.

        docs_hash:  0G Storage root hash of the gnubg strategy doc uploaded by
                    scripts/upload_gnubg_docs.py. Used as RAG context. Falls
                    back to a built-in brief if the hash is empty or the blob
                    is unavailable.

        Model: flan-t5-base (Google, Apache-2.0). Loaded lazily on the first
        /hint request so the service starts fast. ~250 MB download on first
        run; cached by the transformers library in ~/.cache/huggingface.
"""

from __future__ import annotations
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Chaingammon Coach Agent")

_model = None
_tokenizer = None


def _load_model() -> None:
    """Lazy-load flan-t5-base. Called once per process on first /hint request.

    @dev Uses module-level globals so the ~250 MB model is loaded only once and
         reused across requests. Import is deferred here (not at module top) to
         avoid paying the transformers import cost when the service is not used.
    """
    global _model, _tokenizer
    if _model is None:
        from transformers import T5ForConditionalGeneration, T5Tokenizer
        _tokenizer = T5Tokenizer.from_pretrained("google/flan-t5-base")
        _model = T5ForConditionalGeneration.from_pretrained("google/flan-t5-base")


def _fetch_docs(docs_hash: str) -> str:
    """Fetch the gnubg strategy doc from 0G Storage by root hash.

    @notice Provides RAG context for the coach LLM. The doc is uploaded once
            by scripts/upload_gnubg_docs.py and its hash stored in the frontend
            config; it does not change per-match.
    @dev    Returns a built-in fallback string if the hash is empty or the blob
            is unreachable (network down, SDK unavailable). The fallback covers
            the most important opening principles so the coach is always at
            least plausible even offline.
    @param  docs_hash  0G Storage Merkle root hash (32-byte hex) of the gnubg
                       strategy document blob. Empty string triggers fallback.
    @return            UTF-8 strategy text to inject into the LLM prompt, or
                       the hardcoded fallback on any error.
    """
    _FALLBACK = "Backgammon: build primes, anchor on the 5-point, avoid blots."
    if not docs_hash:
        return _FALLBACK
    try:
        # 0G Storage Python SDK — verify import path against current SDK docs.
        from zg_storage import download  # type: ignore[import]
        return download(docs_hash).decode("utf-8", errors="replace")
    except Exception:
        return _FALLBACK


def _generate(dice: list[int], candidates: list[dict], docs_context: str) -> str:
    """Run flan-t5-base inference to produce a one-to-two-sentence coaching hint.

    @notice The hint explains why the top-ranked move is good in plain English,
            grounded in the strategy doc fetched from 0G Storage.
    @dev    Prompt structure: strategy context + dice roll + ranked moves with
            equity values. max_new_tokens is capped at 80 to keep hints concise
            and within the model's generation comfort zone.
    @param  dice          Two-element list [d1, d2] for the current roll.
    @param  candidates    Top-ranked moves from gnubg_service /evaluate, each
                          {"move": str, "equity": float}.
    @param  docs_context  Strategy text from 0G Storage (or fallback) to use
                          as prompt context.
    @return               Plain-English coaching hint string.
    """
    _load_model()
    top3 = candidates[:3]
    moves_text = "; ".join(
        f"{c['move']} (equity {c['equity']:+.3f})" for c in top3
    )
    prompt = (
        f"You are a backgammon coach. Context: {docs_context} "
        f"The player rolled {dice[0]} and {dice[1]}. "
        f"gnubg ranked these moves: {moves_text}. "
        f"In 1-2 sentences, explain why the best move is good."
    )
    inputs = _tokenizer(prompt, return_tensors="pt", max_length=512, truncation=True)
    outputs = _model.generate(**inputs, max_new_tokens=80)
    return _tokenizer.decode(outputs[0], skip_special_tokens=True)


# ─── request / response models ───────────────────────────────────────────────

class HintRequest(BaseModel):
    """Request body for POST /hint.

    @param position_id  gnubg base64 position identifier (passed through for
                        context; not used directly by the LLM).
    @param match_id     gnubg base64 match-state identifier (passed through).
    @param dice         Two-element list [d1, d2] for the current roll.
    @param candidates   Ranked move list from gnubg_service /evaluate, each
                        {"move": str, "equity": float}. Top 3 are used.
    @param docs_hash    0G Storage root hash of the gnubg strategy doc; empty
                        string triggers the built-in fallback context.
    """

    position_id: str
    match_id: str
    dice: list[int]
    candidates: list[dict]
    docs_hash: str = ""


# ─── endpoint ────────────────────────────────────────────────────────────────

@app.post("/hint")
def get_hint(req: HintRequest) -> dict:
    """Generate a coaching hint from gnubg equity output.

    @notice Called by the frontend after every move to narrate the turn. The
            frontend shows a "Thinking…" placeholder until the hint arrives;
            this endpoint is intentionally non-blocking from the game's
            perspective.
    @dev    Fetches gnubg strategy docs from 0G Storage (or falls back to
            built-in), then runs flan-t5-base to produce a human-readable
            explanation of the best move.
    @param  req  HintRequest with position, match state, dice, candidates,
                 and optional 0G Storage docs hash.
    @return      {"hint": str} — one to two plain-English sentences.
    """
    docs_context = _fetch_docs(req.docs_hash)
    hint = _generate(req.dice, req.candidates, docs_context)
    return {"hint": hint}
