"""
Unit tests for put_kv / get_kv under OG_STORAGE_MODE=localhost.

All tests run hermetically — no live 0G network, no Node.js SDK install
required. OG_STORAGE_MODE=localhost routes through the JSON file mock
at /tmp/chaingammon-kv-mock.json (overridden to a temp file per test).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.og_storage_client import OgStorageError, get_kv, put_kv  # noqa: E402


@pytest.fixture(autouse=True)
def _localhost_kv(monkeypatch, tmp_path):
    """Route all KV calls to a per-test temp file via OG_STORAGE_MODE=localhost.

    Skips if `node` is not available (e.g. a pure-Python CI that hasn't
    installed the og-bridge JS deps).
    """
    import subprocess as _sp
    try:
        _sp.run(["node", "--version"], check=True, capture_output=True)
    except (FileNotFoundError, _sp.CalledProcessError):
        pytest.skip("node not available; skipping KV tests")

    mock_file = tmp_path / "kv-mock.json"
    monkeypatch.setenv("OG_STORAGE_MODE", "localhost")
    monkeypatch.setenv("KV_MOCK_PATH", str(mock_file))
    yield mock_file


def test_put_kv_round_trip(tmp_path, _localhost_kv):
    """put_kv + get_kv must return identical bytes."""
    data = b"chaingammon-kv-test:" + b"\xde\xad\xbe\xef" * 8
    put_kv("chaingammon/test/roundtrip", data)
    result = get_kv("chaingammon/test/roundtrip")
    assert result == data


def test_put_kv_overwrites_prior_value(_localhost_kv):
    """A second put_kv to the same key overwrites the first."""
    key = "chaingammon/test/overwrite"
    put_kv(key, b"first-value")
    put_kv(key, b"second-value")
    assert get_kv(key) == b"second-value"


def test_kv_key_isolation(_localhost_kv):
    """Different keys are stored independently."""
    put_kv("chaingammon/overlay/agent/1", b"agent-1-overlay")
    put_kv("chaingammon/overlay/agent/2", b"agent-2-overlay")
    assert get_kv("chaingammon/overlay/agent/1") == b"agent-1-overlay"
    assert get_kv("chaingammon/overlay/agent/2") == b"agent-2-overlay"


def test_get_kv_raises_on_missing_key(_localhost_kv):
    """get_kv raises OgStorageError when the key has never been written."""
    with pytest.raises(OgStorageError, match="Key not found"):
        get_kv("chaingammon/nonexistent/key")


def test_put_kv_rejects_empty_key(_localhost_kv):
    with pytest.raises(OgStorageError):
        put_kv("", b"data")


def test_put_kv_rejects_empty_data(_localhost_kv):
    with pytest.raises(OgStorageError):
        put_kv("chaingammon/test/empty", b"")


def test_kv_binary_roundtrip(_localhost_kv):
    """Arbitrary binary (non-UTF-8) bytes survive the base64 mock encoding."""
    data = bytes(range(256))
    put_kv("chaingammon/test/binary", data)
    assert get_kv("chaingammon/test/binary") == data


def test_overlay_json_roundtrip(_localhost_kv):
    """Overlay.to_bytes() / from_bytes() survive a KV round-trip."""
    from app.agent_overlay import Overlay, update_overlay
    from app.game_record import MoveEntry

    overlay = Overlay.default()
    moves = [MoveEntry(turn=1, dice=[3, 1], move="8/5 6/5")]
    updated = update_overlay(overlay, moves, won=True, match_count=0)

    key = "chaingammon/overlay/agent/42"
    put_kv(key, updated.to_bytes())
    fetched = Overlay.from_bytes(get_kv(key))
    assert fetched == updated
    assert fetched.match_count == 1


def test_fetch_overlay_reads_from_kv(_localhost_kv):
    """_fetch_overlay returns the KV-stored overlay for an agent."""
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.agent_overlay import Overlay, update_overlay
    from app.game_record import MoveEntry
    from app.main import _fetch_overlay

    # Write an overlay to KV.
    moves = [MoveEntry(turn=1, dice=[6, 1], move="13/7 8/7")]
    overlay = update_overlay(Overlay.default(), moves, won=False, match_count=0)
    put_kv("chaingammon/overlay/agent/99", overlay.to_bytes())

    # _fetch_overlay should read it back.
    result = _fetch_overlay(99)
    assert result.match_count == 1
    assert result == overlay


def test_fetch_overlay_returns_default_when_missing(_localhost_kv):
    """_fetch_overlay returns Overlay.default() for a cold-start agent."""
    from app.agent_overlay import Overlay
    from app.main import _fetch_overlay

    result = _fetch_overlay(99999)
    assert result == Overlay.default()
    assert result.match_count == 0


def test_update_agent_overlay_kv_writes_and_reads(_localhost_kv):
    """_update_agent_overlay_kv updates the overlay and it survives a subsequent read."""
    from app.agent_overlay import Overlay
    from app.game_record import MoveEntry
    from app.main import _fetch_overlay, _update_agent_overlay_kv

    moves = [MoveEntry(turn=1, dice=[3, 1], move="8/5 6/5")]
    updates: list = []
    _update_agent_overlay_kv(7, True, moves, updates)

    assert len(updates) == 1
    assert updates[0]["agent_id"] == 7
    assert updates[0]["match_count"] == 1

    # The overlay should be in KV now.
    fetched = _fetch_overlay(7)
    assert fetched.match_count == 1


def test_update_agent_overlay_kv_skips_human(_localhost_kv):
    """_update_agent_overlay_kv is a no-op for human players (agent_id == 0)."""
    from app.main import _update_agent_overlay_kv

    updates: list = []
    _update_agent_overlay_kv(0, True, [], updates)
    assert updates == []  # Nothing written for human side


def test_update_agent_overlay_kv_accumulates_across_games(_localhost_kv):
    """Successive overlay updates build on the prior state (match_count grows)."""
    from app.agent_overlay import Overlay
    from app.game_record import MoveEntry
    from app.main import _fetch_overlay, _update_agent_overlay_kv

    moves = [MoveEntry(turn=1, dice=[4, 2], move="8/4 6/4")]
    for game_num in range(3):
        updates: list = []
        _update_agent_overlay_kv(55, game_num % 2 == 0, moves, updates)
        assert updates[0]["match_count"] == game_num + 1

    final = _fetch_overlay(55)
    assert final.match_count == 3
