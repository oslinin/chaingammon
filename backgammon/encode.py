"""
backgammon/encode.py — 198-feature TD-Gammon board encoding.

For each of 24 points × 2 players = 48 groups, 4 features:
  f0 = (n >= 1)
  f1 = (n >= 2)
  f2 = (n >= 3)
  f3 = max(0, n-3) / 2

Plus 6 global features:
  bar_W/2, off_W/15, bar_B/2, off_B/15, turn==W, turn==B

Total: 48×4 + 6 = 198.
"""

from __future__ import annotations

import numpy as np
import torch

from backgammon.env import GameState

_N_FEATURES = 198


def encode_state(state: GameState) -> torch.Tensor:
    """Encode *state* into the 198-dim float32 TD-Gammon feature vector."""
    feats = np.zeros(_N_FEATURES, dtype=np.float32)
    idx = 0

    for player in (0, 1):
        sign = 1 if player == 0 else -1
        for p in range(24):
            n = max(0, state.board[p] * sign)
            feats[idx]     = float(n >= 1)
            feats[idx + 1] = float(n >= 2)
            feats[idx + 2] = float(n >= 3)
            feats[idx + 3] = max(0.0, (n - 3) / 2.0)
            idx += 4

    # Global features
    feats[idx]     = state.bar[0] / 2.0
    feats[idx + 1] = state.off[0] / 15.0
    feats[idx + 2] = state.bar[1] / 2.0
    feats[idx + 3] = state.off[1] / 15.0
    feats[idx + 4] = 1.0 if state.turn == 0 else 0.0
    feats[idx + 5] = 1.0 if state.turn == 1 else 0.0

    return torch.from_numpy(feats)
