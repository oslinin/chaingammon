import torch
import torch.nn as nn
from typing import Mapping
from career_features import CareerContext, encode_career_context

_DEFAULT_N_REFERENCE = 64
_REFERENCE_SEED = 12345
_BOARD_DIM = 198

def _reference_boards(n: int, seed: int) -> torch.Tensor:
    """Deterministic battery of random board-feature vectors."""
    g = torch.Generator().manual_seed(seed)
    return torch.randn(n, _BOARD_DIM, generator=g)

class ChallengePolicy:
    """Wrapper around BackgammonNet for per-epoch matchmaking decisions."""

    def __init__(
        self,
        net: nn.Module,
        extras_dim: int = 16,
        n_reference_states: int = _DEFAULT_N_REFERENCE,
        seed: int = _REFERENCE_SEED,
    ):
        self.net = net
        self.extras_dim = extras_dim
        self.reference_boards = _reference_boards(n_reference_states, seed)

    def score_opponent(self, opponent_style: Mapping[str, float], stake_wei: int) -> float:
        """Estimates expected value of playing a specific opponent at a specific stake.

        Returns a scalar float in [0, 1].
        """
        # Ensure we don't accidentally train the network just by evaluating scores,
        # unless gradients are explicitly needed (which we do for REINFORCE).
        # But wait, REINFORCE needs gradient through the score! We should NOT use torch.no_grad() here.

        ctx = CareerContext(
            opponent_style=dict(opponent_style),
            teammate_style=None,
            stake_wei=stake_wei,
            tournament_position=0.0,
            is_team_match=False,
        )

        # [extras_dim] -> [N, extras_dim]
        ext = encode_career_context(ctx, dim=self.extras_dim)
        ext_batch = ext.unsqueeze(0).expand(self.reference_boards.size(0), -1)

        # The reference boards should be on the same device as the net
        device = next(self.net.parameters()).device
        boards = self.reference_boards.to(device)
        ext_batch = ext_batch.to(device)

        # Forward pass
        equities = self.net(boards, ext_batch)
        return equities.mean()

    def size_bet(self, win_prob: float, bankroll_wei: int, min_stake: int, max_fraction: float) -> int:
        """Computes stake to propose given a win probability and current bankroll.

        Returns 0 if the Kelly fraction is negative (expected losing matchup).
        """
        # Kelly criterion prior: f = (win_prob * 2 - 1)
        f = (win_prob * 2.0) - 1.0

        if f <= 0:
            return 0

        raw_stake = f * float(bankroll_wei)

        # Clamp to [min_stake, bankroll_wei * max_fraction]
        max_stake = float(bankroll_wei) * max_fraction

        if raw_stake < min_stake:
            # If the calculated Kelly stake is below the floor, do we clamp UP to min_stake
            # or do we return 0 because we can't afford a Kelly bet?
            # The prompt says: "clamped to [MIN_STAKE, bankroll * MAX_STAKE_FRACTION]"
            # So we clamp up to min_stake.
            raw_stake = float(min_stake)

        if raw_stake > max_stake:
            raw_stake = max_stake

        # Ensure we don't bet more than our actual bankroll if max_fraction > 1.0 (though usually < 1)
        if raw_stake > bankroll_wei:
            raw_stake = bankroll_wei

        return int(raw_stake)
