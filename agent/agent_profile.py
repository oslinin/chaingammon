"""
agent_profile.py — agent style/bias summarization for the LLM coach.

@notice The coach is most useful when it can ground its hints in *this
        specific agent's* tendencies — not just generic backgammon advice.
        Different agents drift into different styles (one prefers prime-
        building, another runs back checkers, another plays a holding
        game), and the human deserves to know which one is across the
        table from them.

@dev    The coach should not need to care HOW an agent's biases are
        encoded. v1 (master) uses a hand-coded category vector — the
        Phase 9 overlay — uploaded to 0G Storage. The `learn` branch
        replaces this with a trained PyTorch network whose biases live
        as weight statistics, training metadata, and policy traces.
        Both representations need to surface as the same thing to the
        coach prompt: a short English description of the agent's
        playing style.

        This module defines an `AgentProfile` interface plus a factory
        that dispatches on the data shape stored at a 0G Storage hash.
        Adding the learn-branch model checkpoint shape later is a
        matter of writing one new subclass and adding one branch to
        `load_profile`.

@design  Why an interface and not just a function?
         - Future profile types may be expensive to construct (model
           load, eigenvalue decomposition, policy rollout). Returning
           an object lets us cache that work across calls in one
           process.
         - Different profiles surface different *secondary* metadata
           (match count, model checkpoint version, training reward
           curve). Exposing `.metrics()` keeps that available for logs
           without polluting the prompt.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Mapping, Optional


class AgentProfileError(RuntimeError):
    """Wraps any error parsing or summarizing an agent profile blob."""


class AgentProfile(ABC):
    """Abstract base — describes an agent's playing biases to the coach."""

    @abstractmethod
    def summarize(self) -> str:
        """Return a short (≤ 240 char) English description of this agent's
        tendencies, suitable for inclusion in the coach prompt.

        Empty / zero-bias profiles return a neutral description like
        "no measurable style yet" so the coach knows not to over-claim.
        """

    @abstractmethod
    def metrics(self) -> Mapping[str, object]:
        """Structured profile data for logging and debugging. Not used in
        the prompt. Implementations decide what fields are meaningful."""


# ─── implementations ─────────────────────────────────────────────────────────


class NullProfile(AgentProfile):
    """Cold-start agent — no overlay or model yet on 0G Storage. Used when
    the agent_weights_hash is empty or the blob is unreachable."""

    def summarize(self) -> str:
        return "This agent is fresh — no measurable playing style yet."

    def metrics(self) -> Mapping[str, object]:
        return {"kind": "null"}


class OverlayProfile(AgentProfile):
    """Reads the Phase 9 experience overlay (hand-coded category vector
    uploaded to 0G Storage as canonical JSON). Highlights the top biases
    by absolute value to keep the summary short."""

    # Map raw category names to short, prompt-friendly phrases. Keep
    # plural/verb agreement so the summarization template reads well.
    _CATEGORY_PHRASES: Mapping[str, str] = {
        "opening_slot": "slotting on the opening roll",
        "opening_split": "splitting back checkers in the opening",
        "opening_builder": "playing builders in the opening",
        "opening_anchor": "making an anchor early",
        "build_5_point": "building the 5-point",
        "build_bar_point": "building the bar point",
        "bearoff_efficient": "bearing off efficiently",
        "bearoff_safe": "bearing off safely",
        "risk_hit_exposure": "leaving exposed checkers",
        "risk_blot_leaving": "leaving blots",
        "hits_blot": "hitting blots",
        "runs_back_checker": "running back checkers",
        "anchors_back": "holding deep anchors",
        "phase_prime_building": "building primes",
        "phase_race_conversion": "playing the race",
        "phase_back_game": "playing back games",
        "phase_holding_game": "playing holding games",
        "phase_blitz": "playing blitzes",
        "cube_offer_aggressive": "offering the cube aggressively",
        "cube_take_aggressive": "taking the cube aggressively",
    }

    # Below this absolute value we treat a category as noise rather than
    # a meaningful preference. Tuned to overlay's update rule (LR=0.05,
    # damping=20) — even after dozens of matches the typical magnitude
    # is < 0.2, so 0.05 separates signal from initialization noise.
    _SIGNIFICANCE_THRESHOLD = 0.05

    def __init__(self, values: Mapping[str, float], match_count: int) -> None:
        self._values = dict(values)
        self._match_count = int(match_count)

    def summarize(self) -> str:
        if self._match_count == 0:
            return "This agent has just been minted — its style is still neutral."
        top = sorted(
            self._values.items(), key=lambda kv: abs(kv[1]), reverse=True
        )[:3]
        # Drop categories with vanishingly small magnitudes — they
        # would fabricate biases the agent doesn't actually have.
        biases: list[str] = []
        for category, value in top:
            if abs(value) < self._SIGNIFICANCE_THRESHOLD:
                continue
            phrase = self._CATEGORY_PHRASES.get(category, category)
            modifier = "favors" if value > 0 else "avoids"
            biases.append(f"{modifier} {phrase}")
        if not biases:
            return f"After {self._match_count} matches this agent has no strong style yet."
        joined = "; ".join(biases)
        return (
            f"After {self._match_count} matches this agent's tendencies are: {joined}."
        )

    def metrics(self) -> Mapping[str, object]:
        return {
            "kind": "overlay",
            "match_count": self._match_count,
            "values": dict(self._values),
        }

    @classmethod
    def from_bytes(cls, blob: bytes) -> "OverlayProfile":
        """Parse the canonical overlay JSON envelope.

        @dev We accept any envelope that has `values` (mapping) and
             `match_count`; we do NOT enforce the strict CATEGORIES list
             from server/app/agent_overlay.py. The coach should keep
             working even if the overlay schema is bumped in a way the
             coach hasn't been redeployed for — unknown keys are
             surfaced as-is via _CATEGORY_PHRASES fallback.
        """
        import json  # local — keeps module-level imports light
        try:
            parsed = json.loads(blob.decode("utf-8"))
            values = {str(k): float(v) for k, v in parsed.get("values", {}).items()}
            match_count = int(parsed.get("match_count", 0))
        except (json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError, ValueError) as e:
            raise AgentProfileError(f"malformed overlay blob: {e}") from e
        return cls(values, match_count)


class ModelProfile(AgentProfile):
    """Stub for the `learn` branch's PyTorch BackgammonNet checkpoints.

    @notice Not implemented in master. The intent is documented here so
            the coach interface is stable when the agent migrates: the
            checkpoint metadata (training matches played, win rate vs
            random, weight statistics) gets parsed and rendered as a
            short prompt-friendly description.
    @dev    A future commit will:
              1. Parse the checkpoint envelope (metadata header + state_dict).
              2. Pull match_count, win_rate, opening_repertoire_summary.
              3. Format as "Trained for N matches; wins X% vs random; tends to <opening>."
            Until then, instantiating this class returns a placeholder
            summary so the coach doesn't 500.
    """

    def __init__(self, metadata: Mapping[str, object]) -> None:
        self._metadata = dict(metadata)

    def summarize(self) -> str:
        match_count = self._metadata.get("match_count", "?")
        return (
            f"This agent is a trained value network "
            f"(checkpoint after {match_count} self-play matches)."
        )

    def metrics(self) -> Mapping[str, object]:
        return {"kind": "model", **self._metadata}


# ─── factory ─────────────────────────────────────────────────────────────────


def load_profile(
    agent_weights_hash: str,
    *,
    fetch: Optional[callable] = None,
) -> AgentProfile:
    """Resolve an agent profile from a 0G Storage Merkle root.

    @notice Returns a NullProfile on any unreachable / unparseable input
            so the coach degrades gracefully — the hint is still useful
            even if the overlay can't be fetched (e.g. testnet down).
    @dev    Dispatch is content-sniffing: try OverlayProfile.from_bytes
            first (current Phase 9 shape); fall through to NullProfile
            on any error. Future model checkpoints will add a
            ModelProfile detection branch keyed on a magic-byte header
            so older overlay JSON keeps working.
    @param  agent_weights_hash  0G Storage Merkle root (hex). Empty →
                                NullProfile (cold start).
    @param  fetch               Optional callable(hash: str) -> bytes.
                                Defaults to the og-bridge get_blob.
                                Injected for tests and to keep this
                                module decoupled from the storage SDK.
    """
    if not agent_weights_hash:
        return NullProfile()
    if fetch is None:
        try:
            from server.app.og_storage_client import get_blob  # type: ignore[import]
            fetch = get_blob
        except ImportError:
            return NullProfile()
    try:
        blob = fetch(agent_weights_hash)
    except Exception:
        return NullProfile()
    if not blob:
        return NullProfile()
    # Content-sniff: overlay is JSON, future checkpoints will be tagged.
    # If the first non-whitespace byte is `{`, treat as overlay JSON.
    head = blob.lstrip()[:1]
    if head == b"{":
        try:
            return OverlayProfile.from_bytes(blob)
        except AgentProfileError:
            return NullProfile()
    # Future: detect model checkpoint magic bytes here.
    return NullProfile()
