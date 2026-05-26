"""Tests for gnubg distillation (agent/gnubg_distill.py) and the core-init hook.

Run with:  cd agent && uv run pytest tests/test_gnubg_distill.py -v

Confirms gnubg-labelled data generation, that a small distilled net actually
learns gnubg's win probability (beats the constant-mean baseline and correlates
with the teacher), and that the trained core drops into
sample_trainer.gnubg_published_core_init (with a clean Xavier fallback when the
file is absent or the shape mismatches).

Data-gen / distill tests need gnubg.wd; the core-init wiring tests don't.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import torch

import random

import sample_trainer
from gnubg_distill import (
    _DistillNet,
    _random_endgame_position,
    distill,
    generate_training_data,
    save_core,
)
from gnubg_net import (
    CLASS_CONTACT,
    CLASS_CRASHED,
    CLASS_OVER,
    DEFAULT_WD_PATH,
    classify_position,
)
from gnubg_search import board_to_tanboard
from rules_engine import Board
from sample_trainer import gnubg_published_core_init

_needs_wd = pytest.mark.skipif(
    not Path(DEFAULT_WD_PATH).is_file(),
    reason=f"gnubg weights not found at {DEFAULT_WD_PATH}",
)


@_needs_wd
def test_generate_training_data_shapes_and_range():
    X, y = generate_training_data(200, seed=3, policy="random")
    assert X.shape == (200, 198)
    assert y.shape == (200,)
    assert torch.all((y >= 0.0) & (y <= 1.0))


@_needs_wd
def test_distill_learns_gnubg_signal():
    X, y = generate_training_data(4000, seed=1, policy="random", endgame_frac=0.0)
    net, m = distill(X, y, hidden=80, epochs=25, seed=1)
    # Beats predicting the constant mean (a net that learned nothing).
    assert m["val_mse"] < 0.8 * y.var().item()
    # And tracks the teacher's ordering.
    assert m["val_pearson"] > 0.5


def test_endgame_seeds_are_races():
    # Endgame seeding exists to add the race/bearoff coverage opening rollouts
    # miss; every seeded position must classify as race (pure function, no wd).
    rng = random.Random(11)
    for _ in range(60):
        board, bar, off, _ = _random_endgame_position(rng)
        assert sum(c for c in board if c > 0) + off[0] == 15
        assert -sum(c for c in board if c < 0) + off[1] == 15
        b0, b1 = board_to_tanboard(Board(tuple(board), tuple(bar), tuple(off)), 0)
        assert classify_position(b0, b1) not in (CLASS_OVER, CLASS_CONTACT, CLASS_CRASHED)


@_needs_wd
def test_guided_policy_produces_valid_data():
    # The bounded gnubg-guided policy runs and yields valid labelled positions.
    X, y = generate_training_data(80, seed=5, policy="guided", guide_eps=0.2, endgame_frac=0.15)
    assert X.shape == (80, 198)
    assert torch.all((y >= 0.0) & (y <= 1.0))


def test_core_init_loads_distilled_weights(tmp_path, monkeypatch):
    net = _DistillNet(in_dim=198, hidden=80)
    with torch.no_grad():  # make the saved weights unmistakable
        net.core.weight.fill_(0.123)
        net.core.bias.fill_(-0.5)
    path = save_core(net, tmp_path / "gnubg_core.pt")
    monkeypatch.setattr(sample_trainer, "GNUBG_CORE_WEIGHTS_PATH", path)

    layer = gnubg_published_core_init(198, 80)
    assert torch.allclose(layer.weight, net.core.weight)
    assert torch.allclose(layer.bias, net.core.bias)


def test_core_init_falls_back_on_shape_mismatch(tmp_path, monkeypatch):
    net = _DistillNet(in_dim=198, hidden=80)
    path = save_core(net, tmp_path / "gnubg_core.pt")
    monkeypatch.setattr(sample_trainer, "GNUBG_CORE_WEIGHTS_PATH", path)
    # Requesting a different hidden size can't use the saved (80-wide) core,
    # so it falls back to a correctly-shaped Xavier layer (bias zeroed).
    layer = gnubg_published_core_init(198, 64)
    assert layer.out_features == 64
    assert torch.all(layer.bias == 0.0)


def test_core_init_deterministic_xavier_when_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(sample_trainer, "GNUBG_CORE_WEIGHTS_PATH", tmp_path / "missing.pt")
    a = gnubg_published_core_init(198, 80, seed=0xBACC)
    b = gnubg_published_core_init(198, 80, seed=0xBACC)
    assert torch.allclose(a.weight, b.weight)  # shared deterministic init
    assert torch.all(a.bias == 0.0)
