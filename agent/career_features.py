"""career_features.py — contextual feature encoder for the value net.

The trainer's `BackgammonNet` exposes an `extras` head that consumes a
fixed-dimension vector alongside the gnubg board features.

Three encoding layouts are supported, selected by the `dim` argument to
`encode_career_context`:

  dim < 40  (legacy 16-d layout):
    [0:6]    opponent_style projection — 6 STYLE_AXES
    [6:12]   teammate_style projection — zero when teammate_style is None
    [12]     log1p(stake_wei) / 70, clamped to [0, 1]
    [13]     tournament_position, clamped to [-1, 1]
    [14]     1.0 if is_team_match else 0.0
    [15]     1.0  bias ones-channel

  40 <= dim < 58  (40-d layout — self+opponent, no teammate):
    [0:18]   self_style projection — 18 ACTIVE_AXES (zero when None)
    [18:36]  opponent_style projection — 18 ACTIVE_AXES
    [36]     log1p(stake_wei) / 70, clamped to [0, 1]
    [37]     tournament_position, clamped to [-1, 1]
    [38]     1.0 if is_team_match else 0.0
    [39]     1.0  bias ones-channel

  dim >= 58  (58-d layout — self+opponent+teammate):
    [0:18]   self_style projection — 18 ACTIVE_AXES (zero when None)
    [18:36]  opponent_style projection — 18 ACTIVE_AXES
    [36:54]  teammate_style projection — 18 ACTIVE_AXES (zero when no teammate)
    [54]     log1p(stake_wei) / 70, clamped to [0, 1]
    [55]     tournament_position, clamped to [-1, 1]
    [56]     1.0 if is_team_match else 0.0
    [57]     1.0  bias ones-channel

`ACTIVE_AXES` = ALL_CATEGORIES[:18] — the 18 non-cube style categories that
the overlay classifier tracks (excludes cube_offer_aggressive,
cube_take_aggressive which have no v1 classifier).
"""
from __future__ import annotations

import math
import random
import re
from dataclasses import dataclass
from typing import Optional

import torch


STYLE_AXES: tuple[str, ...] = (
    "opening_slot",
    "phase_prime_building",
    "runs_back_checker",
    "phase_holding_game",
    "bearoff_efficient",
    "hits_blot",
)


# Full canonical category list — must mirror
# `server/app/agent_overlay.CATEGORIES` so both profile kinds (overlay
# JSON and trained model checkpoints) present the same axis set on
# /agents/{id}/profile. Keep order stable; appending is safe (the
# consumer sorts by |value|), but renaming or reordering will desync
# overlay blobs.
ALL_CATEGORIES: tuple[str, ...] = (
    "opening_slot",
    "opening_split",
    "opening_builder",
    "opening_anchor",
    "build_5_point",
    "build_bar_point",
    "bearoff_efficient",
    "bearoff_safe",
    "risk_hit_exposure",
    "risk_blot_leaving",
    "hits_blot",
    "runs_back_checker",
    "anchors_back",
    "phase_prime_building",
    "phase_race_conversion",
    "phase_back_game",
    "phase_holding_game",
    "phase_blitz",
    "cube_offer_aggressive",
    "cube_take_aggressive",
)

# The 18 non-cube style categories used in the 40-d extras layout and
# overlay EMA updates (excludes the last two cube categories).
ACTIVE_AXES: tuple[str, ...] = ALL_CATEGORIES[:18]

_MIN_DIM = 16
_STAKE_LOG_DIVISOR = 70.0
"""log1p(1e30) ≈ 69.08; divisor 70 maps stakes up to 1e30 wei into [0, 1]
without clamping. Larger stakes are clamped to 1.0 by the encoder."""


@dataclass(frozen=True)
class CareerContext:
    """Structured contextual inputs for one career-mode self-play match.

    `opponent_style`, `teammate_style`, and `self_style` are dicts keyed by
    axis name (a subset of `agent_overlay.CATEGORIES`); unknown keys are
    ignored and missing keys default to 0.0. Values are not range-checked
    here — the encoder clamps as needed.

    `self_style` is used only in the 40-d layout (dim >= 40); it carries the
    agent's own accumulated style overlay so the extras head can see both its
    own tendencies and the opponent's.
    """
    opponent_style: dict[str, float]
    teammate_style: Optional[dict[str, float]]
    stake_wei: int
    tournament_position: float
    is_team_match: bool
    self_style: Optional[dict[str, float]] = None


# ---------------------------------------------------------------------------
# Move classifier (mirrors server/app/agent_overlay.classify_move, restricted
# to ACTIVE_AXES — cube categories have no v1 classifier and stay 0).
# ---------------------------------------------------------------------------

_MOVE_PIECE_RE = re.compile(r"(\d+|bar)/(\d+|off)(\*?)", re.IGNORECASE)


def _parse_move_str(move_str: str) -> list[tuple[str, str, bool]]:
    pieces = []
    for src, dst, hit_marker in _MOVE_PIECE_RE.findall(move_str or ""):
        pieces.append((src.lower(), dst.lower(), bool(hit_marker)))
    return pieces


def classify_move_str(move_str: str) -> dict[str, float]:
    """Classify a move string into ACTIVE_AXES style scores in [0, 1].

    Mirrors `server/app/agent_overlay.classify_move` but takes a bare string
    instead of a MoveEntry-like object, and restricts output to ACTIVE_AXES
    (no cube categories).
    """
    pieces = _parse_move_str(move_str)
    scores: dict[str, float] = {c: 0.0 for c in ACTIVE_AXES}
    if not pieces:
        return scores
    n = len(pieces)

    for src, dst, hit in pieces:
        if hit:
            scores["hits_blot"] = min(1.0, scores["hits_blot"] + 1.0 / n)
        if dst == "off":
            scores["bearoff_efficient"] = min(1.0, scores["bearoff_efficient"] + 1.0 / n)
        if dst == "5":
            scores["build_5_point"] = min(1.0, scores["build_5_point"] + 1.0 / n)
        elif dst == "7":
            scores["build_bar_point"] = min(1.0, scores["build_bar_point"] + 1.0 / n)
        if src == "24":
            scores["runs_back_checker"] = min(1.0, scores["runs_back_checker"] + 1.0 / n)
        if src == "bar":
            scores["risk_hit_exposure"] = min(1.0, scores["risk_hit_exposure"] + 0.5 / n)

    dests = [dst for _, dst, _ in pieces if dst != "off"]
    if len(dests) == 2 and dests[0] == dests[1]:
        if dests[0] in ("20", "21", "22", "23", "24"):
            scores["anchors_back"] = 1.0
        else:
            scores["bearoff_safe"] = max(scores["bearoff_safe"], 0.5)
            scores["opening_anchor"] = max(scores["opening_anchor"], 0.5)

    if n == 2:
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
# Style projection helpers
# ---------------------------------------------------------------------------


def _project_style(style: Optional[dict[str, float]]) -> list[float]:
    """Project a style dict onto STYLE_AXES (6 axes, legacy layout).
    Returns a 6-element list. None → all zeros."""
    if style is None:
        return [0.0] * len(STYLE_AXES)
    return [max(-1.0, min(1.0, float(style.get(ax, 0.0)))) for ax in STYLE_AXES]


def _project_style_full(style: Optional[dict[str, float]]) -> list[float]:
    """Project a style dict onto ACTIVE_AXES (18 axes, new 40-d layout).
    Returns an 18-element list. None → all zeros."""
    if style is None:
        return [0.0] * len(ACTIVE_AXES)
    return [max(-1.0, min(1.0, float(style.get(ax, 0.0)))) for ax in ACTIVE_AXES]


def encode_career_context(ctx: CareerContext, *, dim: int = _MIN_DIM) -> torch.Tensor:
    """Project a `CareerContext` into a `dim`-d feature tensor.

    Raises `ValueError` if `dim < 16`.

    dim < 40:  legacy 16-d layout (opponent_style, teammate_style, context).
    40 <= dim < 58: 40-d layout (self_style, opponent_style, context — no teammate).
    dim >= 58: 58-d layout (self_style, opponent_style, teammate_style, context).
    """
    if dim < _MIN_DIM:
        raise ValueError(
            f"encode_career_context requires dim >= {_MIN_DIM}; got {dim}"
        )

    feat = torch.zeros(dim)

    if dim >= 58:
        # 58-d layout: [own_18 | opp_18 | teammate_18 | stake | tournament | is_team | bias]
        own = _project_style_full(ctx.self_style)
        opp = _project_style_full(ctx.opponent_style)
        team = _project_style_full(ctx.teammate_style)
        for i, v in enumerate(own):
            feat[i] = v
        for i, v in enumerate(opp):
            feat[18 + i] = v
        for i, v in enumerate(team):
            feat[36 + i] = v
        feat[54] = min(math.log1p(max(int(ctx.stake_wei), 0)) / _STAKE_LOG_DIVISOR, 1.0)
        feat[55] = max(-1.0, min(1.0, float(ctx.tournament_position)))
        feat[56] = 1.0 if ctx.is_team_match else 0.0
        feat[57] = 1.0
    elif dim >= 40:
        # 40-d layout: [own_18 | opp_18 | stake | tournament | is_team | bias]
        own = _project_style_full(ctx.self_style)
        opp = _project_style_full(ctx.opponent_style)
        for i, v in enumerate(own):
            feat[i] = v
        for i, v in enumerate(opp):
            feat[18 + i] = v
        feat[36] = min(math.log1p(max(int(ctx.stake_wei), 0)) / _STAKE_LOG_DIVISOR, 1.0)
        feat[37] = max(-1.0, min(1.0, float(ctx.tournament_position)))
        feat[38] = 1.0 if ctx.is_team_match else 0.0
        feat[39] = 1.0
    else:
        # Legacy 16-d layout: [opp_6 | teammate_6 | stake | tournament | is_team | bias]
        opp = _project_style(ctx.opponent_style)
        for i, v in enumerate(opp):
            feat[i] = v
        team = _project_style(ctx.teammate_style)
        for i, v in enumerate(team):
            feat[6 + i] = v
        feat[12] = min(math.log1p(max(int(ctx.stake_wei), 0)) / _STAKE_LOG_DIVISOR, 1.0)
        feat[13] = max(-1.0, min(1.0, float(ctx.tournament_position)))
        feat[14] = 1.0 if ctx.is_team_match else 0.0
        feat[15] = 1.0

    return feat


def _sample_style(rng: random.Random) -> dict[str, float]:
    """Sample a style dict over `STYLE_AXES` (6 axes)."""
    return {axis: rng.uniform(-1.0, 1.0) for axis in STYLE_AXES}


def _sample_style_full(rng: random.Random) -> dict[str, float]:
    """Sample a style dict over all `ACTIVE_AXES` (18 axes)."""
    return {axis: rng.uniform(-1.0, 1.0) for axis in ACTIVE_AXES}


def sample_career_context(
    rng: random.Random,
    *,
    force_team: Optional[bool] = None,
    self_style: Optional[dict[str, float]] = None,
    opponent_style: Optional[dict[str, float]] = None,
) -> CareerContext:
    """Draw a synthetic `CareerContext` for one career-mode self-play match.

    Distributions:
      self_style:          provided or uniform [-1, 1] per ACTIVE_AXES (18)
      opponent_style:      provided or uniform [-1, 1] per STYLE_AXES (6)
      teammate_style:      same as STYLE_AXES with prob 0.5 (else None)
      stake_wei:           log-uniform across [0, 1e21]
      tournament_position: uniform [-1, 1]
      is_team_match:       True iff teammate_style is not None (or forced)
    """
    has_teammate = force_team if force_team is not None else (rng.random() < 0.5)
    teammate_style = _sample_style_full(rng) if has_teammate else None
    log_stake = rng.uniform(0.0, math.log1p(10**21))
    stake_wei = max(0, int(math.expm1(log_stake)))
    return CareerContext(
        self_style=self_style if self_style is not None else _sample_style_full(rng),
        opponent_style=opponent_style if opponent_style is not None else _sample_style(rng),
        teammate_style=teammate_style,
        stake_wei=stake_wei,
        tournament_position=rng.uniform(-1.0, 1.0),
        is_team_match=has_teammate,
    )
