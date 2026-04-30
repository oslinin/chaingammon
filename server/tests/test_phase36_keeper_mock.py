"""
Phase 36 — KeeperHub mock and ENS records endpoint tests.

Fast, no-network unit tests that verify:

  A. GET /keeper-workflow/{matchId} — mock endpoint for KeeperHub workflow status.
     The endpoint is a stub for the real `kh run status --json` output that
     Phase 37 will wire once the KeeperHub workflow is live.
     Tests: response shape, 8 steps, canonical step IDs, determinism, isolation.

  B. GET /ens-records/{label} — thin wrapper around EnsClient.text().
     Returns a 503 when PLAYER_SUBNAME_REGISTRAR_ADDRESS is unset. Tests
     the 503 behavior without an RPC connection (fast, no network required).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app

client = TestClient(app)

EXPECTED_STEP_IDS = [
    "escrow_deposit",
    "vrf_rolls",
    "og_storage_fetch",
    "gnubg_replay",
    "settlement_signed",
    "relay_tx",
    "ens_update",
    "audit_append",
]

EXPECTED_STEP_FIELDS = {"id", "name", "status", "duration_ms", "retry_count", "tx_hash", "error", "detail"}
VALID_STATUSES = {"pending", "running", "ok", "failed"}


def test_response_shape():
    """Top-level fields matchId, status, and steps must be present."""
    resp = client.get("/keeper-workflow/test-match-abc123")
    assert resp.status_code == 200
    data = resp.json()
    assert "matchId" in data
    assert "status" in data
    assert "steps" in data
    assert data["matchId"] == "test-match-abc123"
    assert data["status"] in VALID_STATUSES


def test_exactly_eight_steps():
    """The workflow must surface exactly the 8 canonical KeeperHub steps."""
    resp = client.get("/keeper-workflow/test-match-abc123")
    assert resp.status_code == 200
    steps = resp.json()["steps"]
    assert len(steps) == 8, f"Expected 8 steps, got {len(steps)}"


def test_all_eight_step_ids_present():
    """Every canonical step ID must appear exactly once."""
    resp = client.get("/keeper-workflow/test-match-abc123")
    step_ids = [s["id"] for s in resp.json()["steps"]]
    for expected_id in EXPECTED_STEP_IDS:
        assert expected_id in step_ids, f"Missing step id: {expected_id}"


def test_each_step_has_required_fields():
    """Every step must carry the fields the frontend depends on."""
    resp = client.get("/keeper-workflow/test-match-abc123")
    for step in resp.json()["steps"]:
        missing = EXPECTED_STEP_FIELDS - set(step.keys())
        assert not missing, f"Step {step.get('id')} missing fields: {missing}"


def test_step_status_is_valid():
    """status on every step must be one of the four valid values."""
    resp = client.get("/keeper-workflow/test-match-abc123")
    for step in resp.json()["steps"]:
        assert step["status"] in VALID_STATUSES, (
            f"Step {step['id']} has invalid status: {step['status']!r}"
        )


def test_deterministic_same_match_id():
    """Two calls with the same matchId must return identical step statuses."""
    r1 = client.get("/keeper-workflow/stable-id-xyz")
    r2 = client.get("/keeper-workflow/stable-id-xyz")
    s1 = [s["status"] for s in r1.json()["steps"]]
    s2 = [s["status"] for s in r2.json()["steps"]]
    assert s1 == s2, "Responses for the same matchId are not deterministic"


def test_different_match_ids_may_differ():
    """Two different matchIds are allowed (not required) to return different step
    statuses — this just checks the endpoint accepts multiple IDs without error."""
    r1 = client.get("/keeper-workflow/id-alpha")
    r2 = client.get("/keeper-workflow/id-beta")
    assert r1.status_code == 200
    assert r2.status_code == 200


# ── ENS records endpoint ───────────────────────────────────────────────────


def test_ens_records_returns_503_without_env(monkeypatch):
    """When PLAYER_SUBNAME_REGISTRAR_ADDRESS is unset, the endpoint must return
    503 with a human-readable detail string. This keeps the frontend's error
    banner meaningful (it shows the detail field) without requiring a live RPC."""
    monkeypatch.delenv("PLAYER_SUBNAME_REGISTRAR_ADDRESS", raising=False)
    monkeypatch.delenv("RPC_URL", raising=False)
    resp = client.get("/ens-records/alice")
    assert resp.status_code == 503
    data = resp.json()
    assert "detail" in data
    # The detail message must explain what env vars are missing.
    assert "RPC_URL" in data["detail"] or "ENS client" in data["detail"]


def test_ens_records_label_in_path():
    """The endpoint must handle URL-encoded labels without error (returns 503
    when not configured, but must not raise a 500 or routing error)."""
    resp = client.get("/ens-records/chaingammon-player")
    # Either 200 (configured env) or 503 (not configured) — never 404 or 500.
    assert resp.status_code in (200, 503)
