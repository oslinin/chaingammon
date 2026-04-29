"""tests/test_axl_node.py — Two in-process nodes exchange one full match cycle."""

import threading
import time
from typing import Optional

import pytest

from backgammon.axl.messages import Announce, Challenge, MatchResult
from backgammon.axl.node import AXLTransport, BackgammonNode
from backgammon.net import BackgammonNet


# ── Mock transport ────────────────────────────────────────────────────────────

class InProcessTransport(AXLTransport):
    """Delivers messages directly to the target node (no network)."""

    def __init__(self) -> None:
        self._nodes: dict[str, "BackgammonNode"] = {}

    def register(self, node_id: str, node: "BackgammonNode") -> None:
        self._nodes[node_id] = node

    def send(self, peer_id: str, message: dict) -> None:
        node = self._nodes.get(peer_id)
        if node is not None:
            node.handle_message(message)

    def list_peers(self):
        return list(self._nodes.keys())


# ── Helpers ────────────────────────────────────────────────────────────────────

def _make_node(agent_id: str, transport: InProcessTransport, seed: int = 0) -> BackgammonNode:
    net = BackgammonNet(hidden=32)
    return BackgammonNode(
        agent_id=agent_id,
        net=net,
        transport=transport,
        seed=seed,
        enable_storage=False,
        enable_chain=False,
    )


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_announce_adds_peer():
    transport = InProcessTransport()
    node_a = _make_node("node-a", transport, seed=1)
    node_b = _make_node("node-b", transport, seed=2)
    transport.register("node-a", node_a)
    transport.register("node-b", node_b)

    # A announces to B
    ann = Announce(agent_id="node-a", checkpoint_hash="0xabc", elo=1550.0, generation=5)
    node_b.handle_message(ann.to_dict())

    assert "node-a" in node_b._peers
    assert node_b._peers["node-a"]["elo"] == 1550.0


def test_challenge_produces_match_result():
    """Node A challenges node B; both ELOs update after the match."""
    transport = InProcessTransport()
    node_a = _make_node("node-a", transport, seed=10)
    node_b = _make_node("node-b", transport, seed=20)
    transport.register("node-a", node_a)
    transport.register("node-b", node_b)

    # Seed peer info so A knows about B and vice-versa.
    node_a._add_peer("node-b", {"elo": 1500.0})
    node_b._add_peer("node-a", {"elo": 1500.0})

    elo_a_before = node_a.elo
    elo_b_before = node_b.elo

    # A challenges B (5 games for speed).
    chal = Challenge(from_id="node-a", n_games=5, seed=42)
    node_b.handle_message(chal.to_dict())  # B plays and reports back to A.

    # A then also plays its side and handles the result it would have received.
    score_a, score_b = node_a._play_match_vs_peer("node-b", 5, 42)
    result = MatchResult(
        agent_a="node-a", agent_b="node-b",
        score_a=score_a, score_b=score_b, n_games=5
    )
    node_a._handle_match_result(result)

    # Both nodes' ELO should have changed consistently.
    assert node_a.elo != elo_a_before or node_b.elo != elo_b_before, \
        "At least one ELO should change after a match"


def test_elo_sum_conserved():
    """ELO gained by one agent should approximately equal ELO lost by the other."""
    transport = InProcessTransport()
    node_a = _make_node("node-a", transport, seed=7)
    node_b = _make_node("node-b", transport, seed=8)
    transport.register("node-a", node_a)
    transport.register("node-b", node_b)

    node_a._add_peer("node-b", {"elo": 1500.0})
    node_b._add_peer("node-a", {"elo": 1500.0})

    initial_sum = node_a.elo + node_b.elo

    # Play the same match for both sides.
    seed = 99
    n = 20
    score_a, score_b = node_a._play_match_vs_peer("node-b", n, seed)

    result_a = MatchResult(agent_a="node-a", agent_b="node-b",
                           score_a=score_a, score_b=score_b, n_games=n)
    result_b = MatchResult(agent_a="node-b", agent_b="node-a",
                           score_a=score_b, score_b=score_a, n_games=n)
    node_a._handle_match_result(result_a)
    node_b._handle_match_result(result_b)

    final_sum = node_a.elo + node_b.elo
    # ELO is zero-sum: sum should be preserved within floating-point tolerance.
    assert abs(final_sum - initial_sum) < 0.1, \
        f"ELO sum not conserved: {initial_sum} → {final_sum}"


def test_message_routing_via_transport():
    """In-process transport delivers Announce to the correct node."""
    transport = InProcessTransport()
    node_a = _make_node("node-a", transport)
    node_b = _make_node("node-b", transport)
    transport.register("node-a", node_a)
    transport.register("node-b", node_b)

    # A uses transport to send an Announce to B.
    ann = Announce(agent_id="node-a", checkpoint_hash="0xhash", elo=1600.0, generation=10)
    transport.send("node-b", ann.to_dict())

    assert "node-a" in node_b._peers
    assert node_b._peers["node-a"]["elo"] == 1600.0
