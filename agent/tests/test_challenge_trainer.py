import io
import json
import pytest
import torch
import torch.nn as nn
from challenge_trainer import run_challenge_loop

def _stub_td_match():
    calls = []
    def stub(agent, opp, agent_extras, opp_extras, **kwargs):
        calls.append(kwargs)
        # Always fixed winner: agent wins
        return 47, 1
    return stub, calls

def _read_events(buf: io.StringIO) -> list[dict]:
    buf.seek(0)
    lines = buf.read().strip().split("\n")
    return [json.loads(line) for line in lines if line]

# Mock load_or_seed so the network predicts > 0.5 for all states, ensuring Kelly size_bet > 0
from agent_state_io import AgentState
import challenge_trainer

class DummyNet(nn.Module):
    def __init__(self, extras_dim: int):
        super().__init__()
        self.fc = nn.Linear(198 + extras_dim, 1)
        nn.init.constant_(self.fc.weight, 0.0)
        nn.init.constant_(self.fc.bias, 2.0) # Sigmoid(2.0) > 0.5 -> win_prob > 0.5
        self.extras = self.fc

    def forward(self, board, extras):
        x = torch.cat([board, extras], dim=-1)
        return torch.sigmoid(self.fc(x)).squeeze(-1)

def _mock_load_or_seed(aid, extras_dim, weights_hash, fetch):
    net = DummyNet(extras_dim)
    return AgentState(
        agent_id=aid,
        net=net,
        extras_dim=extras_dim,
        profile_kind="fresh",
        starting_match_count=0
    )

@pytest.fixture(autouse=True)
def patch_load_or_seed(monkeypatch):
    monkeypatch.setattr(challenge_trainer, "load_or_seed", _mock_load_or_seed)

def test_3_agent_run_completes_and_emits_done():
    buf = io.StringIO()
    stub, calls = _stub_td_match()

    run_challenge_loop(
        agent_ids=[1, 2, 3],
        epochs=1,
        starting_bankroll=100000,
        min_stake=1000,
        max_stake_fraction=0.25,
        accept_threshold=0.0, # Accept everything
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "", # fresh init
    )

    events = _read_events(buf)
    assert any(e["event"] == "training_complete" for e in events)

def test_challenge_proposed_emitted():
    buf = io.StringIO()
    stub, calls = _stub_td_match()

    run_challenge_loop(
        agent_ids=[1, 2],
        epochs=1,
        starting_bankroll=100000,
        min_stake=1000,
        max_stake_fraction=0.25,
        accept_threshold=0.0,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )

    events = _read_events(buf)
    proposals = [e for e in events if e["event"] == "challenge_proposed"]

    # 2 agents, 1 epoch -> each proposes once
    assert len(proposals) == 2

def test_winner_bankroll_increases():
    buf = io.StringIO()

    def stub(agent, opp, agent_extras, opp_extras, **kwargs):
        return 47, 1

    run_challenge_loop(
        agent_ids=[1, 2],
        epochs=1,
        starting_bankroll=100000,
        min_stake=1000,
        max_stake_fraction=0.25,
        accept_threshold=0.0,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )

    events = _read_events(buf)
    matches = [e for e in events if e["event"] == "match"]
    assert len(matches) == 2
    for match in matches:
        assert match["winner"] == match["proposer"]
        assert match["profit_wei"] > 0

def test_score_always_below_threshold_emits_rejected_only():
    buf = io.StringIO()
    stub, calls = _stub_td_match()

    run_challenge_loop(
        agent_ids=[1, 2],
        epochs=1,
        starting_bankroll=100000,
        min_stake=1000,
        max_stake_fraction=0.25,
        accept_threshold=1.5, # Impossible score, will always reject
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )

    events = _read_events(buf)
    rejections = [e for e in events if e["event"] == "challenge_rejected"]
    acceptances = [e for e in events if e["event"] == "challenge_accepted"]
    matches = [e for e in events if e["event"] == "match"]

    assert len(rejections) == 2
    assert len(acceptances) == 0
    assert len(matches) == 0

    epoch_end = next(e for e in events if e["event"] == "epoch_end")
    assert epoch_end["accept_rate"] == 0.0

def test_accept_rate_in_epoch_end():
    buf = io.StringIO()
    stub, calls = _stub_td_match()

    run_challenge_loop(
        agent_ids=[1, 2],
        epochs=1,
        starting_bankroll=100000,
        min_stake=1000,
        max_stake_fraction=0.25,
        accept_threshold=0.0,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )

    events = _read_events(buf)
    epoch_end = next(e for e in events if e["event"] == "epoch_end")
    assert epoch_end["accept_rate"] == 1.0
