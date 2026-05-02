"""career_features.py — contextual feature encoder for the value net.

The trainer's `BackgammonNet` exposes an `extras` head that consumes a
fixed-dimension vector alongside the gnubg board features. In a
single-game-vs-frozen-opponent self-play run, the extras vector is
just a per-agent random projection (`sample_trainer.encode_extras`)
— that's enough to demonstrate the architecture but it doesn't carry
real career-mode information.

This module replaces the placeholder when the trainer is run with
`--career-mode`. It encodes the contextual inputs `chaingammon_plan.md`
calls out for the career-mode head:

  - opponent_style:      classifier signal {axis -> score in [-1, 1]}
  - teammate_style:      same shape; None when there is no teammate
  - stake_wei:           on-chain MatchEscrow deposit for this match
  - tournament_position: scalar in [-1, 1]; 0 = casual
  - is_team_match:       1.0 in doubles/chouette/human+agent

into a 16-d vector compatible with `BackgammonNet.extras`. Pure
function, no IO, no LLM.

Slot layout (`dim` defaults to 16; smaller raises, larger zero-pads):

    [0:6]    opponent_style projection — 6 canonical axes
    [6:12]   teammate_style projection — zero when teammate_style is None
    [12]     log1p(stake_wei) / 70, clamped to [0, 1]
    [13]     tournament_position, clamped to [-1, 1]
    [14]     1.0 if is_team_match else 0.0
    [15]     1.0  bias ones-channel (so the extras head has a usable
                  signal even before training)

Why these six axes (drawn from `agent_overlay.CATEGORIES`):
    opening_slot          aggressive opening
    phase_prime_building  builds primes
    runs_back_checker     running game preference
    phase_holding_game    holding-game preference
    bearoff_efficient     bear-off skill
    hits_blot             aggression on contact

They cover the four distinguishable axes the coach already reads
(opening, phase, mid-game risk, bear-off) and stay consistent with
the style profile blob format on 0G Storage KV.
"""
from __future__ import annotations

import math
import random
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

_MIN_DIM = 16
_STAKE_LOG_DIVISOR = 70.0
"""log1p(1e30) ≈ 69.08; divisor 70 maps stakes up to 1e30 wei into [0, 1]
without clamping. Larger stakes are clamped to 1.0 by the encoder."""


@dataclass(frozen=True)
class CareerContext:
    """Structured contextual inputs for one career-mode self-play match.

    `opponent_style` and `teammate_style` are dicts keyed by axis name
    (a subset of `agent_overlay.CATEGORIES`); unknown keys are ignored
    and missing keys default to 0.0. Values are not range-checked here
    — the encoder clamps as needed."""
    opponent_style: dict[str, float]
    teammate_style: Optional[dict[str, float]]
    stake_wei: int
    tournament_position: float
    is_team_match: bool


def _project_style(style: Optional[dict[str, float]]) -> list[float]:
    """Project a style dict onto STYLE_AXES, clamping each component
    to [-1, 1]. Returns a 6-element list of floats. None -> all zeros."""
    if style is None:
        return [0.0] * len(STYLE_AXES)
    out: list[float] = []
    for axis in STYLE_AXES:
        v = float(style.get(axis, 0.0))
        out.append(max(-1.0, min(1.0, v)))
    return out


def encode_career_context(ctx: CareerContext, *, dim: int = _MIN_DIM) -> torch.Tensor:
    """Project a `CareerContext` into a `dim`-d feature tensor.

    Raises `ValueError` if `dim < 16` — the slot layout is fixed at 16.
    `dim > 16` zero-pads slots [16:dim).
    """
    if dim < _MIN_DIM:
        raise ValueError(
            f"encode_career_context requires dim >= {_MIN_DIM} "
            f"(slot layout is fixed at {_MIN_DIM}); got {dim}"
        )

    feat = torch.zeros(dim)

    opp = _project_style(ctx.opponent_style)
    for i, v in enumerate(opp):
        feat[i] = v

    team = _project_style(ctx.teammate_style)
    for i, v in enumerate(team):
        feat[6 + i] = v

    stake = max(int(ctx.stake_wei), 0)
    feat[12] = min(math.log1p(stake) / _STAKE_LOG_DIVISOR, 1.0)

    feat[13] = max(-1.0, min(1.0, float(ctx.tournament_position)))

    feat[14] = 1.0 if ctx.is_team_match else 0.0

    feat[15] = 1.0

    return feat


def _sample_style(rng: random.Random) -> dict[str, float]:
    """Sample a style dict over `STYLE_AXES` with each value drawn
    uniformly from [-1, 1]."""
    return {axis: rng.uniform(-1.0, 1.0) for axis in STYLE_AXES}


def sample_career_context(rng: random.Random, *, force_team: Optional[bool] = None) -> CareerContext:
    """Draw a synthetic `CareerContext` for one career-mode self-play match.

    Distributions:
      opponent_style:      uniform [-1, 1] per axis
      teammate_style:      same shape with prob 0.5 (else None)
      stake_wei:           log-uniform across [0, 1e21] (i.e. 0..1000 ETH)
      tournament_position: uniform [-1, 1]
      is_team_match:       True iff teammate_style is not None (or forced)

    The trainer calls this fresh per match so the value-net's extras
    head sees a wide distribution of contexts during training.
    """
    has_teammate = force_team if force_team is not None else (rng.random() < 0.5)
    teammate_style = _sample_style(rng) if has_teammate else None

    log_stake = rng.uniform(0.0, math.log1p(10**21))
    stake_wei = max(0, int(math.expm1(log_stake)))

    return CareerContext(
        opponent_style=_sample_style(rng),
        teammate_style=teammate_style,
        stake_wei=stake_wei,
        tournament_position=rng.uniform(-1.0, 1.0),
        is_team_match=has_teammate,
    )
