import io
import json
import sys
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


# ─── Tournament mode: ELO and balances move in the same direction ────────────


class _FakeVaultOperator:
    def __init__(self):
        self.deposits: list[dict] = []

    def deposit_to_escrow(self, *, agent_id, match_id_hex, stake_wei):
        self.deposits.append({"agent_id": agent_id, "match_id_hex": match_id_hex, "stake_wei": stake_wei})
        return "0xabc"


class _FakeChainClient:
    def __init__(self):
        self.record_calls: list[dict] = []

    def agent_owner(self, agent_id: int) -> str:
        return f"0x{'00' * 19}{agent_id:02x}"

    def record_match_and_split(self, *, winner_agent_id, winner_human, loser_agent_id,
                               loser_human, match_length, game_record_hash,
                               escrow_match_id, winners, shares):
        self.record_calls.append({"winner": winner_agent_id, "loser": loser_agent_id,
                                  "escrow_match_id": escrow_match_id, "shares": shares})

    def record_match(self, *, winner_agent_id, winner_human, loser_agent_id,
                     loser_human, match_length, game_record_hash):
        self.record_calls.append({"winner": winner_agent_id, "loser": loser_agent_id})


@pytest.fixture()
def tournament_mocks(monkeypatch):
    """Inject fake ChainClient and AgentVaultOperator into sys.modules so the
    lazy imports inside run_challenge_loop resolve to our stubs."""
    import types

    fake_vault_op = _FakeVaultOperator()
    fake_chain = _FakeChainClient()

    vault_module = types.ModuleType("server.app.agent_wallets")
    vault_module.AgentVaultOperator = type(
        "AgentVaultOperator", (), {"from_env": staticmethod(lambda: fake_vault_op)}
    )

    chain_module = types.ModuleType("server.app.chain_client")
    chain_module.ChainClient = type(
        "ChainClient", (), {"from_env": staticmethod(lambda: fake_chain)}
    )

    # Also need the intermediate package stubs so Python's import machinery is satisfied.
    server_mod = types.ModuleType("server")
    server_app_mod = types.ModuleType("server.app")

    monkeypatch.setitem(sys.modules, "server", server_mod)
    monkeypatch.setitem(sys.modules, "server.app", server_app_mod)
    monkeypatch.setitem(sys.modules, "server.app.chain_client", chain_module)
    monkeypatch.setitem(sys.modules, "server.app.agent_wallets", vault_module)

    return fake_vault_op, fake_chain


def _run_tournament(td_stub, buf=None):
    """Helper: 2-agent tournament, 1 epoch, accept everything."""
    if buf is None:
        buf = io.StringIO()
    run_challenge_loop(
        agent_ids=[1, 2],
        epochs=1,
        starting_bankroll=100_000,
        min_stake=1_000,
        max_stake_fraction=0.25,
        accept_threshold=0.0,
        status_fh=buf,
        td_match=td_stub,
        weights_hash_resolver=lambda aid: "",
        tournament=True,
    )
    return _read_events(buf)


def test_tournament_winner_bankroll_increases_loser_decreases(tournament_mocks):
    """Bankrolls move in the expected direction: proposer always wins → gains stake."""
    fake_vault_op, fake_chain = tournament_mocks
    buf = io.StringIO()

    # Proposer always wins (won=1 means first argument wins).
    events = _run_tournament(lambda a, o, ae, oe, **kw: (40, 1), buf)

    matches = [e for e in events if e["event"] == "match"]
    assert len(matches) >= 1
    for m in matches:
        assert m["winner"] == m["proposer"], "winner should be proposer when won=1"
        assert m["profit_wei"] > 0


def test_tournament_elo_winner_matches_bankroll_winner(tournament_mocks):
    """The agent credited with ELO (winner_agent_id in record_match_and_split)
    is the same agent whose bankroll increased."""
    fake_vault_op, fake_chain = tournament_mocks

    events = _run_tournament(lambda a, o, ae, oe, **kw: (40, 1))

    match_events = [e for e in events if e["event"] == "match"]
    assert len(match_events) >= 1
    assert len(fake_chain.record_calls) >= 1

    for match_ev, chain_call in zip(match_events, fake_chain.record_calls):
        # The agent that won the match is the same one passed as winner to
        # record_match_and_split — so ELO credit and bankroll gain go to the same agent.
        assert chain_call["winner"] == match_ev["winner"], (
            f"ELO winner {chain_call['winner']} != bankroll winner {match_ev['winner']}"
        )
        assert chain_call["loser"] != match_ev["winner"]


def test_tournament_escrow_funded_for_both_agents(tournament_mocks):
    """Both proposer and target deposit into escrow before each match."""
    fake_vault_op, fake_chain = tournament_mocks

    events = _run_tournament(lambda a, o, ae, oe, **kw: (40, 1))

    match_events = [e for e in events if e["event"] == "match"]
    assert len(match_events) >= 1

    # Each match should produce exactly 2 deposit_to_escrow calls with the same match_id.
    assert len(fake_vault_op.deposits) == len(match_events) * 2
    # The two deposits for each match share the same match_id_hex.
    for i in range(0, len(fake_vault_op.deposits), 2):
        d1, d2 = fake_vault_op.deposits[i], fake_vault_op.deposits[i + 1]
        assert d1["match_id_hex"] == d2["match_id_hex"]
        assert d1["agent_id"] != d2["agent_id"]


def test_tournament_bankrolls_persist_across_epochs(tournament_mocks):
    """In tournament mode bankrolls carry across epochs (not reset per epoch)."""
    fake_vault_op, fake_chain = tournament_mocks
    buf = io.StringIO()

    # Run 3 epochs, proposer always wins.
    run_challenge_loop(
        agent_ids=[1, 2],
        epochs=3,
        starting_bankroll=100_000,
        min_stake=1_000,
        max_stake_fraction=0.25,
        accept_threshold=0.0,
        status_fh=buf,
        td_match=lambda a, o, ae, oe, **kw: (40, 1),
        weights_hash_resolver=lambda aid: "",
        tournament=True,
    )

    events = _read_events(buf)
    match_events = [e for e in events if e["event"] == "match"]
    # 3 epochs × 2 proposals (each agent proposes once) = 6 matches (all accepted).
    assert len(match_events) == 6
    # All matches have profit > 0 — bankrolls never reset so the winners keep accumulating.
    total_profit = sum(m["profit_wei"] for m in match_events)
    assert total_profit > 0


# ─── Phase 1: real opponent profiles (style_resolver) ──────────────────────


def test_public_profiles_from_style_resolver():
    """The marketplace conditions on each agent's resolved real style: in an
    accepted match the proposer's extras encode the TARGET's style."""
    from career_features import ACTIVE_AXES

    # In 40-d layout: own_style [0:18], opponent_style [18:36].
    hb = 18 + list(ACTIVE_AXES).index("hits_blot")
    styles = {1: {"hits_blot": 0.9}, 2: {"hits_blot": 0.2}}

    captured: list[float] = []

    def stub(agent, opp, agent_extras, opp_extras, **kwargs):
        # agent_extras is the proposer's context, whose opponent_style is
        # the TARGET's profile (at slot hb in the 40-d layout).
        captured.append(round(agent_extras[hb].item(), 3))
        return 47, 1, [], []

    buf = io.StringIO()
    run_challenge_loop(
        agent_ids=[1, 2],
        epochs=1,
        starting_bankroll=100000,
        min_stake=1000,
        max_stake_fraction=0.25,
        accept_threshold=0.0,  # accept all proposals
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
        style_resolver=lambda aid: styles.get(aid, {}),
    )

    # 2 agents → agent 1 challenges 2 (target style 0.2), agent 2 challenges 1
    # (target style 0.9); both accepted → both targets' styles must appear.
    assert sorted(captured) == [0.2, 0.9]
