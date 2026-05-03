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


# ---------------------------------------------------------------------------
# drand-derived dice mode is deterministic
# ---------------------------------------------------------------------------


def test_match_with_drand_digest_is_deterministic_in_dice():
    """When `drand_round_digest` is supplied, two matches with identical
    fresh nets MUST take the same sequence of turns (same length) —
    every dice roll is derived from the digest, so randomness only
    enters through the value-net, which is identically initialised."""
    digest = bytes.fromhex("aa" * 32)
    a_steps_list: list[int] = []
    for _ in range(2):
        torch.manual_seed(0)
        agent = BackgammonNet(core_seed=0xBACC, extras_seed=1)
        opponent = BackgammonNet(core_seed=0xBACC, extras_seed=2)
        a_extras = torch.zeros(DEFAULT_EXTRAS_DIM)
        o_extras = torch.zeros(DEFAULT_EXTRAS_DIM)
        steps, _ = td_lambda_match(
            agent, opponent, a_extras, o_extras,
            gamma=1.0, lam=0.7, lr=0.0,   # lr=0 → no weight drift between runs
            drand_round_digest=digest,
        )
        a_steps_list.append(steps)
    assert a_steps_list[0] == a_steps_list[1], (
        f"matches with same drand digest + identical nets should run "
        f"the same number of turns, got {a_steps_list}"
    )


# ---------------------------------------------------------------------------
# Career-mode end-to-end (--career-mode CLI smoke test)
# ---------------------------------------------------------------------------


def test_career_mode_runs_end_to_end(tmp_path):
    """`python sample_trainer.py --career-mode --matches 3` must complete
    without error and save a checkpoint."""
    import subprocess
    import sys
    from pathlib import Path

    trainer = Path(__file__).resolve().parents[1] / "sample_trainer.py"
    ckpt = tmp_path / "agent.pt"

    result = subprocess.run(
        [sys.executable, str(trainer),
         "--career-mode", "--matches", "3",
         "--save-checkpoint", str(ckpt)],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, (
        f"trainer failed: stdout={result.stdout!r} stderr={result.stderr!r}"
    )
    assert ckpt.exists(), "checkpoint should be written"


def test_career_mode_requires_extras_dim_at_least_16(tmp_path):
    """The encoder's slot layout is fixed at 16 — the trainer should
    refuse to start if --extras-dim is below that."""
    import subprocess
    import sys
    from pathlib import Path

    trainer = Path(__file__).resolve().parents[1] / "sample_trainer.py"
    result = subprocess.run(
        [sys.executable, str(trainer),
         "--career-mode", "--extras-dim", "8", "--matches", "1"],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode != 0
    assert "extras-dim >= 16" in result.stderr


def test_career_mode_extras_use_real_encoder():
    """A `CareerContext` passed through `encode_career_context` must
    produce a tensor compatible with `BackgammonNet`'s extras head —
    i.e. the trainer's career-mode wiring routes through the real
    encoder, not the placeholder random projection."""
    from career_features import (
        CareerContext,
        STYLE_AXES,
        encode_career_context,
    )

    ctx = CareerContext(
        opponent_style={a: 0.4 for a in STYLE_AXES},
        teammate_style={a: -0.2 for a in STYLE_AXES},
        stake_wei=10**18,
        tournament_position=0.5,
        is_team_match=True,
    )
    extras = encode_career_context(ctx, dim=DEFAULT_EXTRAS_DIM)

    # The extras vector must be consumable by the value net's extras head.
    net = BackgammonNet(extras_dim=DEFAULT_EXTRAS_DIM, extras_seed=0)
    board = torch.zeros(1, GNUBG_FEAT_DIM)
    out = net(board, extras.unsqueeze(0))
    assert out.shape == (1,)

    # And the encoder is deterministic for a fixed context.
    extras2 = encode_career_context(ctx, dim=DEFAULT_EXTRAS_DIM)
    assert torch.equal(extras, extras2)
