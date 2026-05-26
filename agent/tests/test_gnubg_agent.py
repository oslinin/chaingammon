"""Tests for the gnubg-backed per-agent value net (agent/gnubg_agent.py).

Run with:  cd agent && uv run pytest tests/test_gnubg_agent.py -v

Locks down the behaviour that makes this a faithful "gnubg-based MLP":
  - a freshly minted agent evaluates exactly like gnubg (style head zero);
  - only the style head is trainable / saved (the gnubg backbone is frozen
    and kept out of the per-agent state_dict);
  - the style adjustment is bounded and depends on the board (genuine
    board×style interaction), and its gradient flows through the head.

Needs gnubg.wd on disk; skips otherwise.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import torch

from gnubg_agent import DEFAULT_EXTRAS_DIM, GNUBG_HIDDEN, GnubgValueNet
from gnubg_net import DEFAULT_WD_PATH

pytestmark = pytest.mark.skipif(
    not Path(DEFAULT_WD_PATH).is_file(),
    reason=f"gnubg weights not found at {DEFAULT_WD_PATH}",
)

_START = [0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0]
# A lopsided contact position (board0 well ahead) for a contrasting board.
_AHEAD = [0, 0, 0, 0, 0, 4, 4, 3, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]


def _net(**kw):
    return GnubgValueNet(extras_dim=DEFAULT_EXTRAS_DIM, **kw)


def test_fresh_agent_equals_gnubg():
    net = _net()
    extras = torch.zeros(DEFAULT_EXTRAS_DIM)
    eq = net.equity(_START, _START, extras).item()
    assert abs(eq - net.gnubg_equity(_START, _START)) < 1e-6


def test_no_extras_returns_gnubg_equity():
    net = _net()
    eq = net.equity(_START, _START, None).item()
    assert abs(eq - net.gnubg_equity(_START, _START)) < 1e-6


def test_parameters_are_style_head_only():
    net = _net()
    params = list(net.parameters())
    # Two Linears in the head -> 4 parameter tensors; the gnubg backbone
    # contributes none (frozen, unregistered).
    assert len(params) == 4
    assert all(p.requires_grad for p in params)
    # Sanity: the head's first layer consumes gnubg hidden + extras.
    assert net.style_head[0].in_features == GNUBG_HIDDEN + DEFAULT_EXTRAS_DIM


def test_style_adjustment_bounded_and_board_dependent():
    net = _net(style_scale=0.2)
    # Give the head a non-trivial mapping.
    with torch.no_grad():
        net.style_head[-1].weight.normal_(0, 1.0)
        net.style_head[-1].bias.normal_(0, 1.0)
    extras = torch.randn(DEFAULT_EXTRAS_DIM)
    adj_start = net.equity(_START, _START, extras).item() - net.gnubg_equity(_START, _START)
    adj_ahead = net.equity(_AHEAD, _AHEAD, extras).item() - net.gnubg_equity(_AHEAD, _AHEAD)
    # Same style, different board -> different adjustment (genuine interaction).
    assert abs(adj_start - adj_ahead) > 1e-4
    # Adjustment never exceeds the configured scale.
    assert abs(adj_start) <= 0.2 + 1e-5
    assert abs(adj_ahead) <= 0.2 + 1e-5


def test_gradient_flows_through_style_head_only():
    net = _net()
    extras = torch.randn(DEFAULT_EXTRAS_DIM)
    eq = net.equity(_START, _START, extras)
    eq.backward()
    # The head is trainable: its output layer gets gradient even at zero-init
    # (the earlier layer's gradient is blocked by the zeroed output weights —
    # expected chain-rule behaviour, and it unblocks after one step).
    out_grad = net.style_head[-1].weight.grad
    assert out_grad is not None and torch.any(out_grad != 0)
    # The frozen gnubg backbone has no trainable parameters at all.
    assert all(not p.requires_grad for p in net._gnubg.contact.parameters())


def test_equities_batched():
    net = _net()
    extras = torch.zeros(DEFAULT_EXTRAS_DIM)
    eqs = net.equities([(_START, _START), (_AHEAD, _AHEAD)], extras)
    assert eqs.shape == (2,)
    assert torch.all((eqs >= -1.0) & (eqs <= 1.0))
