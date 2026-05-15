"""
Unit tests for put_kv / get_kv using OG_STORAGE_MODE=localhost.

Tests verify:
  - Round-trip: put_kv followed by get_kv returns the same bytes.
  - Key isolation: two different keys are stored independently.
  - OgStorageError raised when key is absent.
  - put_kv rejects empty bytes.

No network is required — all tests run against the local file mock at
/tmp/chaingammon-kv-mock.json.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.og_storage_client import OgStorageError, get_kv, put_kv  # noqa: E402

# All tests in this module run in localhost mode.
pytestmark = pytest.mark.usefixtures("kv_localhost_env")


@pytest.fixture()
def kv_localhost_env(tmp_path, monkeypatch):
    """Set OG_STORAGE_MODE=localhost and point the mock file to a tmp path."""
    mock_file = str(tmp_path / "kv-mock.json")
    monkeypatch.setenv("OG_STORAGE_MODE", "localhost")
    # Patch the MOCK_PATH constant inside both bridge scripts via the env so
    # the Node subprocess picks it up. The scripts hard-code /tmp/... but we
    # can't easily override them in tests without changing the script — instead
    # we just ensure the env is set and accept the default mock path.
    # The tests clean up by resetting the mock file between runs.
    mock_path = Path("/tmp/chaingammon-kv-mock.json")
    mock_path.unlink(missing_ok=True)
    yield
    mock_path.unlink(missing_ok=True)


def test_put_kv_then_get_kv_round_trip():
    data = b"chaingammon-kv-test-payload"
    put_kv("chaingammon/overlay/agent/1", data)
    result = get_kv("chaingammon/overlay/agent/1")
    assert result == data


def test_put_kv_overwrites_existing_value():
    key = "chaingammon/overlay/agent/42"
    put_kv(key, b"first-value")
    put_kv(key, b"second-value")
    assert get_kv(key) == b"second-value"


def test_key_isolation_between_agents():
    put_kv("chaingammon/overlay/agent/1", b"agent-1-data")
    put_kv("chaingammon/overlay/agent/2", b"agent-2-data")
    assert get_kv("chaingammon/overlay/agent/1") == b"agent-1-data"
    assert get_kv("chaingammon/overlay/agent/2") == b"agent-2-data"


def test_get_kv_raises_on_missing_key():
    with pytest.raises(OgStorageError, match="not found"):
        get_kv("chaingammon/overlay/agent/9999")


def test_put_kv_rejects_empty_bytes():
    with pytest.raises(OgStorageError, match="empty"):
        put_kv("some/key", b"")


def test_overlay_round_trip_via_kv():
    """Full overlay encode → KV → decode round-trip."""
    from app.agent_overlay import CATEGORIES, Overlay

    overlay = Overlay(
        version=1,
        values={c: 0.1 if c == "build_5_point" else 0.0 for c in CATEGORIES},
        match_count=3,
    )
    data = overlay.to_bytes()
    put_kv("chaingammon/overlay/agent/7", data)
    fetched_bytes = get_kv("chaingammon/overlay/agent/7")
    fetched = Overlay.from_bytes(fetched_bytes)
    assert fetched == overlay
    assert fetched.match_count == 3
    assert fetched.values["build_5_point"] == pytest.approx(0.1)
