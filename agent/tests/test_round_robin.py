"""Tests for round_robin_trainer.run_round_robin.

Run with:  cd agent && uv run pytest tests/test_round_robin.py -v

Hermetic — `td_match` is monkey-patched to a deterministic stub so the
test covers pairing, JSONL emission, agent loading, and checkpoint
output without spending a real training run's worth of compute.
"""
from __future__ import annotations

import io
import json
import math
from itertools import combinations
from pathlib import Path
from typing import Iterator

import pytest
import torch

from agent_state_io import AgentState
from round_robin_trainer import _emit, _maybe_open_status_file, run_round_robin
from sample_trainer import BackgammonNet


def _read_events(buf: io.StringIO) -> list[dict]:
    """Parse a StringIO of JSONL-emitted events into dict list."""
    buf.seek(0)
    return [json.loads(line) for line in buf.read().splitlines() if line]


def _stub_td_match():
    """Return a `td_match` stub plus a list capturing the calls.
    The stub returns deterministic (steps, won) so tests can predict
    winners exactly. Winner pattern alternates so neither agent
    dominates artificially."""
    calls: list[tuple] = []
    counter = {"i": 0}

    def stub(agent, opp, agent_extras, opp_extras, *, gamma, lam, lr):
        calls.append((id(agent), id(opp)))
        counter["i"] += 1
        steps = 30 + counter["i"]   # distinct plies per match for sanity
        won = counter["i"] % 2      # 0/1 alternation
        return steps, won

    return stub, calls


def test_pair_count_matches_combinations():
    """epochs * C(N, 2) match events must be emitted, no more no less."""
    buf = io.StringIO()
    stub, calls = _stub_td_match()

    run_round_robin(
        agent_ids=[1, 2, 3, 4],
        epochs=3,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",  # all fresh
    )

    events = _read_events(buf)
    matches = [e for e in events if e["event"] == "match"]
    expected = 3 * (4 * 3 // 2)  # 3 epochs × C(4,2) = 18
    assert len(matches) == expected
    assert len(calls) == expected


def test_pair_set_is_canonical_combinations():
    """Each unordered pair appears exactly once per epoch and the
    pair set equals `itertools.combinations(agent_ids, 2)`."""
    buf = io.StringIO()
    stub, _ = _stub_td_match()

    agent_ids = [10, 20, 30]
    run_round_robin(
        agent_ids=agent_ids,
        epochs=2,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )

    events = _read_events(buf)
    expected_pairs = sorted(tuple(p) for p in combinations(agent_ids, 2))
    for epoch in range(2):
        epoch_pairs = sorted(
            (e["agent_a"], e["agent_b"])
            for e in events
            if e["event"] == "match" and e["epoch"] == epoch
        )
        assert epoch_pairs == expected_pairs


def test_event_order_started_loaded_epochs_match():
    """Events must arrive in well-formed sequence: started → agents_loaded
    → (epoch_start, match*, epoch_end)+ → (no done — the run_round_robin
    function does not emit done; CLI main() does)."""
    buf = io.StringIO()
    stub, _ = _stub_td_match()
    run_round_robin(
        agent_ids=[1, 2],
        epochs=2,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )
    events = _read_events(buf)
    kinds = [e["event"] for e in events]
    assert kinds[0] == "started"
    assert kinds[1] == "agents_loaded"
    # First epoch: epoch_start, match, epoch_end
    assert kinds[2] == "epoch_start"
    assert kinds[3] == "match"
    assert kinds[4] == "epoch_end"
    # Second epoch
    assert kinds[5] == "epoch_start"
    assert kinds[6] == "match"
    assert kinds[7] == "epoch_end"


def test_seed_fresh_when_no_weights_hash():
    """`agents_loaded` event must classify all agents as 'fresh' when
    `weights_hash_resolver` returns empty."""
    buf = io.StringIO()
    stub, _ = _stub_td_match()
    run_round_robin(
        agent_ids=[1, 2, 3],
        epochs=1,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )
    events = _read_events(buf)
    loaded = next(e for e in events if e["event"] == "agents_loaded")
    assert loaded["loaded"] == {"1": "fresh", "2": "fresh", "3": "fresh"}


def test_winner_field_is_one_of_the_pair():
    """The 'winner' field must always be either agent_a or agent_b."""
    buf = io.StringIO()
    stub, _ = _stub_td_match()
    run_round_robin(
        agent_ids=[5, 10, 15],
        epochs=2,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )
    events = _read_events(buf)
    for e in events:
        if e["event"] != "match":
            continue
        assert e["winner"] in (e["agent_a"], e["agent_b"])


def test_returns_agent_states_for_each_id():
    """The function returns a dict keyed by agent_id; each value is an
    `AgentState` whose net is a real `BackgammonNet`."""
    buf = io.StringIO()
    stub, _ = _stub_td_match()
    agents = run_round_robin(
        agent_ids=[7, 11],
        epochs=1,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )
    assert set(agents.keys()) == {7, 11}
    for state in agents.values():
        assert isinstance(state, AgentState)
        assert isinstance(state.net, BackgammonNet)
        assert state.profile_kind == "fresh"


def test_min_two_agents_required():
    buf = io.StringIO()
    stub, _ = _stub_td_match()
    with pytest.raises(ValueError, match="at least 2"):
        run_round_robin(
            agent_ids=[1],
            epochs=1,
            status_fh=buf,
            td_match=stub,
            weights_hash_resolver=lambda aid: "",
        )


def test_epochs_must_be_positive():
    buf = io.StringIO()
    stub, _ = _stub_td_match()
    with pytest.raises(ValueError, match="epochs"):
        run_round_robin(
            agent_ids=[1, 2],
            epochs=0,
            status_fh=buf,
            td_match=stub,
            weights_hash_resolver=lambda aid: "",
        )


def test_checkpoint_save_writes_per_agent_pt(tmp_path: Path):
    """When `checkpoint_dir` is set, the trainer writes `agent-<id>.pt`
    per agent and emits an `agent_saved` event per file."""
    buf = io.StringIO()
    stub, _ = _stub_td_match()
    ckpt_dir = tmp_path / "ckpt"
    run_round_robin(
        agent_ids=[1, 2, 3],
        epochs=1,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
        checkpoint_dir=ckpt_dir,
        upload=False,
    )
    files = sorted(p.name for p in ckpt_dir.glob("*.pt"))
    assert files == ["agent-1.pt", "agent-2.pt", "agent-3.pt"]

    events = _read_events(buf)
    saved = [e for e in events if e["event"] == "agent_saved"]
    assert {e["agent_id"] for e in saved} == {1, 2, 3}
    for e in saved:
        # Without upload, root_hash is None.
        assert e["root_hash"] is None


def test_no_checkpoint_save_when_dir_unset():
    """`checkpoint_dir=None` skips the save phase entirely; no
    `agent_saved` event."""
    buf = io.StringIO()
    stub, _ = _stub_td_match()
    run_round_robin(
        agent_ids=[1, 2],
        epochs=1,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
        checkpoint_dir=None,
    )
    events = _read_events(buf)
    assert not any(e["event"] == "agent_saved" for e in events)


def test_status_fh_none_does_not_raise():
    """`run_round_robin` with `status_fh=None` runs silently — no events
    emitted, no exceptions, training still happens."""
    stub, calls = _stub_td_match()
    run_round_robin(
        agent_ids=[1, 2],
        epochs=2,
        status_fh=None,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )
    # 2 epochs × C(2,2)=1 → 2 matches expected.
    assert len(calls) == 2


def test_use_0g_inference_flag_is_recorded():
    """The flag is propagated to the 'started' event payload so the
    backend's status reader can show 'running on: 0G inference'."""
    buf = io.StringIO()
    stub, _ = _stub_td_match()
    run_round_robin(
        agent_ids=[1, 2],
        epochs=1,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
        use_0g_inference=True,
    )
    started = _read_events(buf)[0]
    assert started["event"] == "started"
    assert started["use_0g_inference"] is True


def test_total_games_in_started_event():
    """`started` carries `total_games = epochs × C(N,2)` so the frontend
    progress bar has a denominator without re-counting."""
    buf = io.StringIO()
    stub, _ = _stub_td_match()
    run_round_robin(
        agent_ids=[1, 2, 3, 4, 5],
        epochs=4,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
    )
    started = _read_events(buf)[0]
    assert started["total_games"] == 4 * (5 * 4 // 2)
    assert started["games_per_epoch"] == (5 * 4 // 2)


# ─── load_or_seed integration via the resolver ─────────────────────────────


def test_resolver_routes_to_load_or_seed_branch():
    """When `weights_hash_resolver` returns a non-zero hash, the agent
    is loaded via `load_profile` (here mocked through `fetch_blob`).
    The loaded profile_kind appears in `agents_loaded`."""
    # Build a real model checkpoint blob so load_profile sniffs it as
    # a torch checkpoint (zip magic bytes).
    import io as _io
    net = BackgammonNet(extras_dim=16, core_seed=0xBACC, extras_seed=42)
    blob_buf = _io.BytesIO()
    torch.save(
        {"model": net.state_dict(), "match_count": 7, "extras_dim": 16, "in_dim": 198},
        blob_buf,
    )
    blob_bytes = blob_buf.getvalue()

    def fake_fetch(root_hash: str) -> bytes:
        return blob_bytes

    buf = io.StringIO()
    stub, _ = _stub_td_match()
    run_round_robin(
        agent_ids=[1, 2],
        epochs=1,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "0xdeadbeef" + ("0" * 56),
        fetch_blob=fake_fetch,
    )
    loaded_event = next(e for e in _read_events(buf) if e["event"] == "agents_loaded")
    assert loaded_event["loaded"] == {"1": "model", "2": "model"}
