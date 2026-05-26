"""Model-agnostic style tests — the contract must hold for ANY model, not just
the MLP: random forests and 2-ply search (incl. ply-backoff) all condition on
[board ‖ style] for both inference and training.

Run with:  cd agent && uv run pytest tests/test_model_agnostic_style.py -v

Why this proves generality: every model is reached through the same
`(feats, ext) -> equities` boundary. `_make_eval_fn` closes over the style
vector and broadcasts it onto *every* leaf the search evaluates, so the model —
whatever it is — sees board+style at each leaf. The contract is therefore
depth-agnostic (1-ply, 2-ply, or any backoff scheme) and model-agnostic.
"""
from __future__ import annotations

import random

import numpy as np
import torch

from sample_trainer import (
    BackgammonNet,
    DEFAULT_EXTRAS_DIM,
    GNUBG_FEAT_DIM,
    RaceState,
    _make_eval_fn,
    td_lambda_match,
)
from search import search_2ply
from sklearn_agent import SklearnProxy, build_sklearn_model

FOREST_SRC = (
    "from sklearn.ensemble import RandomForestRegressor\n"
    "def build_model():\n"
    "    return RandomForestRegressor(n_estimators=32, random_state=0)\n"
)


def _forest_proxy_conditioned_on_style(style_dim: int = 4) -> SklearnProxy:
    """A fitted random forest whose label depends only on style column 0, wired
    through SklearnProxy exactly as the round-robin does."""
    rng = np.random.default_rng(0)
    n = 400
    board = rng.standard_normal((n, GNUBG_FEAT_DIM)).astype("float32")
    style = rng.standard_normal((n, style_dim)).astype("float32")
    X = np.concatenate([board, style], axis=1)
    y = (style[:, 0] > 0.0).astype("float32")
    model = build_sklearn_model(FOREST_SRC)
    model.fit(X, y)
    proxy = SklearnProxy(extras_dim=style_dim)
    proxy.update_model(model)
    return proxy


# ---------------------------------------------------------------------------
# The generic eval boundary carries style to any model
# ---------------------------------------------------------------------------


def test_eval_fn_conditions_on_style_for_mlp():
    """_make_eval_fn — the boundary every search depth goes through — produces
    different leaf equities for different styles (the MLP fuses board+style)."""
    torch.manual_seed(0)
    net = BackgammonNet(extras_dim=DEFAULT_EXTRAS_DIM, extras_seed=2)
    net.eval()
    boards = torch.randn(16, GNUBG_FEAT_DIM)
    eval_a = _make_eval_fn(net, torch.randn(DEFAULT_EXTRAS_DIM))
    eval_b = _make_eval_fn(net, torch.randn(DEFAULT_EXTRAS_DIM))
    assert not torch.allclose(eval_a(boards), eval_b(boards))


def test_eval_fn_conditions_on_style_for_forest():
    """Same boundary, arbitrary model: a random forest's leaf equities move with
    style because SklearnProxy concatenates style before predict()."""
    proxy = _forest_proxy_conditioned_on_style()
    boards = torch.randn(16, GNUBG_FEAT_DIM)
    eval_pos = _make_eval_fn(proxy, torch.tensor([2.0, 0.0, 0.0, 0.0]))
    eval_neg = _make_eval_fn(proxy, torch.tensor([-2.0, 0.0, 0.0, 0.0]))
    assert eval_pos(boards).mean() > eval_neg(boards).mean() + 0.2


# ---------------------------------------------------------------------------
# 2-ply search (depth-/backoff-agnostic) conditions on style — MLP and forest
# ---------------------------------------------------------------------------


def test_2ply_value_responds_to_style_mlp():
    """The 2-ply expectiminimax value changes with style — style propagates to
    every leaf the search evaluates, so deeper/backoff search keeps it."""
    torch.manual_seed(0)
    net = BackgammonNet(extras_dim=DEFAULT_EXTRAS_DIM, extras_seed=4)
    net.eval()
    state = RaceState()  # opening race position — successors are non-terminal
    _, v_a = search_2ply(state, (3, 1), _make_eval_fn(net, torch.randn(DEFAULT_EXTRAS_DIM)), perspective=0)
    _, v_b = search_2ply(state, (3, 1), _make_eval_fn(net, torch.randn(DEFAULT_EXTRAS_DIM)), perspective=0)
    assert abs(v_a - v_b) > 1e-6


def test_2ply_value_responds_to_style_forest():
    """A random forest driving the 2-ply search also conditions on style — proves
    an arbitrary (non-MLP) model gets board+style under search, out of the box."""
    proxy = _forest_proxy_conditioned_on_style()
    state = RaceState()
    _, v_pos = search_2ply(state, (3, 1), _make_eval_fn(proxy, torch.tensor([2.0, 0.0, 0.0, 0.0])), perspective=0)
    _, v_neg = search_2ply(state, (3, 1), _make_eval_fn(proxy, torch.tensor([-2.0, 0.0, 0.0, 0.0])), perspective=0)
    assert abs(v_pos - v_neg) > 1e-6


# ---------------------------------------------------------------------------
# Training on board+style works under 2-ply search too
# ---------------------------------------------------------------------------


def test_2ply_training_updates_params_with_style():
    """A TD(λ) match at search_depth=2 runs and updates the agent — confirming
    training (not just inference) goes through the style-carrying search path."""
    random.seed(0)
    torch.manual_seed(0)
    agent = BackgammonNet(extras_seed=1)
    opponent = BackgammonNet(extras_seed=2)
    a_ext = torch.randn(DEFAULT_EXTRAS_DIM)
    o_ext = torch.randn(DEFAULT_EXTRAS_DIM)
    pre_core = agent.core.weight.clone()

    steps, _won, *_ = td_lambda_match(
        agent, opponent, a_ext, o_ext,
        gamma=1.0, lam=0.7, lr=1e-2,
        search_depth=2, opp_search_depth=2,
    )
    assert steps > 0
    assert not torch.equal(pre_core, agent.core.weight), (
        "2-ply TD training should update the agent's fused first layer"
    )
