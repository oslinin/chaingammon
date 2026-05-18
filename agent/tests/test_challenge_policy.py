import torch
import torch.nn as nn
from challenge_policy import ChallengePolicy

class DummyNet(nn.Module):
    def __init__(self, extras_dim: int):
        super().__init__()
        self.fc = nn.Linear(198 + extras_dim, 1)
        # Initialize weights deterministically to avoid flaky tests
        nn.init.constant_(self.fc.weight, 0.01)
        nn.init.constant_(self.fc.bias, 0.5)

    def forward(self, board, extras):
        x = torch.cat([board, extras], dim=-1)
        return torch.sigmoid(self.fc(x)).squeeze(-1)

def test_score_opponent_returns_float_in_range():
    net = DummyNet(16)
    policy = ChallengePolicy(net, 16)
    score = policy.score_opponent({"opening_slot": 1.0}, 5000)

    assert isinstance(score, torch.Tensor) # Returns a scalar tensor that can backprop
    val = score.item()
    assert 0.0 <= val <= 1.0

def test_two_agents_different_opponent_styles_get_different_scores():
    # If the network has non-zero weights on the extras vector, different styles
    # should produce different scores.
    net = DummyNet(16)
    # Give the extras head some meaningful weights so different inputs matter
    with torch.no_grad():
        net.fc.weight[0, 198:] = torch.arange(16, dtype=torch.float32) * 0.1

    policy = ChallengePolicy(net, 16)
    score1 = policy.score_opponent({"opening_slot": 1.0}, 5000)
    score2 = policy.score_opponent({"hits_blot": -1.0}, 5000)

    assert score1.item() != score2.item()

def test_size_bet_returns_zero_when_win_prob_low():
    net = DummyNet(16)
    policy = ChallengePolicy(net, 16)

    assert policy.size_bet(0.49, 10000, 1000, 0.25) == 0
    assert policy.size_bet(0.50, 10000, 1000, 0.25) == 0

def test_size_bet_respects_clamps():
    net = DummyNet(16)
    policy = ChallengePolicy(net, 16)

    # 0.6 win prob -> Kelly fraction 0.2
    # 0.2 * 100_000 = 20_000
    # max_fraction 0.1 -> cap at 10_000
    assert policy.size_bet(0.6, 100000, 1000, 0.1) == 10000

    # 0.51 win prob -> Kelly fraction 0.02
    # 0.02 * 100_000 = 2_000
    # min_stake = 5000 -> clamp to 5_000
    assert policy.size_bet(0.51, 100000, 5000, 0.25) == 5000

def test_zero_overlay_agent_scores_all_opponents_equally():
    net = DummyNet(16)
    # Zero out the extras head weights completely
    with torch.no_grad():
        net.fc.weight[0, 198:] = 0.0

    policy = ChallengePolicy(net, 16)
    score1 = policy.score_opponent({"opening_slot": 1.0}, 5000)
    score2 = policy.score_opponent({"hits_blot": -1.0}, 5000)

    assert score1.item() == score2.item()
