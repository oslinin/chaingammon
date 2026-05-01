"""Tests for sample_trainer.py.

Run with:  cd agent && uv run pytest tests/test_sample_trainer.py -v

Covers the architectural promises the README makes about the trainer:
  - Two networks instantiated with the same `core_seed` start with
    bit-identical core weights (the "shared gnubg base" guarantee).
  - Different `extras_seed` values produce different extras heads (the
    "per-agent random personality" guarantee).
  - A single TD(lambda) match step actually mutates the agent's
    parameters (the eligibility-trace update is wired through autograd
    correctly).
  - The opponent's parameters are NOT mutated during the agent's
    training (the opponent is frozen).
  - The forward pass returns equity in [0, 1] for any input.
"""
from __future__ import annotations

import random

import pytest
import torch

from sample_trainer import (
    BackgammonNet,
    DEFAULT_EXTRAS_DIM,
    GNUBG_FEAT_DIM,
    RaceState,
    encode_extras,
    encode_state,
    legal_successors,
    load_checkpoint,
    save_checkpoint,
    td_lambda_match,
)


# ---------------------------------------------------------------------------
# Network init invariants
# ---------------------------------------------------------------------------


def test_shared_core_seed_produces_identical_core_weights():
    """The README's "every agent starts from the same gnubg core" claim:
    same `core_seed` MUST yield bit-identical core weights regardless
    of extras_seed."""
    a = BackgammonNet(core_seed=0xBACC, extras_seed=1)
    b = BackgammonNet(core_seed=0xBACC, extras_seed=2)
    assert torch.equal(a.core.weight, b.core.weight)
    assert torch.equal(a.core.bias, b.core.bias)


def test_different_extras_seeds_produce_different_extras_heads():
    """The README's "per-agent random personality" claim: different
    `extras_seed` values MUST produce different extras-head weights."""
    a = BackgammonNet(core_seed=0xBACC, extras_seed=1)
    b = BackgammonNet(core_seed=0xBACC, extras_seed=2)
    assert a.extras is not None and b.extras is not None
    assert not torch.equal(a.extras.weight, b.extras.weight), (
        "extras heads with different seeds should diverge"
    )


def test_extras_dim_zero_skips_extras_head():
    """ctx_dim=0 reduces to the single-game gnubg-equivalent net."""
    net = BackgammonNet(extras_dim=0)
    assert net.extras is None
    out = net(torch.zeros(1, GNUBG_FEAT_DIM))
    assert out.shape == (1,)


# ---------------------------------------------------------------------------
# Forward pass shape and range
# ---------------------------------------------------------------------------


def test_forward_returns_equity_in_unit_interval():
    """The output is `sigmoid(...)` so it must lie in [0, 1]."""
    net = BackgammonNet(extras_dim=DEFAULT_EXTRAS_DIM, extras_seed=0)
    board = torch.randn(8, GNUBG_FEAT_DIM)
    extras = torch.randn(8, DEFAULT_EXTRAS_DIM)
    out = net(board, extras)
    assert out.shape == (8,)
    assert torch.all(out >= 0.0) and torch.all(out <= 1.0)


# ---------------------------------------------------------------------------
# Environment helpers
# ---------------------------------------------------------------------------


def test_legal_successors_returns_at_least_one_candidate():
    state = RaceState()
    cands = legal_successors(state, (3, 5))
    assert 1 <= len(cands) <= 4


def test_terminal_winner_when_pip_reaches_zero():
    state = RaceState(pip=[0, 50])
    assert state.terminal()
    assert state.winner() == 0


def test_encode_state_shape():
    feat = encode_state(RaceState(), perspective=0)
    assert feat.shape == (GNUBG_FEAT_DIM,)


# ---------------------------------------------------------------------------
# TD(lambda) match step
# ---------------------------------------------------------------------------


def test_td_lambda_match_mutates_agent_params_but_not_opponent():
    """One full self-play match must update the agent's parameters
    (TD updates fired) but leave the opponent frozen."""
    random.seed(0)
    torch.manual_seed(0)

    agent = BackgammonNet(core_seed=0xBACC, extras_seed=1)
    opponent = BackgammonNet(core_seed=0xBACC, extras_seed=2)

    agent_extras = encode_extras(DEFAULT_EXTRAS_DIM, agent_id=1, seed=42)
    opponent_extras = encode_extras(DEFAULT_EXTRAS_DIM, agent_id=2, seed=42)

    pre_agent_core = agent.core.weight.clone()
    pre_opp_core = opponent.core.weight.clone()
    pre_opp_head = opponent.head.weight.clone()

    steps, _won = td_lambda_match(
        agent, opponent, agent_extras, opponent_extras,
        gamma=1.0, lam=0.7, lr=1e-2,  # higher LR to ensure visible mutation
    )
    assert steps > 0
    # Agent params should have moved.
    assert not torch.equal(pre_agent_core, agent.core.weight), (
        "agent core weights should change after TD(lambda) updates"
    )
    # Opponent params must NOT have moved.
    assert torch.equal(pre_opp_core, opponent.core.weight)
    assert torch.equal(pre_opp_head, opponent.head.weight)


def test_match_terminates_within_max_turns():
    """The race environment must always terminate so the test suite
    doesn't hang."""
    random.seed(0)
    torch.manual_seed(0)
    agent = BackgammonNet(extras_dim=0)
    opponent = BackgammonNet(extras_dim=0)
    steps, _ = td_lambda_match(
        agent, opponent,
        torch.zeros(0), torch.zeros(0),
        gamma=1.0, lam=0.7, lr=1e-3,
    )
    # MAX_TURNS = 200 in sample_trainer.
    assert 1 <= steps <= 200


# ---------------------------------------------------------------------------
# Checkpoint save/load round-trip
# ---------------------------------------------------------------------------


def test_checkpoint_round_trip_preserves_weights(tmp_path):
    """save → load must reproduce a network whose every parameter
    matches the original bit-for-bit."""
    original = BackgammonNet(extras_dim=DEFAULT_EXTRAS_DIM, extras_seed=99)
    ckpt = tmp_path / "agent.pt"
    save_checkpoint(original, ckpt, match_count=42, extras_dim=DEFAULT_EXTRAS_DIM)

    loaded, match_count = load_checkpoint(ckpt)
    assert match_count == 42

    for (n1, p1), (n2, p2) in zip(original.named_parameters(),
                                  loaded.named_parameters()):
        assert n1 == n2
        assert torch.equal(p1, p2), f"{n1} differs after round-trip"


def test_loaded_checkpoint_matches_original_forward_output(tmp_path):
    """A stronger guarantee: the loaded net must produce identical
    forward outputs on identical inputs."""
    torch.manual_seed(0)
    original = BackgammonNet(extras_dim=DEFAULT_EXTRAS_DIM, extras_seed=7)
    ckpt = tmp_path / "agent.pt"
    save_checkpoint(original, ckpt, match_count=0, extras_dim=DEFAULT_EXTRAS_DIM)
    loaded, _ = load_checkpoint(ckpt)

    board = torch.randn(4, GNUBG_FEAT_DIM)
    extras = torch.randn(4, DEFAULT_EXTRAS_DIM)
    assert torch.equal(original(board, extras), loaded(board, extras))
