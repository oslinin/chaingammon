"""
Agent experience overlay (Phase 9).

Every agent iNFT carries a small per-agent preference vector — the
"experience overlay" — that biases gnubg's move recommendations and
grows after every match. The overlay's bytes go to 0G Storage; the
resulting Merkle hash sits at `dataHashes[1]` of the agent iNFT.

Two iNFTs minted at the same `tier` with the same shared base weights
will play identically *out of the box*, then drift into measurably
different styles as their match histories diverge. That divergence is
what makes the iNFT meaningful as an asset rather than a label.

What this module does:
  - Defines the canonical category list (`CATEGORIES`).
  - `Overlay` — the dataclass uploaded to 0G Storage.
  - `classify_move(move) → {category: score}` — hand-coded heuristics
    that read a gnubg-format move string and emit category scores in
    [0, 1]. v2 will replace with a learned classifier.
  - `apply_overlay(candidates, overlay) → ranked` — re-rank gnubg's
    candidate moves by `gnubg_equity + sum(v[c] * classifier_c(move))`.
    Picks `argmax(biased_score)`; with a zero overlay this is a no-op.
  - `update_overlay(overlay, agent_moves, won, match_count) → new` —
    exposure-weighted, outcome-driven, damped reinforcement.

What this module is NOT doing:
  - Position evaluation — gnubg still does that, the network stays frozen.
  - Move legality / dice math / bear-off mechanics — gnubg handles those.
  - New strategies outside the predefined categories. The category list
    is hand-coded; v2 may extend it but won't synthesize new dimensions.
  - Opponent modeling. Updates depend only on the agent's own match.
  - Anything requiring backprop or a real RL loop.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Mapping, Optional


# Canonical category list. Keep stable — changes invalidate every existing
# overlay blob on 0G Storage. Adding new categories at the end is safe;
# `Overlay.default()` zero-fills new ones, and old blobs round-trip without
# carrying them (they re-fill to 0 on `from_bytes`).
CATEGORIES: tuple[str, ...] = (
    # Opening style — what shape does the agent prefer to build first?
    "opening_slot",
    "opening_split",
    "opening_builder",
    "opening_anchor",
    # Specific point-building moves (the most distinguishable v1 signal).
    "build_5_point",
    "build_bar_point",
    # Bear-off timing and risk.
    "bearoff_efficient",
    "bearoff_safe",
    # Risk profile when on offence.
    "risk_hit_exposure",
    "risk_blot_leaving",
    "hits_blot",
    # Back-checker handling — running vs anchoring.
    "runs_back_checker",
    "anchors_back",
    # Game-phase preferences (which kinds of games the agent tends to play).
    "phase_prime_building",
    "phase_race_conversion",
    "phase_back_game",
    "phase_holding_game",
    "phase_blitz",
    # Cube actions (currently un-tracked because the cube flow isn't
    # wired through any endpoint; classifiers always return 0 in v1).
    "cube_offer_aggressive",
    "cube_take_aggressive",
)


LEARNING_RATE = 0.05
DAMPING_N = 20

CURRENT_OVERLAY_VERSION = 1


class OverlayError(RuntimeError):
    """Wraps any overlay schema / serialization failure."""


@dataclass(frozen=True)
class Overlay:
    """Agent's accumulated playing-style bias. Uploaded to 0G Storage as
    canonical UTF-8 JSON, sorted keys."""

    version: int
    values: Mapping[str, float]
    match_count: int

    def __post_init__(self) -> None:
        if self.version != CURRENT_OVERLAY_VERSION:
            raise OverlayError(f"unknown overlay version: {self.version}")
        if self.match_count < 0:
            raise OverlayError(f"match_count must be non-negative, got {self.match_count}")

        unknown = set(self.values.keys()) - set(CATEGORIES)
        if unknown:
            raise OverlayError(f"unknown category in overlay: {sorted(unknown)}")
        missing = set(CATEGORIES) - set(self.values.keys())
        if missing:
            raise OverlayError(f"missing categories in overlay: {sorted(missing)}")

        # Clip values into [-1, 1]. We use object.__setattr__ because the
        # dataclass is frozen — clipping at construction is an invariant,
        # not a mutation.
        clipped = {c: max(-1.0, min(1.0, float(self.values[c]))) for c in CATEGORIES}
        object.__setattr__(self, "values", clipped)

    @classmethod
    def default(cls) -> "Overlay":
        return cls(
            version=CURRENT_OVERLAY_VERSION,
            values={c: 0.0 for c in CATEGORIES},
            match_count=0,
        )

    def to_bytes(self) -> bytes:
        """Canonical JSON encoding. Sorted keys → deterministic bytes →
        deterministic Merkle root on 0G Storage."""
        envelope = {
            "version": self.version,
            "match_count": self.match_count,
            "values": {c: self.values[c] for c in CATEGORIES},
        }
        return json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode("utf-8")

    @classmethod
    def from_bytes(cls, blob: bytes) -> "Overlay":
        try:
            parsed = json.loads(blob.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise OverlayError(f"overlay blob is not valid UTF-8 JSON: {e}") from e
        try:
            return cls(
                version=int(parsed["version"]),
                values={c: float(parsed["values"].get(c, 0.0)) for c in CATEGORIES},
                match_count=int(parsed["match_count"]),
            )
        except (KeyError, TypeError, ValueError) as e:
            raise OverlayError(f"malformed overlay envelope: {e}") from e


# ---------------------------------------------------------------------------
# Move classification
# ---------------------------------------------------------------------------


# Match a single per-checker movement: source/dest, possibly with hit "*".
# Source is digits, "bar", or 24-letter; dest is digits, "off", or hit-marked.
_MOVE_PIECE = re.compile(r"(\d+|bar)/(\d+|off)(\*?)", re.IGNORECASE)


def _parse_move(move_str: str) -> list[tuple[str, str, bool]]:
    """Return [(source, dest, hit), ...] for each checker movement.
    `source` and `dest` are strings (gnubg's notation), `hit` is True if
    the move marker was suffixed with `*`."""
    pieces = []
    for src, dst, hit_marker in _MOVE_PIECE.findall(move_str):
        pieces.append((src.lower(), dst.lower(), bool(hit_marker)))
    return pieces


def classify_move(move) -> dict[str, float]:
    """Return `{category: score in [0, 1]}` for one MoveEntry-like value.

    `move` is duck-typed against `app.game_record.MoveEntry` — only `.move`
    and `.dice` are read.
    """
    pieces = _parse_move(getattr(move, "move", "") or "")
    scores = {c: 0.0 for c in CATEGORIES}
    if not pieces:
        return scores

    for src, dst, hit in pieces:
        # Hits.
        if hit:
            scores["hits_blot"] = min(1.0, scores["hits_blot"] + 1.0 / len(pieces))

        # Bear-off (gnubg notation: dst = "off").
        if dst == "off":
            scores["bearoff_efficient"] = min(1.0, scores["bearoff_efficient"] + 1.0 / len(pieces))

        # Specific point-building.
        if dst == "5":
            scores["build_5_point"] = min(1.0, scores["build_5_point"] + 1.0 / len(pieces))
        elif dst == "7":
            scores["build_bar_point"] = min(1.0, scores["build_bar_point"] + 1.0 / len(pieces))

        # Running back checkers (gnubg's player-1 perspective: source 24).
        if src == "24":
            scores["runs_back_checker"] = min(
                1.0, scores["runs_back_checker"] + 1.0 / len(pieces)
            )

        # Coming off the bar.
        if src == "bar":
            scores["risk_hit_exposure"] = min(
                1.0, scores["risk_hit_exposure"] + 0.5 / len(pieces)
            )

    # Same-destination pieces → making a point (anchor / safe play).
    dests = [dst for _, dst, _ in pieces if dst not in ("off",)]
    if len(dests) == 2 and dests[0] == dests[1]:
        # Two checkers landed on the same point — a "made point".
        if dests[0] in ("20", "21", "22", "23", "24"):
            scores["anchors_back"] = 1.0
        else:
            scores["bearoff_safe"] = max(scores["bearoff_safe"], 0.5)
            scores["opening_anchor"] = max(scores["opening_anchor"], 0.5)

    # Slot vs split openings — characterized by leaving a single checker
    # in a builder spot vs splitting back checkers.
    if len(pieces) == 2:
        srcs = [src for src, _, _ in pieces]
        if srcs == ["24", "13"] or srcs == ["13", "24"]:
            scores["opening_split"] = 1.0
        if any(dst == "5" for _, dst, _ in pieces) and "8" in srcs:
            scores["opening_slot"] = max(scores["opening_slot"], 0.7)
        if any(dst in ("4", "5", "7", "9") for _, dst, _ in pieces) and not any(
            dst == s for _, dst, _ in pieces for s in srcs
        ):
            scores["opening_builder"] = max(scores["opening_builder"], 0.4)

    return scores


# ---------------------------------------------------------------------------
# apply_overlay — bias gnubg's candidate ranking by the agent's overlay
# ---------------------------------------------------------------------------


def _candidate_score(candidate: Mapping, overlay: Overlay) -> float:
    """`gnubg_equity + sum(v[c] * classifier_c(move))`."""
    move_str = candidate.get("move", "")
    base = float(candidate.get("equity", 0.0))
    if not move_str:
        return base
    fake = type("M", (), {"move": move_str, "dice": []})()  # duck-type for classify_move
    cls = classify_move(fake)
    bias = sum(overlay.values[c] * cls[c] for c in CATEGORIES)
    return base + bias


def apply_overlay(candidates: list[Mapping], overlay: Overlay) -> list[Mapping]:
    """Re-rank gnubg's candidates by `equity + overlay-bias`. Returns a
    new list sorted descending by biased score; the caller picks `[0]`
    as the chosen move."""
    if not candidates:
        return []
    scored = [(c, _candidate_score(c, overlay)) for c in candidates]
    scored.sort(key=lambda x: x[1], reverse=True)
    return [c for c, _ in scored]


# ---------------------------------------------------------------------------
# update_overlay — post-match learning step
# ---------------------------------------------------------------------------


def update_overlay(
    overlay: Overlay,
    agent_moves: list,
    won: bool,
    match_count: int,
    *,
    learning_rate: float = LEARNING_RATE,
    damping_n: int = DAMPING_N,
) -> Overlay:
    """Apply the post-match update rule:

      1. Compute per-category exposure across the agent's moves.
      2. Outcome signal: +1 win / -1 loss.
      3. Proposed delta = LEARNING_RATE * outcome * exposure[c].
      4. Damping: alpha = N / (N + match_count); blend old → proposed by alpha.
      5. Clip to [-1, 1].

    `overlay` is the agent's pre-match overlay; `match_count` is the
    pre-match count (Overlay.match_count). The returned overlay has
    `match_count + 1` matches.
    """
    # Step 1: exposure
    exposure = {c: 0.0 for c in CATEGORIES}
    for m in agent_moves:
        cls = classify_move(m)
        for c in CATEGORIES:
            exposure[c] += cls[c]
    total = sum(exposure.values())
    if total > 0:
        exposure = {c: x / total for c, x in exposure.items()}
    # else: no signal to apply — exposure stays all-zero, deltas are zero.

    # Step 2: outcome
    outcome = 1.0 if won else -1.0

    # Step 3 + 4: damped reinforcement
    alpha = damping_n / (damping_n + match_count)
    new_values = {}
    for c in CATEGORIES:
        proposed = overlay.values[c] + learning_rate * outcome * exposure[c]
        new_values[c] = (1.0 - alpha) * overlay.values[c] + alpha * proposed
        # Overlay.__post_init__ also clips; this clip keeps the math local.
        new_values[c] = max(-1.0, min(1.0, new_values[c]))

    return Overlay(
        version=overlay.version,
        values=new_values,
        match_count=overlay.match_count + 1,
    )
