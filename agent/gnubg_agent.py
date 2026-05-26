"""gnubg_agent.py — per-agent value net built on GNU Backgammon's real weights.

This is the realisation of mint-helper request #1 ("make the MLP based on gnubg
weights instead of random"). The previous default (agent/sample_trainer.py
BackgammonNet) initialised its first layer from a Xavier-uniform stand-in; here
the backbone *is* gnubg's published contact/race/crashed evaluator
(agent/gnubg_net.py), loaded from gnubg.wd and frozen.

A `GnubgValueNet` evaluates a position with gnubg (a world-class baseline) and
adds a small, trainable "style" adjustment conditioned on gnubg's own 128-d
hidden board representation concatenated with the agent's career/style vector.
Two consequences:

  * A freshly minted agent plays exactly like gnubg — the style head is
    zero-initialised, so its adjustment is 0 until training moves it.
  * The adjustment is a genuine board×style interaction (it sees gnubg's
    board features, not just the style vector), the property CONTEXT.md's
    overlay design requires; a constant per-candidate style term cannot
    silently cancel in move selection.

Only the style head is trainable and saved per agent; the gnubg backbone is the
shared base weights already pinned on 0G Storage, so per-agent checkpoints stay
tiny.
"""
from __future__ import annotations

from pathlib import Path
from typing import Sequence

import torch
from torch import nn

from gnubg_net import DEFAULT_WD_PATH, GnubgEvaluator, GnubgNetWeights

# Matches DEFAULT_EXTRAS_DIM in agent/sample_trainer.py (career context width).
DEFAULT_EXTRAS_DIM = 40
# gnubg's hidden layer width (all three eval nets use 128).
GNUBG_HIDDEN = 128


class GnubgValueNet(nn.Module):
    """gnubg's frozen evaluator + a trainable style head.

    `equity(board0, board1, extras)` returns the cubeless equity for the side
    on roll (board0), in [-1, 1]: gnubg's own equity plus a style adjustment
    bounded by `style_scale`. Boards are gnubg TanBoards (25 ints each, own
    perspective, index 24 = bar), as produced by agent/gnubg_net.py.
    """

    def __init__(
        self,
        extras_dim: int = DEFAULT_EXTRAS_DIM,
        nets: dict[str, GnubgNetWeights] | None = None,
        wd_path: str | Path = DEFAULT_WD_PATH,
        *,
        style_scale: float = 0.2,
        faithful: bool = False,
    ) -> None:
        super().__init__()
        # Plain attribute (not a submodule): the gnubg backbone is the shared
        # base weights, frozen and deliberately kept out of this net's
        # state_dict / parameters so per-agent checkpoints carry only the head.
        self._gnubg = GnubgEvaluator(nets, wd_path, faithful=faithful)
        for net in (self._gnubg.contact, self._gnubg.race, self._gnubg.crashed):
            for p in net.parameters():
                p.requires_grad_(False)

        self.extras_dim = extras_dim
        self.style_scale = style_scale
        if extras_dim > 0:
            self.style_head = nn.Sequential(
                nn.Linear(GNUBG_HIDDEN + extras_dim, 64),
                nn.Tanh(),
                nn.Linear(64, 1),
            )
            # Zero the final layer so a fresh agent == gnubg until trained.
            with torch.no_grad():
                self.style_head[-1].weight.zero_()
                self.style_head[-1].bias.zero_()
        else:
            self.style_head = None

    def equity(
        self,
        board0: Sequence[int],
        board1: Sequence[int],
        extras: Sequence[float] | torch.Tensor | None = None,
    ) -> torch.Tensor:
        """Cubeless equity (scalar tensor) for board0-to-move. Gradients flow
        only through the style head; the gnubg backbone is frozen."""
        h, base = self._gnubg.features(board0, board1)  # h: [128] detached, base: float
        base_t = torch.tensor(base, dtype=torch.float32)
        if self.style_head is None or extras is None:
            return base_t
        ext = torch.as_tensor(extras, dtype=torch.float32).reshape(-1)
        adj = self.style_scale * torch.tanh(self.style_head(torch.cat([h, ext]))).squeeze(-1)
        return torch.clamp(base_t + adj, -1.0, 1.0)

    def equities(
        self,
        candidates: Sequence[tuple[Sequence[int], Sequence[int]]],
        extras: Sequence[float] | torch.Tensor | None = None,
    ) -> torch.Tensor:
        """Equities for a list of (board0, board1) candidate positions."""
        return torch.stack([self.equity(b0, b1, extras) for b0, b1 in candidates])

    def gnubg_equity(self, board0: Sequence[int], board1: Sequence[int]) -> float:
        """The unmodified gnubg equity for the position (style ignored)."""
        return self._gnubg.evaluate(board0, board1)[1]


# Source the mint helper / model advisor hands to the training pipeline when a
# user picks the gnubg-backed value net. Kept here so the frontend and the
# trainer agree on one definition. `build_model` mirrors the sklearn-agent
# factory contract in agent/sklearn_agent.py.
GNUBG_VALUE_NET_SOURCE = '''"""Per-agent value net backed by GNU Backgammon's published weights.

Adopts gnubg's real contact/race/crashed evaluator as a frozen backbone and
adds a trainable style head, so the agent starts as strong as gnubg and
personalises with training. Boards are gnubg TanBoards (25 ints, own
perspective, index 24 = bar)."""
from gnubg_agent import GnubgValueNet


def build_model(extras_dim: int = 40):
    return GnubgValueNet(extras_dim=extras_dim)
'''
