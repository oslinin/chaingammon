"""
backgammon/net.py — Small MLP for TD-Gammon style value prediction.

Architecture: 198 → hidden → hidden → 4, all sigmoid activations.

Cumulative-probability outputs (from White's perspective):
  out[0]  P(White wins any)
  out[1]  P(White wins gammon or backgammon)
  out[2]  P(Black wins any)
  out[3]  P(Black wins gammon or backgammon)

White equity = (out[0] + out[1]) - (out[2] + out[3])
"""

from __future__ import annotations

import torch
import torch.nn as nn


class BackgammonNet(nn.Module):
    """Two-hidden-layer MLP with sigmoid activations throughout."""

    def __init__(self, hidden: int = 128) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(198, hidden),
            nn.Sigmoid(),
            nn.Linear(hidden, hidden),
            nn.Sigmoid(),
            nn.Linear(hidden, 4),
            nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)

    @staticmethod
    def equity(out: torch.Tensor) -> torch.Tensor:
        """White equity scalar(s) from a batch or single output tensor."""
        return (out[..., 0] + out[..., 1]) - (out[..., 2] + out[..., 3])
