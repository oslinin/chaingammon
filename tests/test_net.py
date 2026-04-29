"""tests/test_net.py — Unit tests for backgammon/net.py and backgammon/encode.py."""

import torch

from backgammon.encode import encode_state
from backgammon.env import GameState, starting_state
from backgammon.net import BackgammonNet


def test_forward_pass_shape():
    net = BackgammonNet(hidden=64)
    state = starting_state()
    enc = encode_state(state)
    assert enc.shape == (198,), f"Expected (198,), got {enc.shape}"
    out = net(enc.unsqueeze(0))
    assert out.shape == (1, 4), f"Expected (1, 4), got {out.shape}"


def test_output_in_unit_range():
    net = BackgammonNet(hidden=64)
    state = starting_state()
    enc = encode_state(state)
    out = net(enc.unsqueeze(0)).squeeze(0)
    assert (out >= 0).all() and (out <= 1).all(), "Sigmoid outputs must be in [0, 1]"


def test_equity_formula():
    """equity = (out[0]+out[1]) - (out[2]+out[3])."""
    out = torch.tensor([[0.9, 0.4, 0.2, 0.1]])
    eq = BackgammonNet.equity(out)
    expected = (0.9 + 0.4) - (0.2 + 0.1)
    assert abs(eq.item() - expected) < 1e-5, f"Equity formula wrong: {eq.item()} != {expected}"


def test_equity_symmetric():
    """For equal-output values, equity sums to zero."""
    out = torch.tensor([[0.5, 0.3, 0.5, 0.3]])
    eq = BackgammonNet.equity(out)
    assert abs(eq.item()) < 1e-5, f"Symmetric outputs should have zero equity, got {eq.item()}"


def test_encode_feature_count():
    """198 features: 24 points × 2 players × 4 + 6 global."""
    enc = encode_state(starting_state())
    assert enc.numel() == 198


def test_encode_turn_flag():
    """Turn flags set correctly for White and Black."""
    s = starting_state()
    s.turn = 0
    enc_w = encode_state(s)
    s.turn = 1
    enc_b = encode_state(s)
    # Feature 196 = turn==White, 197 = turn==Black
    assert enc_w[196].item() == 1.0 and enc_w[197].item() == 0.0
    assert enc_b[196].item() == 0.0 and enc_b[197].item() == 1.0


def test_batch_forward():
    net = BackgammonNet(hidden=32)
    states = [starting_state() for _ in range(8)]
    batch = torch.stack([encode_state(s) for s in states])
    out = net(batch)
    assert out.shape == (8, 4)
    assert (out >= 0).all() and (out <= 1).all()
