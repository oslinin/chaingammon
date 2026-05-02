"""Tests for career_features.encode_career_context.

Run with:  cd agent && uv run pytest tests/test_career_features.py -v

Locks in the slot layout the trainer's `--career-mode` path depends on:
  [0:6]   opponent_style         clamped, axis-ordered
  [6:12]  teammate_style         zero when None
  [12]    log1p(stake_wei)/70    clamped to [0, 1]
  [13]    tournament_position    clamped to [-1, 1]
  [14]    1.0 if is_team_match else 0.0
  [15]    1.0  bias channel
"""
from __future__ import annotations

import math
import random

import pytest
import torch

from career_features import (
    STYLE_AXES,
    CareerContext,
    encode_career_context,
    sample_career_context,
)


def _ctx(**overrides) -> CareerContext:
    """Solo-match neutral context, with named overrides."""
    base = dict(
        opponent_style={a: 0.0 for a in STYLE_AXES},
        teammate_style=None,
        stake_wei=0,
        tournament_position=0.0,
        is_team_match=False,
    )
    base.update(overrides)
    return CareerContext(**base)


def test_default_dim_is_16():
    out = encode_career_context(_ctx())
    assert out.shape == (16,)


def test_dim_too_small_raises():
    with pytest.raises(ValueError):
        encode_career_context(_ctx(), dim=15)
    with pytest.raises(ValueError):
        encode_career_context(_ctx(), dim=0)


def test_larger_dim_zero_pads_tail():
    out = encode_career_context(_ctx(), dim=20)
    assert out.shape == (20,)
    assert torch.all(out[16:] == 0.0)


def test_neutral_context_only_bias_channel():
    out = encode_career_context(_ctx())
    expected = torch.zeros(16)
    expected[15] = 1.0
    assert torch.allclose(out, expected)


def test_deterministic_same_inputs_same_output():
    ctx = _ctx(opponent_style={"opening_slot": 0.7, "hits_blot": -0.3},
               stake_wei=10**18, tournament_position=0.4, is_team_match=True)
    a = encode_career_context(ctx)
    b = encode_career_context(ctx)
    assert torch.equal(a, b)


def test_opponent_style_routes_to_first_six_slots():
    ctx = _ctx(opponent_style={
        "opening_slot": 0.5,
        "phase_prime_building": -0.4,
        "runs_back_checker": 0.2,
        "phase_holding_game": -0.1,
        "bearoff_efficient": 0.9,
        "hits_blot": -0.7,
    })
    out = encode_career_context(ctx)
    expected_first_six = torch.tensor([0.5, -0.4, 0.2, -0.1, 0.9, -0.7])
    assert torch.allclose(out[:6], expected_first_six)


def test_opponent_style_clamps_to_unit_interval():
    out = encode_career_context(_ctx(opponent_style={
        "opening_slot": 5.0,           # clamps to +1
        "hits_blot": -3.0,             # clamps to -1
    }))
    assert out[0].item() == 1.0
    assert out[5].item() == -1.0


def test_unknown_opponent_axis_ignored():
    out = encode_career_context(_ctx(opponent_style={
        "opening_slot": 0.5,
        "this_is_not_a_real_axis": 0.9,
    }))
    assert out[0].item() == 0.5
    expected = torch.zeros(16)
    expected[0] = 0.5
    expected[15] = 1.0
    assert torch.allclose(out, expected)


def test_teammate_none_zeros_slots_6_through_11():
    out = encode_career_context(_ctx(teammate_style=None))
    assert torch.all(out[6:12] == 0.0)


def test_teammate_style_routes_to_slots_6_through_11():
    ctx = _ctx(
        teammate_style={a: 0.5 for a in STYLE_AXES},
        is_team_match=True,
    )
    out = encode_career_context(ctx)
    assert torch.allclose(out[6:12], torch.full((6,), 0.5))


def test_teammate_and_opponent_both_route_independently():
    ctx = _ctx(
        opponent_style={"opening_slot": 0.8},
        teammate_style={"hits_blot": -0.6},
        is_team_match=True,
    )
    out = encode_career_context(ctx)
    assert math.isclose(out[0].item(), 0.8, abs_tol=1e-6)
    assert math.isclose(out[11].item(), -0.6, abs_tol=1e-6)
    # Other style slots untouched.
    assert out[1].item() == 0.0
    assert out[6].item() == 0.0


def test_stake_wei_zero_is_zero():
    out = encode_career_context(_ctx(stake_wei=0))
    assert out[12].item() == 0.0


def test_stake_wei_typical_eth_in_zero_to_one():
    out = encode_career_context(_ctx(stake_wei=10**18))  # 1 ETH
    expected = math.log1p(10**18) / 70.0
    assert math.isclose(out[12].item(), expected, abs_tol=1e-6)
    assert 0.0 < out[12].item() < 1.0


def test_stake_wei_bounded_for_huge_stakes():
    # Even an astronomical stake must keep slot 12 within [0, 1].
    out = encode_career_context(_ctx(stake_wei=10**40))
    assert 0.0 <= out[12].item() <= 1.0


def test_negative_stake_clamps_to_zero():
    out = encode_career_context(_ctx(stake_wei=-100))
    assert out[12].item() == 0.0


def test_tournament_position_passes_through_in_range():
    out_pos = encode_career_context(_ctx(tournament_position=0.6))
    out_neg = encode_career_context(_ctx(tournament_position=-0.3))
    assert math.isclose(out_pos[13].item(), 0.6, abs_tol=1e-6)
    assert math.isclose(out_neg[13].item(), -0.3, abs_tol=1e-6)


def test_tournament_position_clamps_to_unit_interval():
    out_hi = encode_career_context(_ctx(tournament_position=4.0))
    out_lo = encode_career_context(_ctx(tournament_position=-7.5))
    assert out_hi[13].item() == 1.0
    assert out_lo[13].item() == -1.0


def test_is_team_match_flag():
    assert encode_career_context(_ctx(is_team_match=False))[14].item() == 0.0
    assert encode_career_context(_ctx(is_team_match=True))[14].item() == 1.0


def test_bias_channel_always_one():
    # Even at fully zero context the bias channel is 1.0.
    assert encode_career_context(_ctx())[15].item() == 1.0
    # And under full load too.
    full = encode_career_context(_ctx(
        opponent_style={a: 1.0 for a in STYLE_AXES},
        teammate_style={a: -1.0 for a in STYLE_AXES},
        stake_wei=10**24, tournament_position=1.0, is_team_match=True,
    ))
    assert full[15].item() == 1.0


def test_distinct_contexts_distinct_vectors():
    a = encode_career_context(_ctx(opponent_style={"opening_slot": 0.4}))
    b = encode_career_context(_ctx(opponent_style={"opening_slot": -0.4}))
    c = encode_career_context(_ctx(stake_wei=10**18))
    d = encode_career_context(_ctx(is_team_match=True))
    seen = {tuple(t.tolist()) for t in (a, b, c, d)}
    assert len(seen) == 4


# ---------------------------------------------------------------------------
# sample_career_context
# ---------------------------------------------------------------------------


def test_sample_career_context_deterministic_for_seed():
    a = sample_career_context(random.Random(42))
    b = sample_career_context(random.Random(42))
    assert a == b


def test_sample_career_context_distinct_seeds_distinct_outputs():
    a = sample_career_context(random.Random(1))
    b = sample_career_context(random.Random(2))
    assert a != b


def test_sample_career_context_force_team_true():
    ctx = sample_career_context(random.Random(0), force_team=True)
    assert ctx.is_team_match is True
    assert ctx.teammate_style is not None
    assert set(ctx.teammate_style.keys()) == set(STYLE_AXES)


def test_sample_career_context_force_team_false():
    ctx = sample_career_context(random.Random(0), force_team=False)
    assert ctx.is_team_match is False
    assert ctx.teammate_style is None


def test_sample_career_context_distributions_within_bounds():
    rng = random.Random(123)
    for _ in range(50):
        ctx = sample_career_context(rng)
        assert all(-1.0 <= v <= 1.0 for v in ctx.opponent_style.values())
        if ctx.teammate_style is not None:
            assert all(-1.0 <= v <= 1.0 for v in ctx.teammate_style.values())
        assert -1.0 <= ctx.tournament_position <= 1.0
        assert ctx.stake_wei >= 0
        assert ctx.is_team_match == (ctx.teammate_style is not None)


def test_sample_career_context_produces_distinct_per_match_extras():
    """The trainer's --career-mode promise: per-match contexts vary
    enough that the resulting extras vectors are mostly distinct."""
    rng = random.Random(7)
    seen = set()
    for _ in range(20):
        ctx = sample_career_context(rng)
        feat = tuple(round(x, 4) for x in encode_career_context(ctx).tolist())
        seen.add(feat)
    assert len(seen) >= 18, f"only {len(seen)} distinct extras across 20 matches"
