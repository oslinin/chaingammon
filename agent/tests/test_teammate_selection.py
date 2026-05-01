"""Tests for teammate_selection.recommend_teammate.

Run with:  cd agent && uv run pytest tests/test_teammate_selection.py -v

Hermetic — constructs deterministic BackgammonNets from fixed seeds.
No checkpoint files, no IO, no LLM. The point is to lock in the math:
distinct teammate styles produce distinct equities; argmax is correct;
empty candidates raises; the function doesn't mutate the net.
"""
from __future__ import annotations

import pytest
import torch
from torch import nn

from career_features import STYLE_AXES
from sample_trainer import BackgammonNet
from teammate_selection import (
    Recommendation,
    _build_extras,
    _reference_boards,
    recommend_teammate,
)


def _make_net(*, extras_seed: int = 1) -> BackgammonNet:
    """Deterministic per-test net. The same `extras_seed` always yields
    the same extras-head weights, so equity rankings are reproducible."""
    return BackgammonNet(extras_dim=16, core_seed=0xBACC, extras_seed=extras_seed)


def test_distinct_styles_produce_distinct_equities():
    """The whole point: different teammate-style inputs must produce
    different equities, otherwise there's no signal to extract."""
    net = _make_net()
    candidates = [
        (1, {"hits_blot": 0.9, "phase_prime_building": 0.2}),
        (2, {"hits_blot": -0.9, "phase_prime_building": -0.2}),
        (3, {"bearoff_efficient": 0.7, "runs_back_checker": -0.4}),
    ]
    rec = recommend_teammate(net, candidates)
    assert len(rec.equities) == 3
    # All three equities should differ — if they don't, the extras head
    # is not actually being consumed (regression check on the model
    # plumbing).
    assert len(set(rec.equities.values())) == 3
    assert rec.spread > 0.0


def test_best_teammate_is_argmax():
    """`best_teammate_id` must be the agent id with the highest equity."""
    net = _make_net()
    candidates = [
        (10, {axis: 0.5 for axis in STYLE_AXES}),
        (20, {axis: -0.5 for axis in STYLE_AXES}),
        (30, {axis: 0.0 for axis in STYLE_AXES}),
    ]
    rec = recommend_teammate(net, candidates)
    expected_best = max(rec.equities, key=rec.equities.__getitem__)
    assert rec.best_teammate_id == expected_best


def test_empty_candidates_raises():
    net = _make_net()
    with pytest.raises(ValueError, match="non-empty"):
        recommend_teammate(net, [])


def test_single_candidate_returns_that_candidate():
    """One candidate is its own argmax; spread is zero."""
    net = _make_net()
    rec = recommend_teammate(net, [(42, {"hits_blot": 0.5})])
    assert rec.best_teammate_id == 42
    assert rec.spread == 0.0
    assert set(rec.equities.keys()) == {42}


def test_does_not_mutate_net():
    """The function must not leave the net in eval mode (or vice versa)
    relative to how the caller had it. Trainers care about this."""
    net = _make_net()
    net.train()
    assert net.training is True
    recommend_teammate(net, [(1, {"hits_blot": 0.3})])
    assert net.training is True

    net.eval()
    assert net.training is False
    recommend_teammate(net, [(1, {"hits_blot": 0.3})])
    assert net.training is False


def test_no_grad_during_scoring():
    """Forward passes must be `with torch.no_grad()` so this can run
    inside training loops without inflating autograd memory."""
    net = _make_net()
    candidates = [(1, {"hits_blot": 0.3}), (2, {"bearoff_efficient": 0.4})]
    # Track param grads before / after — they should still be None.
    for p in net.parameters():
        p.grad = None
    recommend_teammate(net, candidates)
    for p in net.parameters():
        assert p.grad is None


def test_unknown_style_keys_are_ignored():
    """Style dicts may carry overlay keys outside STYLE_AXES (e.g.
    `cube_offer_aggressive`); the encoder ignores them rather than
    raising, so callers can pass overlay-shaped dicts directly."""
    net = _make_net()
    candidates = [
        (1, {"hits_blot": 0.5, "cube_offer_aggressive": 0.9}),  # extra key
        (2, {"hits_blot": 0.5}),                                  # subset
    ]
    rec = recommend_teammate(net, candidates)
    # The cube key is ignored, so 1 and 2 project to the same extras
    # vector and produce the same equity.
    assert rec.equities[1] == pytest.approx(rec.equities[2])


def test_reference_boards_are_deterministic():
    """Same seed → same boards. Lock in determinism across runs."""
    a = _reference_boards(8, seed=0xC4FE)
    b = _reference_boards(8, seed=0xC4FE)
    assert torch.equal(a, b)


def test_reference_boards_shape():
    boards = _reference_boards(5, seed=0)
    assert boards.shape == (5, 198)


def test_build_extras_uses_teammate_slot():
    """Slots [6:12] are the teammate-style projection. Non-zero teammate
    style must produce non-zero slots [6:12]; everything else should
    match the encoder's documented layout."""
    extras = _build_extras({"hits_blot": 0.7}, extras_dim=16)
    assert extras.shape == (16,)
    # `hits_blot` is the last STYLE_AXES axis (index 5), so slot 11.
    assert extras[11].item() == pytest.approx(0.7)
    # The is_team_match slot is fixed True by this helper.
    assert extras[14].item() == 1.0


def test_recommendation_dataclass_is_frozen():
    """The returned `Recommendation` is immutable; callers can rely on
    it as a stable record."""
    net = _make_net()
    rec = recommend_teammate(net, [(1, {"hits_blot": 0.3})])
    with pytest.raises(Exception):  # FrozenInstanceError or AttributeError
        rec.best_teammate_id = 999  # type: ignore[misc]


def test_extras_dim_propagates():
    """Caller can specify an extras_dim larger than 16; the encoder
    zero-pads. The function must round-trip without error."""
    # Build a net with extras_dim=20 so the encoder pads slots [16:20]
    # with zeros.
    net = BackgammonNet(extras_dim=20, core_seed=0xBACC, extras_seed=1)
    rec = recommend_teammate(
        net,
        [(1, {"hits_blot": 0.3}), (2, {"bearoff_efficient": 0.5})],
        extras_dim=20,
    )
    assert len(rec.equities) == 2


def test_n_reference_states_changes_smoothing_not_argmax():
    """Increasing the reference battery should keep the argmax stable
    for clearly differentiated styles (regression check that the
    reference-board variance isn't drowning the teammate signal)."""
    net = _make_net()
    candidates = [
        (1, {axis: 0.9 for axis in STYLE_AXES}),
        (2, {axis: -0.9 for axis in STYLE_AXES}),
    ]
    rec_few = recommend_teammate(net, candidates, n_reference_states=2)
    rec_many = recommend_teammate(net, candidates, n_reference_states=32)
    # For maximally-differentiated styles the argmax should agree.
    assert rec_few.best_teammate_id == rec_many.best_teammate_id
