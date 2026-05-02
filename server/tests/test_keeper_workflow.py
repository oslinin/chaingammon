"""
Tests for Phase 37 KeeperHub workflow orchestrator.

Run with:  cd server && uv run pytest tests/test_keeper_workflow.py -v

Hermetic — chain client, 0G storage, gnubg client, ENS, drand probe
all stubbed. No subprocesses, no network. Covers:

  - get_workflow returns the canonical "all pending" shape for unrun matchIds
  - get_workflow round-trips a persisted workflow
  - Each step's happy path and a failure path
  - Sequential orchestration: one failure aborts; remaining steps stay pending
  - Workflow status transitions: running → ok / failed
  - /keeper-workflow/{id} GET reflects persisted state
  - /keeper-workflow/{id}/run POST triggers a workflow + returns initial state
  - Phase 36 contract tests still pass against the real orchestrator
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import keeper_workflow as kw  # noqa: E402
from app import main as main_module  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def _isolate_persistence(monkeypatch, tmp_path):
    """Each test gets a clean tmp persistence dir so concurrent test
    workers don't collide on /tmp/chaingammon-keeper-workflows."""
    monkeypatch.setattr(kw, "_PERSIST_DIR", tmp_path / "kw")
    kw.reset_for_tests()
    yield
    kw.reset_for_tests()


# ─── canonical shape on first call ─────────────────────────────────────────


def test_get_workflow_returns_all_pending_for_unrun_match():
    wf = kw.get_workflow("match-never-run")
    assert wf.match_id == "match-never-run"
    assert wf.status == "pending"
    assert len(wf.steps) == 8
    assert [s.id for s in wf.steps] == list(kw.STEP_IDS)
    assert all(s.status == "pending" for s in wf.steps)
    assert all(s.duration_ms is None for s in wf.steps)


def test_get_workflow_round_trips_persisted_run():
    wf = kw.Workflow(
        match_id="match-7",
        status="ok",
        steps=[
            kw.WorkflowStep(id=sid, name=kw.STEP_NAMES[sid], status="ok")
            for sid in kw.STEP_IDS
        ],
        started_at="2026-01-01T00:00:00+00:00",
        completed_at="2026-01-01T00:00:10+00:00",
        audit_root_hash="0xaudit",
    )
    kw._save(wf)
    loaded = kw.get_workflow("match-7")
    assert loaded.match_id == "match-7"
    assert loaded.status == "ok"
    assert all(s.status == "ok" for s in loaded.steps)
    assert loaded.audit_root_hash == "0xaudit"


# ─── individual step coverage ──────────────────────────────────────────────


def _stub_chain_with_match(record_hash="0x" + "ab" * 32):
    chain = MagicMock()
    chain.get_match.return_value = {
        "timestamp": 1700000000,
        "winnerAgentId": 1,
        "winnerHuman": "0x0000000000000000000000000000000000000000",
        "loserAgentId": 0,
        "loserHuman": "0x" + "11" * 20,
        "matchLength": 3,
        "gameRecordHash": record_hash,
    }
    return chain


def test_step_escrow_deposit_ok():
    chain = _stub_chain_with_match()
    ctx = kw.WorkflowContext(match_id="42", chain=chain)
    step = kw.WorkflowStep(id="escrow_deposit", name="x")
    kw.step_escrow_deposit(ctx, step)
    assert ctx.match_info is not None
    assert "MatchInfo found on-chain" in step.detail


def test_step_escrow_deposit_missing_chain_raises():
    ctx = kw.WorkflowContext(match_id="42")
    step = kw.WorkflowStep(id="escrow_deposit", name="x")
    with pytest.raises(RuntimeError, match="chain client"):
        kw.step_escrow_deposit(ctx, step)


def test_step_escrow_deposit_zero_timestamp_raises():
    chain = MagicMock()
    chain.get_match.return_value = {
        "timestamp": 0,
        "winnerAgentId": 0,
        "winnerHuman": "0x" + "00" * 20,
        "loserAgentId": 0,
        "loserHuman": "0x" + "00" * 20,
        "matchLength": 0,
        "gameRecordHash": "0x" + "00" * 32,
    }
    ctx = kw.WorkflowContext(match_id="42", chain=chain)
    step = kw.WorkflowStep(id="escrow_deposit", name="x")
    with pytest.raises(RuntimeError, match="zero MatchInfo"):
        kw.step_escrow_deposit(ctx, step)


def test_step_escrow_deposit_non_int_match_id_raises():
    ctx = kw.WorkflowContext(match_id="abc-not-an-int", chain=MagicMock())
    step = kw.WorkflowStep(id="escrow_deposit", name="x")
    with pytest.raises(RuntimeError, match="on-chain matchId"):
        kw.step_escrow_deposit(ctx, step)


def test_step_vrf_rolls_ok():
    ctx = kw.WorkflowContext(match_id="42", drand_check=lambda: True)
    step = kw.WorkflowStep(id="vrf_rolls", name="x")
    kw.step_vrf_rolls(ctx, step)
    assert "Drand" in step.detail


def test_step_vrf_rolls_unreachable_raises():
    ctx = kw.WorkflowContext(match_id="42", drand_check=lambda: False)
    step = kw.WorkflowStep(id="vrf_rolls", name="x")
    with pytest.raises(RuntimeError, match="drand network unreachable"):
        kw.step_vrf_rolls(ctx, step)


def test_step_og_storage_fetch_ok():
    record = {
        "match_length": 3,
        "moves": [{"move": "13/10 24/23"}],
        "final_position_id": "FINAL_POS",
    }
    blob = json.dumps(record).encode()
    ctx = kw.WorkflowContext(
        match_id="42",
        match_info={"gameRecordHash": "0xab" + "cd" * 31},
        og_get_blob=lambda h: blob,
    )
    step = kw.WorkflowStep(id="og_storage_fetch", name="x")
    kw.step_og_storage_fetch(ctx, step)
    assert ctx.game_record == record
    assert ctx.final_position_id == "FINAL_POS"
    assert "GameRecord fetched" in step.detail


def test_step_og_storage_fetch_zero_hash_raises():
    ctx = kw.WorkflowContext(
        match_id="42",
        match_info={"gameRecordHash": "0x" + "00" * 32},
        og_get_blob=lambda h: b"",
    )
    step = kw.WorkflowStep(id="og_storage_fetch", name="x")
    with pytest.raises(RuntimeError, match="game_record_hash"):
        kw.step_og_storage_fetch(ctx, step)


def test_step_gnubg_replay_ok():
    """Stubbed gnubg returns a sequence of position_ids; replay walks
    them; final position matches recorded value."""
    gnubg = MagicMock()
    gnubg.new_match.return_value = {"position_id": "P0", "match_id": "M0"}
    # Three moves; after each, gnubg returns a deterministic next pos.
    gnubg.submit_move.side_effect = [
        {"position_id": "P1", "match_id": "M1", "output": ""},
        {"position_id": "P2", "match_id": "M2", "output": ""},
        {"position_id": "FINAL", "match_id": "M3", "output": ""},
    ]
    ctx = kw.WorkflowContext(
        match_id="42",
        gnubg=gnubg,
        game_record={
            "match_length": 1,
            "moves": [
                {"move": "13/10 24/23"},
                {"move": "8/5 6/5"},
                {"move": "off"},
            ],
            "final_position_id": "FINAL",
        },
    )
    step = kw.WorkflowStep(id="gnubg_replay", name="x")
    kw.step_gnubg_replay(ctx, step)
    assert "Replayed 3 moves" in step.detail


def test_step_gnubg_replay_position_mismatch_raises():
    gnubg = MagicMock()
    gnubg.new_match.return_value = {"position_id": "P0", "match_id": "M0"}
    gnubg.submit_move.side_effect = [
        {"position_id": "DIFFERENT", "match_id": "M1", "output": ""},
    ]
    ctx = kw.WorkflowContext(
        match_id="42",
        gnubg=gnubg,
        game_record={
            "match_length": 1,
            "moves": [{"move": "13/10 24/23"}],
            "final_position_id": "EXPECTED_FINAL",
        },
    )
    step = kw.WorkflowStep(id="gnubg_replay", name="x")
    with pytest.raises(RuntimeError, match="final position mismatch"):
        kw.step_gnubg_replay(ctx, step)


def test_step_gnubg_replay_skips_auto_played_moves():
    """Bar-dance moves are recorded as '(auto-played)' in MoveEntry — the
    replayer must skip them rather than ask gnubg to apply an empty move."""
    gnubg = MagicMock()
    gnubg.new_match.return_value = {"position_id": "FINAL", "match_id": "M0"}
    ctx = kw.WorkflowContext(
        match_id="42",
        gnubg=gnubg,
        game_record={
            "match_length": 1,
            "moves": [{"move": "(auto-played)"}],
            "final_position_id": "FINAL",
        },
    )
    step = kw.WorkflowStep(id="gnubg_replay", name="x")
    kw.step_gnubg_replay(ctx, step)
    # No real submit_move call should have happened.
    assert gnubg.submit_move.call_count == 0


def test_step_gnubg_replay_rejected_move_raises():
    gnubg = MagicMock()
    gnubg.new_match.return_value = {"position_id": "P0", "match_id": "M0"}
    gnubg.submit_move.return_value = {
        "position_id": "", "match_id": "", "output": "illegal",
    }
    ctx = kw.WorkflowContext(
        match_id="42",
        gnubg=gnubg,
        game_record={
            "match_length": 1,
            "moves": [{"move": "13/10 24/23"}],
            "final_position_id": "X",
        },
    )
    step = kw.WorkflowStep(id="gnubg_replay", name="x")
    with pytest.raises(RuntimeError, match="gnubg rejected move"):
        kw.step_gnubg_replay(ctx, step)


def test_step_relay_tx_surfaces_record_hash():
    ctx = kw.WorkflowContext(
        match_id="42",
        match_info={"gameRecordHash": "0xab" + "cd" * 31},
    )
    step = kw.WorkflowStep(id="relay_tx", name="x")
    kw.step_relay_tx(ctx, step)
    assert step.tx_hash == "0xab" + "cd" * 31


def test_step_audit_append_uploads_workflow_json():
    """audit_append serializes the workflow and uploads via og_put_blob;
    the returned root_hash is recorded on the workflow + the step."""
    captured = {}

    class _Upload:
        def __init__(self, root_hash):
            self.root_hash = root_hash

    def fake_put(blob: bytes):
        captured["blob"] = blob
        return _Upload("0xaudit-root")

    ctx = kw.WorkflowContext(match_id="42", og_put_blob=fake_put)
    step = kw.WorkflowStep(id="audit_append", name="x")
    workflow = kw._empty_workflow("42")
    kw.step_audit_append(ctx, step, workflow=workflow)
    assert workflow.audit_root_hash == "0xaudit-root"
    assert step.tx_hash == "0xaudit-root"
    parsed = json.loads(captured["blob"])
    assert parsed["matchId"] == "42"
    assert "steps" in parsed


def test_step_audit_append_skips_when_no_storage():
    ctx = kw.WorkflowContext(match_id="42", og_put_blob=None)
    step = kw.WorkflowStep(id="audit_append", name="x")
    workflow = kw._empty_workflow("42")
    kw.step_audit_append(ctx, step, workflow=workflow)
    assert "skipped" in step.detail.lower()


# ─── orchestration ──────────────────────────────────────────────────────────


def test_run_workflow_happy_path_marks_all_ok():
    """Inject runner stubs that all succeed; assert workflow.status == 'ok'
    and all 8 steps recorded ok."""
    runners = {sid: lambda ctx, step: None for sid in kw.STEP_IDS}
    # audit_append takes a kwarg; wrap separately.
    runners["audit_append"] = lambda ctx, step, *, workflow: None
    wf = kw.run_workflow("42", runners=runners)
    assert wf.status == "ok"
    assert all(s.status == "ok" for s in wf.steps)
    assert wf.completed_at is not None


def test_run_workflow_step_failure_aborts_remainder():
    """Step 4 (gnubg_replay) raises; remaining steps stay pending."""
    def _fail(ctx, step):
        raise RuntimeError("simulated mismatch")

    runners = {sid: lambda ctx, step: None for sid in kw.STEP_IDS}
    runners["gnubg_replay"] = _fail
    runners["audit_append"] = lambda ctx, step, *, workflow: None
    wf = kw.run_workflow("42", runners=runners)
    assert wf.status == "failed"
    statuses = [s.status for s in wf.steps]
    assert statuses[:3] == ["ok", "ok", "ok"]
    assert statuses[3] == "failed"
    assert wf.steps[3].error == "simulated mismatch"
    # Remainder pending.
    assert all(s == "pending" for s in statuses[4:])


def test_run_workflow_persists_to_disk():
    runners = {sid: lambda ctx, step: None for sid in kw.STEP_IDS}
    runners["audit_append"] = lambda ctx, step, *, workflow: None
    kw.run_workflow("42", runners=runners)
    persisted = kw.get_workflow("42")
    assert persisted.status == "ok"


def test_run_workflow_records_step_durations():
    """Each step's duration_ms is filled in (could be 0 for ultra-fast
    stubs but never None on a step that ran)."""
    runners = {sid: lambda ctx, step: None for sid in kw.STEP_IDS}
    runners["audit_append"] = lambda ctx, step, *, workflow: None
    wf = kw.run_workflow("42", runners=runners)
    for s in wf.steps:
        assert s.duration_ms is not None
        assert s.duration_ms >= 0


# ─── HTTP endpoints ────────────────────────────────────────────────────────


def test_endpoint_get_returns_canonical_shape_for_unrun_match():
    """Phase 36 contract: 8 canonical step IDs in order, all valid statuses,
    every step has the required field set. Real orchestrator preserves
    this for matchIds that have never run."""
    r = client.get("/keeper-workflow/never-run-id")
    assert r.status_code == 200
    body = r.json()
    assert body["matchId"] == "never-run-id"
    assert body["status"] == "pending"
    assert [s["id"] for s in body["steps"]] == list(kw.STEP_IDS)
    for s in body["steps"]:
        assert s["status"] in ("pending", "running", "ok", "failed")


def test_endpoint_get_reflects_persisted_run():
    wf = kw.Workflow(
        match_id="m9",
        status="ok",
        steps=[
            kw.WorkflowStep(id=sid, name=kw.STEP_NAMES[sid], status="ok",
                            duration_ms=42)
            for sid in kw.STEP_IDS
        ],
    )
    kw._save(wf)
    r = client.get("/keeper-workflow/m9")
    body = r.json()
    assert body["status"] == "ok"
    assert all(s["status"] == "ok" for s in body["steps"])


def test_endpoint_run_post_triggers_workflow(monkeypatch):
    """POST /keeper-workflow/{id}/run spawns the orchestrator on a thread.
    We patch every external dependency so the workflow runs to completion
    against stubs and returns the persisted final state on the next GET."""
    chain = _stub_chain_with_match()
    record = {
        "match_length": 1,
        "moves": [{"move": "13/10 24/23"}],
        "final_position_id": "FINAL",
    }
    blob = json.dumps(record).encode()

    monkeypatch.setattr(main_module.ChainClient, "from_env",
                        classmethod(lambda cls: chain))
    monkeypatch.setattr(main_module, "get_blob", lambda h: blob)
    class _Upload:
        root_hash = "0xaudit-root"
    monkeypatch.setattr(main_module, "put_blob", lambda b: _Upload())
    monkeypatch.setattr(main_module, "_try_drand_check", lambda: True)
    fake_gnubg = MagicMock()
    fake_gnubg.new_match.return_value = {"position_id": "P0", "match_id": "M0"}
    fake_gnubg.submit_move.return_value = {
        "position_id": "FINAL", "match_id": "M1", "output": "",
    }
    monkeypatch.setattr(main_module, "gnubg", fake_gnubg)
    # ENS — return None so step_ens_update skips cleanly.
    from app.ens_client import EnsError
    monkeypatch.setattr(main_module.EnsClient, "from_env",
                        classmethod(lambda cls: (_ for _ in ()).throw(EnsError("no ens"))))

    r = client.post("/keeper-workflow/42/run")
    assert r.status_code == 200
    # Wait briefly for the background thread to complete (8 stubbed steps).
    deadline = time.time() + 5.0
    while time.time() < deadline:
        body = client.get("/keeper-workflow/42").json()
        if body["status"] in ("ok", "failed"):
            break
        time.sleep(0.05)
    body = client.get("/keeper-workflow/42").json()
    assert body["status"] == "ok", body


# ─── Phase 36 contract regression ──────────────────────────────────────────
#
# The original test_phase36_keeper_mock.py tests the same response shape;
# this re-runs the most-load-bearing assertions through the real
# orchestrator's empty-pending fallback to be doubly sure Phase 37 didn't
# accidentally break the shape.


def test_phase36_response_shape_preserved():
    r = client.get("/keeper-workflow/regression-id")
    body = r.json()
    assert "matchId" in body
    assert "status" in body
    assert "steps" in body
    assert len(body["steps"]) == 8
    expected_fields = {"id", "name", "status", "duration_ms", "retry_count",
                       "tx_hash", "error", "detail"}
    for step in body["steps"]:
        assert expected_fields.issubset(step.keys())


def test_phase36_deterministic_same_id():
    """Same matchId returns the same response across two GETs."""
    r1 = client.get("/keeper-workflow/stable-xyz").json()
    r2 = client.get("/keeper-workflow/stable-xyz").json()
    assert r1 == r2
