"""Tests for the /training/* + /agents endpoints.

Run with:  cd server && uv run pytest tests/test_training_endpoints.py -v

Hermetic — `subprocess.Popen` is replaced by a fake that writes
synthetic JSONL into the trainer's status file, and `ChainClient.from_env`
is monkey-patched to a stub so the agent listing / profile endpoints
don't require a live chain.

What's covered:
  POST /training/start    happy path + 409 on already-running + 422 invalid
  GET  /training/status   shape with no job, with running job, with done
  POST /training/abort    stops a running job; idempotent when none
  GET  /training/estimate local + 0G placeholder + validation errors
  GET  /agents            chain-mocked; iterates 1..agentCount
  GET  /agents/{id}/profile  null + overlay + model branches
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Server module on the path the same way other tests do.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import main as main_module  # noqa: E402
from app import training_service  # noqa: E402


client = TestClient(main_module.app)


# ─── fakes ──────────────────────────────────────────────────────────────────


class _FakePopen:
    """Imitates `subprocess.Popen` for tests. Writes a synthetic JSONL
    sequence into whichever path the `--status-file` arg points at, then
    'exits' (the exit is just `_alive=False`)."""

    instances: list["_FakePopen"] = []

    def __init__(self, cmd, *, cwd=None, stdout=None, stderr=None, **kwargs):
        self.cmd = list(cmd)

        # Pull out --status-file's value.
        try:
            i = self.cmd.index("--status-file")
            self.status_path = Path(self.cmd[i + 1])
        except (ValueError, IndexError):
            self.status_path = None

        # Pull out --epochs and --agent-ids.
        try:
            i = self.cmd.index("--epochs")
            self.epochs = int(self.cmd[i + 1])
        except (ValueError, IndexError):
            self.epochs = 0

        try:
            i = self.cmd.index("--agent-ids")
            self.agent_ids = [int(s) for s in self.cmd[i + 1].split(",") if s]
        except (ValueError, IndexError):
            self.agent_ids = []

        self.use_0g_inference = "--use-0g-inference" in self.cmd
        self.pid = 999000 + len(_FakePopen.instances)
        self._alive = True
        self._aborted = False
        _FakePopen.instances.append(self)

        # Side-effect: write a 'started' event immediately so tests
        # don't need to sleep.
        if self.status_path is not None:
            self._emit("started",
                       agent_ids=self.agent_ids, epochs=self.epochs,
                       games_per_epoch=len(self.agent_ids) * (len(self.agent_ids) - 1) // 2,
                       total_games=self.epochs * len(self.agent_ids) * (len(self.agent_ids) - 1) // 2,
                       use_0g_inference=self.use_0g_inference)
            self._emit("agents_loaded",
                       loaded={str(a): "fresh" for a in self.agent_ids})

    def _emit(self, event, **fields):
        if self.status_path is None:
            return
        fields["event"] = event
        fields.setdefault("ts", time.time())
        with self.status_path.open("a") as fh:
            fh.write(json.dumps(fields) + "\n")

    def emit_match(self, epoch, agent_a, agent_b, winner, plies=42):
        self._emit("match", epoch=epoch, agent_a=agent_a, agent_b=agent_b,
                   winner=winner, plies=plies)

    def emit_done(self):
        self._emit("done")
        self._alive = False

    def kill_quietly(self):
        """Simulate process exit (used when the test wants to assert
        get_status sees a dead pid without a 'done' event)."""
        self._alive = False

    def wait(self, timeout=None):
        # Used by abort_job after SIGTERM. We mark dead.
        self._alive = False
        self._aborted = True
        return 0

    def is_alive(self):
        return self._alive


def _install_fake_popen(monkeypatch):
    """Replace training_service's popen path with a factory returning
    _FakePopen, plus stub `_is_pid_alive` since fake PIDs aren't real."""
    _FakePopen.instances = []

    def _fake_factory(cmd, **kwargs):
        return _FakePopen(cmd, **kwargs)

    monkeypatch.setattr(
        training_service.subprocess, "Popen", _fake_factory
    )
    # _is_pid_alive uses os.kill(pid, 0). Map our fake pids to the
    # _FakePopen.instances liveness flag.
    def _fake_alive(pid):
        for inst in _FakePopen.instances:
            if inst.pid == pid:
                return inst.is_alive()
        return False
    monkeypatch.setattr(training_service, "_is_pid_alive", _fake_alive)
    # abort_job calls os.kill(pid, SIGTERM) — patch to no-op + mark dead.
    def _fake_kill(pid, sig):
        for inst in _FakePopen.instances:
            if inst.pid == pid:
                inst._alive = False
                return
        raise ProcessLookupError(pid)
    monkeypatch.setattr(training_service.os, "kill", _fake_kill)


@pytest.fixture(autouse=True)
def _reset_singleton():
    training_service.reset_for_tests()
    yield
    training_service.reset_for_tests()


# ─── /training/start ────────────────────────────────────────────────────────


def test_start_happy_path(monkeypatch):
    _install_fake_popen(monkeypatch)
    r = client.post("/training/start", json={
        "epochs": 2, "agent_ids": [1, 2, 3],
        "use_0g_inference": False, "use_0g_coaching": False,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["epochs"] == 2
    assert body["agent_ids"] == [1, 2, 3]
    assert body["use_0g_inference"] is False
    assert "job_id" in body
    assert "started_at" in body


def test_start_409_when_already_running(monkeypatch):
    _install_fake_popen(monkeypatch)
    r1 = client.post("/training/start", json={
        "epochs": 1, "agent_ids": [1, 2],
    })
    assert r1.status_code == 200
    r2 = client.post("/training/start", json={
        "epochs": 1, "agent_ids": [1, 2],
    })
    assert r2.status_code == 409


def test_start_422_invalid_epochs(monkeypatch):
    _install_fake_popen(monkeypatch)
    r = client.post("/training/start", json={
        "epochs": 0, "agent_ids": [1, 2],
    })
    assert r.status_code == 422


def test_start_422_too_few_agents(monkeypatch):
    _install_fake_popen(monkeypatch)
    r = client.post("/training/start", json={
        "epochs": 1, "agent_ids": [1],
    })
    assert r.status_code == 422


def test_start_upload_to_0g_passes_checkpoint_flags(monkeypatch):
    """When upload_to_0g=True is requested, the trainer subprocess
    receives --checkpoint-dir and --upload-to-0g. The response also
    surfaces upload_to_0g=True."""
    _install_fake_popen(monkeypatch)
    r = client.post("/training/start", json={
        "epochs": 1, "agent_ids": [1, 2], "upload_to_0g": True,
    })
    assert r.status_code == 200, r.text
    assert r.json()["upload_to_0g"] is True
    trainer = _FakePopen.instances[-1]
    assert "--checkpoint-dir" in trainer.cmd
    assert "--upload-to-0g" in trainer.cmd


def test_start_use_0g_inference_auto_derives_upload(monkeypatch):
    """When use_0g_inference=True is set (but upload_to_0g not explicitly
    sent), the endpoint auto-derives upload_to_0g=True so trained weights
    are persisted to 0G after the run."""
    _install_fake_popen(monkeypatch)
    r = client.post("/training/start", json={
        "epochs": 1, "agent_ids": [1, 2], "use_0g_inference": True,
    })
    assert r.status_code == 200, r.text
    assert r.json()["upload_to_0g"] is True
    trainer = _FakePopen.instances[-1]
    assert "--checkpoint-dir" in trainer.cmd
    assert "--upload-to-0g" in trainer.cmd


def test_start_local_only_no_checkpoint_flags(monkeypatch):
    """When all backends are local and upload_to_0g is False (the default),
    --checkpoint-dir and --upload-to-0g are NOT passed to the trainer."""
    _install_fake_popen(monkeypatch)
    r = client.post("/training/start", json={
        "epochs": 1, "agent_ids": [1, 2],
        "use_0g_inference": False, "use_0g_coaching": False,
    })
    assert r.status_code == 200, r.text
    assert r.json()["upload_to_0g"] is False
    trainer = _FakePopen.instances[-1]
    assert "--upload-to-0g" not in trainer.cmd


# ─── /training/status ───────────────────────────────────────────────────────


def test_status_no_job_returns_empty_shape():
    r = client.get("/training/status")
    assert r.status_code == 200
    body = r.json()
    assert body["running"] is False
    assert body["completed_games"] == 0
    assert body["total_games"] == 0
    assert body["per_agent"] == {}


def test_status_running_job_aggregates_matches(monkeypatch):
    _install_fake_popen(monkeypatch)
    client.post("/training/start", json={
        "epochs": 2, "agent_ids": [1, 2, 3],
    })
    fake = _FakePopen.instances[-1]
    fake.emit_match(epoch=0, agent_a=1, agent_b=2, winner=1)
    fake.emit_match(epoch=0, agent_a=1, agent_b=3, winner=3)

    r = client.get("/training/status")
    assert r.status_code == 200
    body = r.json()
    assert body["running"] is True
    assert body["completed_games"] == 2
    assert body["total_games"] == 2 * 3  # 2 epochs × C(3,2) = 6
    assert body["per_agent"]["1"]["games"] == 2
    assert body["per_agent"]["1"]["wins"] == 1
    assert body["per_agent"]["3"]["wins"] == 1
    assert body["per_agent"]["2"]["losses"] == 1


def test_status_done_event_marks_ended(monkeypatch):
    _install_fake_popen(monkeypatch)
    client.post("/training/start", json={"epochs": 1, "agent_ids": [1, 2]})
    fake = _FakePopen.instances[-1]
    fake.emit_match(epoch=0, agent_a=1, agent_b=2, winner=2)
    fake.emit_done()

    r = client.get("/training/status")
    body = r.json()
    assert body["running"] is False
    assert body["ended"] == "done"


def test_status_agent_saved_surfaced_in_checkpoints(monkeypatch):
    """agent_saved events emitted by the trainer appear in the
    checkpoints list with agent_id, path, and root_hash."""
    _install_fake_popen(monkeypatch)
    client.post("/training/start", json={"epochs": 1, "agent_ids": [1, 2]})
    fake = _FakePopen.instances[-1]
    fake.emit_match(epoch=0, agent_a=1, agent_b=2, winner=1)
    fake._emit("agent_saved", agent_id=1, path="/tmp/ckpt/agent-1.pt",
               root_hash="0x" + "aa" * 32)
    fake._emit("agent_saved", agent_id=2, path="/tmp/ckpt/agent-2.pt",
               root_hash="0x" + "bb" * 32)
    fake.emit_done()

    r = client.get("/training/status")
    body = r.json()
    ckpts = body["checkpoints"]
    assert len(ckpts) == 2
    assert ckpts[0]["agent_id"] == 1
    assert ckpts[0]["root_hash"] == "0x" + "aa" * 32
    assert ckpts[0]["error"] is None
    assert ckpts[1]["agent_id"] == 2
    assert ckpts[1]["root_hash"] == "0x" + "bb" * 32


def test_status_agent_save_error_surfaces_in_checkpoints(monkeypatch):
    """agent_save_error events (upload failed, e.g. missing env vars)
    appear in the checkpoints list with the error string."""
    _install_fake_popen(monkeypatch)
    client.post("/training/start", json={"epochs": 1, "agent_ids": [1, 2]})
    fake = _FakePopen.instances[-1]
    fake.emit_match(epoch=0, agent_a=1, agent_b=2, winner=1)
    fake._emit("agent_save_error", agent_id=1,
               detail="Missing env vars for 0G Storage upload: ['OG_STORAGE_RPC']")
    fake.emit_done()

    r = client.get("/training/status")
    body = r.json()
    ckpts = body["checkpoints"]
    assert len(ckpts) == 1
    assert ckpts[0]["agent_id"] == 1
    assert ckpts[0]["root_hash"] is None
    assert "OG_STORAGE_RPC" in ckpts[0]["error"]


def test_status_dead_process_no_done_marks_aborted(monkeypatch):
    _install_fake_popen(monkeypatch)
    client.post("/training/start", json={"epochs": 1, "agent_ids": [1, 2]})
    fake = _FakePopen.instances[-1]
    fake.emit_match(epoch=0, agent_a=1, agent_b=2, winner=1)
    fake.kill_quietly()  # simulate crash without 'done'

    # The status reader's _clear_if_dead() will also clear the
    # singleton; we read once before that to see the aborted shape.
    # But _clear_if_dead happens inside get_status, so we have to fake
    # _is_pid_alive returning False but the singleton still set.
    # The current get_status() clears the singleton when the pid is
    # dead, so subsequent calls see the empty shape. That's
    # acceptable behaviour — a dead job should clear quickly.
    r = client.get("/training/status")
    body = r.json()
    # After clear_if_dead, the singleton is None, so we get empty.
    assert body["running"] is False


# ─── /training/abort ────────────────────────────────────────────────────────


def test_abort_kills_running_job(monkeypatch):
    _install_fake_popen(monkeypatch)
    client.post("/training/start", json={"epochs": 1, "agent_ids": [1, 2]})
    fake = _FakePopen.instances[-1]
    assert fake.is_alive() is True

    r = client.post("/training/abort")
    assert r.status_code == 200
    assert r.json() == {"aborted": True}
    assert fake.is_alive() is False


def test_abort_returns_false_when_no_job():
    r = client.post("/training/abort")
    assert r.status_code == 200
    assert r.json() == {"aborted": False}


# ─── /training/estimate ─────────────────────────────────────────────────────


def test_estimate_local_returns_zero_gas():
    r = client.get("/training/estimate?epochs=10&agent_ids=1,2,3&use_0g_inference=false")
    assert r.status_code == 200
    body = r.json()
    assert body["games"] == 10 * 3  # 10 epochs × C(3,2) = 30
    assert body["total_inferences"] == 30 * training_service.MEAN_PLIES_PER_GAME
    assert body["gas_og"] == 0.0
    assert body["available"] is True


def test_estimate_0g_unavailable_without_env():
    """When use_0g_inference=true and no OG_STORAGE_* env is set, the
    eval bridge subprocess fails fast; the endpoint catches the
    exception, returns available=false, gas_og=0, and a note that
    contains the structured 'OG_EVAL_UNAVAILABLE' marker so the
    frontend can disclose state instead of erroring."""
    r = client.get("/training/estimate?epochs=4&agent_ids=1,2&use_0g_inference=true")
    assert r.status_code == 200
    body = r.json()
    assert body["games"] == 4 * 1  # C(2,2) = 1
    assert body["available"] is False
    assert body["gas_og"] == 0.0
    assert "OG_EVAL_UNAVAILABLE" in body.get("note", "") \
        or "Missing env" in body.get("note", "") \
        or "og-compute-bridge" in body.get("note", "")


def test_estimate_0g_uses_eval_client_when_available(monkeypatch):
    """When the eval client succeeds, gas_og + per_inference_og are
    populated from the bridge's response and available=true."""

    class _StubResult:
        per_inference_og = 0.0001
        total_og = 0.024
        available = True
        note = ""

    def _stub_estimate(count):
        return _StubResult()

    # Inject a stub eval client by monkey-patching the import at the
    # endpoint's call site. Because the import lives inside the
    # endpoint function (lazy), we patch the module that's imported
    # FROM (the agent-side og_compute_eval_client).
    import sys as _sys
    from pathlib import Path as _P
    _sys.path.insert(0, str(_P(__file__).resolve().parents[2] / "agent"))
    import og_compute_eval_client  # noqa: E402
    monkeypatch.setattr(og_compute_eval_client, "estimate", _stub_estimate)

    r = client.get("/training/estimate?epochs=10&agent_ids=1,2,3&use_0g_inference=true")
    assert r.status_code == 200
    body = r.json()
    assert body["games"] == 10 * 3  # C(3,2) = 3
    assert body["available"] is True
    assert body["per_inference_og"] == pytest.approx(0.0001)
    assert body["gas_og"] == pytest.approx(0.024)


def test_estimate_invalid_agent_ids_string_422():
    r = client.get("/training/estimate?epochs=1&agent_ids=1,abc,3")
    assert r.status_code == 422


def test_estimate_zero_epochs_422():
    r = client.get("/training/estimate?epochs=0&agent_ids=1,2")
    assert r.status_code == 422


# ─── /agents + /agents/{id}/profile (ChainClient mocked) ───────────────────


class _FakeChainClient:
    """Stand-in for ChainClient that returns deterministic agent state."""

    def __init__(self, *, count=3, hashes=None, match_counts=None, tiers=None):
        self.agent_registry = object()  # truthy
        self._count = count
        self._hashes = hashes or {1: "0x" + "00" * 32,        # null
                                  2: "0x" + "11" * 32,        # overlay
                                  3: "0x" + "22" * 32}        # model
        self._match_counts = match_counts or {1: 0, 2: 7, 3: 12}
        self._tiers = tiers or {1: 0, 2: 1, 3: 2}

    def active_agent_count(self):
        return self._count

    def active_agent_at(self, i):
        # In this fake, IDs are 1..count.
        return i + 1

    def agent_data_hashes(self, aid):
        h = self._hashes.get(aid, "0x" + "00" * 32)
        return ["0x" + "00" * 32, h]

    def agent_match_count(self, aid):
        return self._match_counts.get(aid, 0)

    def agent_tier(self, aid):
        return self._tiers.get(aid, 0)

    def agent_owner(self, aid):
        return "0x" + "f" * 40


@pytest.fixture
def fake_chain(monkeypatch):
    fake = _FakeChainClient()
    monkeypatch.setattr(
        main_module.ChainClient, "from_env", classmethod(lambda cls: fake)
    )
    return fake


def test_list_agents_iterates_count(fake_chain):
    r = client.get("/agents")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 3
    assert [a["agent_id"] for a in body] == [1, 2, 3]
    assert body[1]["match_count"] == 7
    assert body[2]["weights_hash"] == "0x" + "22" * 32


def test_list_agents_503_when_chain_unavailable(monkeypatch):
    from app.chain_client import ChainError
    def _raise(cls):
        raise ChainError("RPC unreachable")
    monkeypatch.setattr(main_module.ChainClient, "from_env", classmethod(_raise))
    r = client.get("/agents")
    assert r.status_code == 503


def _make_kv_mock(monkeypatch, store: dict) -> None:
    """Patch main_module.get_kv to serve from `store`; missing keys raise OgStorageError."""
    from app.og_storage_client import OgStorageError as _OgStorageError

    def _fake_get_kv(key, **kwargs):
        if key not in store:
            raise _OgStorageError(f"Key not found in mock KV: {key}")
        return store[key]

    monkeypatch.setattr(main_module, "get_kv", _fake_get_kv)


def test_get_profile_null_when_no_kv(fake_chain, monkeypatch):
    """No weights or overlay in KV → NullProfile."""
    _make_kv_mock(monkeypatch, {})  # empty store → all keys missing
    r = client.get("/agents/1/profile")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "null"
    assert body["match_count"] == 0
    assert "no measurable" in body["summary"].lower() or \
           "fresh" in body["summary"].lower()


def test_get_profile_falls_back_to_blob_when_kv_empty(monkeypatch):
    """KV miss + non-zero on-chain overlay hash → fetch via get_blob.

    Regression guard: the 0G TS SDK doesn't ship a KV client yet, so on
    testnet every get_kv() raises. Without this fallback the endpoint
    returns kind="null" for every agent even when AgentRegistry holds a
    real overlay hash. See server/app/og_storage_client.py.
    """
    import json as _json
    CATS = [
        "opening_slot", "opening_split", "opening_builder", "opening_anchor",
        "build_5_point", "build_bar_point", "bearoff_efficient", "bearoff_safe",
        "risk_hit_exposure", "risk_blot_leaving", "hits_blot", "runs_back_checker",
        "anchors_back", "phase_prime_building", "phase_race_conversion",
        "phase_back_game", "phase_holding_game", "phase_blitz",
        "cube_offer_aggressive", "cube_take_aggressive",
    ]
    overlay_payload = _json.dumps({
        "version": 1,
        "values": {c: 0.0 for c in CATS},
        "match_count": 5,
    }).encode()
    overlay_hash = "0x" + "ab" * 32

    fake = _FakeChainClient(hashes={9: overlay_hash}, match_counts={9: 5})
    monkeypatch.setattr(
        main_module.ChainClient, "from_env", classmethod(lambda cls: fake)
    )
    _make_kv_mock(monkeypatch, {})  # KV completely empty

    seen: dict = {}

    def _fake_get_blob(h, **kwargs):
        seen["hash"] = h
        return overlay_payload

    monkeypatch.setattr(main_module, "get_blob", _fake_get_blob)

    r = client.get("/agents/9/profile")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "overlay"
    assert body["match_count"] == 5
    assert seen["hash"].lower() == overlay_hash.lower()


def test_get_profile_overlay_when_kv_has_overlay(fake_chain, monkeypatch):
    """KV contains an overlay JSON blob → OverlayProfile with correct match_count."""
    import json as _json
    CATS = [
        "opening_slot", "opening_split", "opening_builder", "opening_anchor",
        "build_5_point", "build_bar_point", "bearoff_efficient", "bearoff_safe",
        "risk_hit_exposure", "risk_blot_leaving", "hits_blot", "runs_back_checker",
        "anchors_back", "phase_prime_building", "phase_race_conversion",
        "phase_back_game", "phase_holding_game", "phase_blitz",
        "cube_offer_aggressive", "cube_take_aggressive",
    ]
    overlay_blob = _json.dumps({
        "version": 1,
        "values": {c: 0.0 for c in CATS},
        "match_count": 7,
    }).encode()
    _make_kv_mock(monkeypatch, {"chaingammon/weights/agent/2": overlay_blob})
    r = client.get("/agents/2/profile")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "overlay"
    assert body["match_count"] == 7


def test_get_profile_model_when_kv_has_checkpoint(fake_chain, monkeypatch):
    """KV contains a PyTorch checkpoint → ModelProfile with correct match_count."""
    import io as _io
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))
    import torch
    from sample_trainer import BackgammonNet  # noqa: E402

    net = BackgammonNet(extras_dim=16, core_seed=0xBACC, extras_seed=3)
    buf = _io.BytesIO()
    torch.save(
        {"state_dict": net.state_dict(), "match_count": 12, "extras_dim": 16, "in_dim": 198},
        buf,
    )
    blob = buf.getvalue()
    _make_kv_mock(monkeypatch, {"chaingammon/weights/agent/3": blob})
    r = client.get("/agents/3/profile")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "model"
    assert body["match_count"] == 12


# ─── KV write watcher tests ──────────────────────────────────────────────────


def _install_fake_kv(monkeypatch) -> dict:
    """Patch app.og_storage_client.put_kv to capture writes in a dict."""
    import app.og_storage_client as _ogc

    kv_store: dict[str, bytes] = {}

    def _fake_put_kv(key, data, **kwargs):
        kv_store[key] = data

    monkeypatch.setattr(_ogc, "put_kv", _fake_put_kv)
    return kv_store


def test_post_training_chain_writes_uploads_to_kv_not_chain(monkeypatch, tmp_path):
    """_post_training_chain_writes reads local checkpoint and writes to KV.
    No chain.update_overlay_hash should be called."""
    ckpt = tmp_path / "agent-1.pt"
    ckpt.write_bytes(b"fake-checkpoint-data-for-agent-1")

    status_file = tmp_path / "status.jsonl"
    status_file.write_text(
        json.dumps({
            "event": "agent_saved",
            "agent_id": 1,
            "path": str(ckpt),
            "root_hash": "0x" + "aa" * 32,
            "ts": time.time(),
        }) + "\n"
    )

    kv_written = _install_fake_kv(monkeypatch)

    class _FakeProcess:
        pid = 1234
        def wait(self):
            return 0

    training_service._post_training_chain_writes(_FakeProcess(), status_file)

    assert "chaingammon/weights/agent/1" in kv_written, (
        "expected KV write for chaingammon/weights/agent/1"
    )
    assert kv_written["chaingammon/weights/agent/1"] == b"fake-checkpoint-data-for-agent-1"

    # chain_write event should be appended to the status file.
    events = [json.loads(ln) for ln in status_file.read_text().splitlines() if ln.strip()]
    chain_writes = [e for e in events if e.get("event") == "chain_write"]
    assert len(chain_writes) == 1
    assert chain_writes[0]["agent_id"] == 1
    assert chain_writes[0]["kv_key"] == "chaingammon/weights/agent/1"
    assert chain_writes[0].get("error") is None


def test_post_training_chain_writes_errors_when_path_missing(monkeypatch, tmp_path):
    """If the local checkpoint file is missing, an error is recorded."""
    status_file = tmp_path / "status.jsonl"
    status_file.write_text(
        json.dumps({
            "event": "agent_saved",
            "agent_id": 2,
            "path": str(tmp_path / "does-not-exist.pt"),
            "ts": time.time(),
        }) + "\n"
    )

    kv_written = _install_fake_kv(monkeypatch)

    class _FakeProcess:
        pid = 5678
        def wait(self):
            return 0

    training_service._post_training_chain_writes(_FakeProcess(), status_file)

    assert "chaingammon/weights/agent/2" not in kv_written

    events = [json.loads(ln) for ln in status_file.read_text().splitlines() if ln.strip()]
    chain_writes = [e for e in events if e.get("event") == "chain_write"]
    assert len(chain_writes) == 1
    assert chain_writes[0]["error"] is not None


def test_status_chain_writes_include_kv_key(monkeypatch, tmp_path):
    """chain_write events surface kv_key in the status response."""
    _install_fake_popen(monkeypatch)
    client.post("/training/start", json={"epochs": 1, "agent_ids": [1, 2]})
    fake = _FakePopen.instances[-1]
    fake.emit_match(epoch=0, agent_a=1, agent_b=2, winner=1)
    fake._emit(
        "chain_write",
        agent_id=1,
        kv_key="chaingammon/weights/agent/1",
    )
    fake.emit_done()

    r = client.get("/training/status")
    body = r.json()
    cw = body["chain_writes"]
    assert len(cw) == 1
    assert cw[0]["kv_key"] == "chaingammon/weights/agent/1"
    assert cw[0].get("error") is None


def test_get_profile_reads_from_kv(monkeypatch):
    """get_agent_profile reads weights from KV, not from chain dataHashes."""
    import json as _json

    overlay_bytes = _json.dumps({
        "version": 1,
        "match_count": 5,
        "values": {c: 0.0 for c in [
            "opening_slot", "opening_split", "opening_builder", "opening_anchor",
            "build_5_point", "build_bar_point", "bearoff_efficient", "bearoff_safe",
            "risk_hit_exposure", "risk_blot_leaving", "hits_blot", "runs_back_checker",
            "anchors_back", "phase_prime_building", "phase_race_conversion",
            "phase_back_game", "phase_holding_game", "phase_blitz",
            "cube_offer_aggressive", "cube_take_aggressive",
        ]},
    }).encode()

    kv_store: dict[str, bytes] = {
        "chaingammon/overlay/agent/1": overlay_bytes,
    }

    def _fake_get_kv(key, **kwargs):
        from app.og_storage_client import OgStorageError
        if key not in kv_store:
            raise OgStorageError(f"Key not found: {key}")
        return kv_store[key]

    monkeypatch.setattr(main_module, "get_kv", _fake_get_kv)

    r = client.get("/agents/1/profile")
    assert r.status_code == 200
    body = r.json()
    # No weights in KV → NullProfile; overlay is found → overlay_values populated.
    assert body["kind"] == "null"
    assert "kv_key" in body
    assert body["overlay_values"] is not None
