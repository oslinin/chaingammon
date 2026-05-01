"""Tests for og_compute_eval_client.

Run with:  cd agent && uv run pytest tests/test_og_compute_eval_client.py -v

Hermetic — `subprocess.run` is monkey-patched to a fake that returns
canned stdout/stderr without actually invoking node. Mirrors the
hermetic test pattern used by the coach client.
"""
from __future__ import annotations

import json
import os
import subprocess
from types import SimpleNamespace

import pytest

import og_compute_eval_client as ec


def _fake_run_factory(*, returncode=0, stdout=b"", stderr=b""):
    """Build a `subprocess.run` replacement that returns a canned result."""
    captured: dict = {}

    def fake_run(cmd, *, input, capture_output, env, timeout, check):
        captured["cmd"] = cmd
        captured["stdin"] = input.decode() if isinstance(input, bytes) else input
        captured["env"] = env
        return SimpleNamespace(
            returncode=returncode, stdout=stdout, stderr=stderr
        )

    return fake_run, captured


@pytest.fixture(autouse=True)
def _set_env(monkeypatch):
    """Set the required env vars so _check_env passes."""
    monkeypatch.setenv("OG_STORAGE_RPC", "http://localhost:8545")
    monkeypatch.setenv("OG_STORAGE_PRIVATE_KEY", "0x" + "11" * 32)


# ─── evaluate ───────────────────────────────────────────────────────────────


def test_evaluate_returns_eval_result(monkeypatch):
    stdout = json.dumps({
        "equity": 0.4321,
        "model": "backgammon-net-v1",
        "providerAddress": "0xprovider",
    }).encode()
    fake_run, captured = _fake_run_factory(stdout=stdout)
    monkeypatch.setattr(ec.subprocess, "run", fake_run)

    result = ec.evaluate([0.0] * 198, [1.0] * 16)
    assert isinstance(result, ec.EvalResult)
    assert result.equity == pytest.approx(0.4321)
    assert result.model == "backgammon-net-v1"
    assert result.provider_address == "0xprovider"

    payload = json.loads(captured["stdin"])
    assert payload["action"] == "evaluate"
    assert len(payload["features"]) == 198
    assert len(payload["extras"]) == 16


def test_evaluate_translates_unavailable_stderr_to_typed_exception(monkeypatch):
    stderr = b"og-compute-bridge: OG_EVAL_UNAVAILABLE: no backgammon-net provider registered\n"
    fake_run, _ = _fake_run_factory(returncode=1, stderr=stderr)
    monkeypatch.setattr(ec.subprocess, "run", fake_run)

    with pytest.raises(ec.OgEvalUnavailable):
        ec.evaluate([0.0] * 198, [0.0] * 16)


def test_evaluate_other_failures_become_generic_eval_error(monkeypatch):
    stderr = b"og-compute-bridge: Provider returned 503\n"
    fake_run, _ = _fake_run_factory(returncode=1, stderr=stderr)
    monkeypatch.setattr(ec.subprocess, "run", fake_run)

    with pytest.raises(ec.OgEvalError) as excinfo:
        ec.evaluate([0.0] * 198, [0.0] * 16)
    # Must NOT be the typed unavailable subclass.
    assert not isinstance(excinfo.value, ec.OgEvalUnavailable)


def test_evaluate_missing_field_raises(monkeypatch):
    stdout = json.dumps({"equity": 0.5}).encode()  # no providerAddress
    fake_run, _ = _fake_run_factory(stdout=stdout)
    monkeypatch.setattr(ec.subprocess, "run", fake_run)

    with pytest.raises(ec.OgEvalError, match="missing field"):
        ec.evaluate([0.0] * 198, [0.0] * 16)


def test_evaluate_non_json_stdout_raises(monkeypatch):
    fake_run, _ = _fake_run_factory(stdout=b"not json")
    monkeypatch.setattr(ec.subprocess, "run", fake_run)

    with pytest.raises(ec.OgEvalError, match="non-JSON"):
        ec.evaluate([0.0] * 198, [0.0] * 16)


def test_evaluate_accepts_iterable_inputs(monkeypatch):
    """features/extras can be tuples/lists/etc — anything iterable to floats."""
    stdout = json.dumps({
        "equity": 0.5, "model": "x", "providerAddress": "0xp",
    }).encode()
    fake_run, captured = _fake_run_factory(stdout=stdout)
    monkeypatch.setattr(ec.subprocess, "run", fake_run)

    ec.evaluate(tuple(range(198)), [i * 0.1 for i in range(16)])
    payload = json.loads(captured["stdin"])
    assert payload["features"][0] == 0.0
    assert payload["features"][197] == 197.0


# ─── estimate ───────────────────────────────────────────────────────────────


def test_estimate_returns_estimate_result_when_available(monkeypatch):
    stdout = json.dumps({
        "per_inference_og": 0.0001,
        "total_og": 0.05,
        "providerAddress": "0xprovider",
        "available": True,
    }).encode()
    fake_run, captured = _fake_run_factory(stdout=stdout)
    monkeypatch.setattr(ec.subprocess, "run", fake_run)

    r = ec.estimate(500)
    assert isinstance(r, ec.EstimateResult)
    assert r.per_inference_og == pytest.approx(0.0001)
    assert r.total_og == pytest.approx(0.05)
    assert r.provider_address == "0xprovider"
    assert r.available is True

    payload = json.loads(captured["stdin"])
    assert payload == {"action": "estimate", "count": 500}


def test_estimate_unavailable_does_not_raise(monkeypatch):
    """When no provider is found, the bridge exits 0 with available=False
    so the frontend can disclose state without erroring."""
    stdout = json.dumps({
        "per_inference_og": 0.00001,
        "total_og": 0.005,
        "providerAddress": "",
        "available": False,
        "note": "OG_EVAL_UNAVAILABLE: no backgammon-net provider registered",
    }).encode()
    fake_run, _ = _fake_run_factory(stdout=stdout)
    monkeypatch.setattr(ec.subprocess, "run", fake_run)

    r = ec.estimate(100)
    assert r.available is False
    assert "OG_EVAL_UNAVAILABLE" in r.note
    # Pricing fields are still populated (placeholder values).
    assert r.total_og > 0


def test_estimate_zero_count_raises():
    with pytest.raises(ValueError, match=">.*0"):
        ec.estimate(0)


# ─── env validation ────────────────────────────────────────────────────────


def test_missing_env_raises(monkeypatch):
    monkeypatch.delenv("OG_STORAGE_RPC", raising=False)
    with pytest.raises(ec.OgEvalError, match="Missing env"):
        ec.evaluate([0.0] * 198, [0.0] * 16)
