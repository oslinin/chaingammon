"""
Validates docs/keeperhub-workflow.schema.json against representative
sample workflow-run payloads. The schema codifies what the frontend's
/match/[matchId] route reads back from `kh run status --json` and what
the audit-log entries on 0G Storage look like.

Tests cover:
  - the schema itself is a well-formed JSON Schema (Draft 2020-12)
  - a happy-path running workflow validates
  - a fully-completed workflow with all settlement steps validates
  - an empty step list still validates (workflow not yet started)
  - structurally-broken payloads are rejected: bad matchId hex,
    unknown step id, unknown status enum value
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError


SCHEMA_PATH = Path(__file__).resolve().parents[2] / "docs" / "keeperhub-workflow.schema.json"


@pytest.fixture(scope="module")
def schema():
    return json.loads(SCHEMA_PATH.read_text())


@pytest.fixture(scope="module")
def validator(schema):
    return Draft202012Validator(schema)


# ---------------------------------------------------------------------------
# Sample payloads
# ---------------------------------------------------------------------------


def _running_workflow():
    """Mid-flight: deposits verified, on the third turn of per_turn_loop."""
    return {
        "matchId": "0x" + "ab" * 32,
        "runId": "kh-run-001",
        "status": "running",
        "started_at": "2026-05-01T12:00:00Z",
        "ended_at": None,
        "steps": [
            {
                "id": "verify_deposits",
                "name": "Escrow deposit confirmation",
                "status": "ok",
                "duration_ms": 1842,
                "retry_count": 0,
                "tx_hash": None,
                "error": None,
                "detail": "Both players' deposits confirmed."
            },
            {
                "id": "initialize_audit_log",
                "status": "ok",
                "duration_ms": 600,
                "retry_count": 0
            },
            {
                "id": "pull_drand_round",
                "status": "ok",
                "turn_index": 0,
                "drand_round": 5500001,
                "duration_ms": 80,
                "retry_count": 0
            },
            {
                "id": "derive_dice",
                "status": "ok",
                "turn_index": 0,
                "drand_round": 5500001,
                "detail": {"d1": 4, "d2": 2}
            },
            {
                "id": "request_move",
                "status": "running",
                "turn_index": 0
            }
        ]
    }


def _settled_workflow():
    """End-state: all settlement steps complete."""
    return {
        "matchId": "0x" + "cd" * 32,
        "runId": "kh-run-002",
        "status": "succeeded",
        "started_at": "2026-05-01T12:00:00Z",
        "ended_at": "2026-05-01T12:05:00Z",
        "steps": [
            {"id": "verify_deposits", "status": "ok", "duration_ms": 1500, "retry_count": 0},
            {"id": "build_game_record", "status": "ok", "duration_ms": 50, "retry_count": 0},
            {
                "id": "upload_game_record",
                "status": "ok",
                "duration_ms": 22000,
                "retry_count": 0,
                "tx_hash": "0x" + "ef" * 32,
                "detail": {"rootHash": "0x" + "11" * 32}
            },
            {
                "id": "submit_settlement",
                "status": "ok",
                "duration_ms": 18000,
                "retry_count": 0,
                "tx_hash": "0x" + "12" * 32
            },
            {
                "id": "payout_winner",
                "status": "ok",
                "duration_ms": 14000,
                "retry_count": 0,
                "tx_hash": "0x" + "13" * 32
            },
            {
                "id": "update_ens_records",
                "status": "ok",
                "duration_ms": 16000,
                "retry_count": 0,
                "tx_hash": "0x" + "14" * 32
            },
            {"id": "append_audit_summary", "status": "ok", "duration_ms": 21000, "retry_count": 0}
        ]
    }


# ---------------------------------------------------------------------------
# Schema sanity
# ---------------------------------------------------------------------------


def test_schema_is_well_formed(schema):
    """The schema document itself must be a valid JSON Schema; otherwise
    every downstream validation is meaningless."""
    Draft202012Validator.check_schema(schema)


# ---------------------------------------------------------------------------
# Valid payloads
# ---------------------------------------------------------------------------


def test_running_workflow_validates(validator):
    validator.validate(_running_workflow())


def test_settled_workflow_validates(validator):
    validator.validate(_settled_workflow())


def test_pending_workflow_with_no_steps_validates(validator):
    """Empty step list is valid — represents a workflow run that's been
    accepted but hasn't started yet."""
    validator.validate({
        "matchId": "0x" + "00" * 32,
        "status": "pending",
        "steps": []
    })


# ---------------------------------------------------------------------------
# Invalid payloads (negative tests)
# ---------------------------------------------------------------------------


def test_invalid_matchId_pattern_rejected(validator):
    """matchId must be 0x + 64 hex chars."""
    bad = _running_workflow()
    bad["matchId"] = "0xabc"
    with pytest.raises(ValidationError):
        validator.validate(bad)


def test_unknown_step_id_rejected(validator):
    """Step ids are an enum locked to the workflow spec — any other id
    indicates a workflow-spec drift the client should reject."""
    bad = _running_workflow()
    bad["steps"][0]["id"] = "nonexistent_step"
    with pytest.raises(ValidationError):
        validator.validate(bad)


def test_unknown_status_value_rejected(validator):
    """Top-level status is an enum; 'unknown' would silently collapse
    UI states without this guard."""
    bad = _running_workflow()
    bad["status"] = "unknown"
    with pytest.raises(ValidationError):
        validator.validate(bad)


def test_unknown_step_status_rejected(validator):
    bad = _running_workflow()
    bad["steps"][0]["status"] = "in_progress"
    with pytest.raises(ValidationError):
        validator.validate(bad)


def test_negative_retry_count_rejected(validator):
    bad = _running_workflow()
    bad["steps"][0]["retry_count"] = -1
    with pytest.raises(ValidationError):
        validator.validate(bad)


def test_missing_required_fields_rejected(validator):
    """status is required at top level."""
    bad = {"matchId": "0x" + "ab" * 32, "steps": []}
    with pytest.raises(ValidationError):
        validator.validate(bad)
