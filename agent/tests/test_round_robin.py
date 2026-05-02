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
    dominates artificially.

    `infer_fn` is captured (via **kwargs) so I.1 can assert that
    run_round_robin only forwards the kwarg when 0G inference is
    actually wired."""
    calls: list[dict] = []
    counter = {"i": 0}

    def stub(agent, opp, agent_extras, opp_extras, *, gamma, lam, lr, **kwargs):
        calls.append({
            "agent": id(agent), "opp": id(opp),
            "infer_fn": kwargs.get("infer_fn"),
        })
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


# ─── Phase I.1: 0G inference wiring ────────────────────────────────────────


def test_use_0g_inference_off_means_infer_fn_not_passed():
    """Default path: trainer must NOT pass `infer_fn` to td_match when
    use_0g_inference is False. Existing local-mode behaviour preserved."""
    buf = io.StringIO()
    stub, calls = _stub_td_match()
    run_round_robin(
        agent_ids=[1, 2, 3],
        epochs=1,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
        use_0g_inference=False,
    )
    assert all(c["infer_fn"] is None for c in calls)


def test_use_0g_inference_unavailable_falls_back_to_local(monkeypatch):
    """When use_0g_inference=True but the eval bridge probe says no
    provider is registered, the trainer emits a 'warning' JSONL event,
    sets infer_fn=None, and proceeds locally so the run still completes."""
    # Stub estimate to return available=False (the common case today —
    # backgammon-net-v1 isn't registered on the 0G serving network yet).
    import og_compute_eval_client as ec

    class _Unavailable:
        per_inference_og = 0.00001
        total_og = 0.00001
        provider_address = ""
        available = False
        note = "OG_EVAL_UNAVAILABLE: no backgammon-net provider registered"

    monkeypatch.setattr(ec, "estimate", lambda count: _Unavailable())

    buf = io.StringIO()
    stub, calls = _stub_td_match()
    run_round_robin(
        agent_ids=[1, 2],
        epochs=1,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
        use_0g_inference=True,
    )
    events = _read_events(buf)
    warnings = [e for e in events if e["event"] == "warning"]
    assert len(warnings) == 1
    assert warnings[0]["reason"] == "OG_EVAL_UNAVAILABLE"
    assert warnings[0]["fallback"] == "local"
    # Run completes; td_match received None (fell back to local).
    assert all(c["infer_fn"] is None for c in calls)


def test_use_0g_inference_available_passes_infer_fn(monkeypatch):
    """When the probe says available=True, trainer builds an infer_fn
    and forwards it to td_match. Each call to infer_fn dispatches one
    `evaluate(...)` per candidate row; the test asserts the wire is
    intact by stubbing both estimate + evaluate and counting calls."""
    import og_compute_eval_client as ec
    import torch as _torch

    class _Avail:
        per_inference_og = 0.0001
        total_og = 0.0001
        provider_address = "0xprovider"
        available = True
        note = ""

    eval_calls = {"n": 0}

    class _EvalRes:
        def __init__(self, eq):
            self.equity = eq
            self.model = "stub"
            self.provider_address = "0xprovider"

    def _fake_evaluate(features, extras, *, timeout=30.0):
        eval_calls["n"] += 1
        return _EvalRes(0.5)

    monkeypatch.setattr(ec, "estimate", lambda count: _Avail())
    monkeypatch.setattr(ec, "evaluate", _fake_evaluate)

    buf = io.StringIO()
    stub, calls = _stub_td_match()
    run_round_robin(
        agent_ids=[1, 2],
        epochs=1,
        status_fh=buf,
        td_match=stub,
        weights_hash_resolver=lambda aid: "",
        use_0g_inference=True,
    )
    # Probe succeeded → '0g_inference_active' event present.
    events = _read_events(buf)
    active = [e for e in events if e["event"] == "0g_inference_active"]
    assert len(active) == 1
    assert active[0]["provider"] == "0xprovider"

    # Stub td_match captured infer_fn (not None).
    assert all(c["infer_fn"] is not None for c in calls)

    # The infer_fn the trainer built is callable and dispatches
    # evaluate per row of the input batch.
    infer_fn = calls[0]["infer_fn"]
    feats = _torch.zeros(3, 198)
    extras = _torch.zeros(3, 16)
    out = infer_fn(feats, extras)
    assert out.shape == (3,)
    assert eval_calls["n"] == 3


def test_pick_move_infer_fn_overrides_net():
    """Sanity check on sample_trainer.pick_move's new injection point:
    when infer_fn is passed, the chosen candidate must be the argmax
    of infer_fn's output, not the local net's."""
    from sample_trainer import BackgammonNet, RaceState, pick_move

    net = BackgammonNet(extras_dim=16, core_seed=0xBACC, extras_seed=1)
    cands = [RaceState(), RaceState()]
    extras = torch.zeros(16)

    # infer_fn returns equities favoring index 1 regardless of net.
    captured_args: list = []

    def fake_infer(feats, ext):
        captured_args.append((feats.shape, ext.shape if ext is not None else None))
        return torch.tensor([0.1, 0.9])

    chosen, _ = pick_move(net, cands, extras, perspective=0, infer_fn=fake_infer)
    assert chosen is cands[1]
    assert len(captured_args) == 1
    assert captured_args[0][0] == (2, 198)
    assert captured_args[0][1] == (2, 16)
