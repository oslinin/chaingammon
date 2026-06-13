"""
Walrus blob backend tests for og_storage_client (ETHGlobal NYC 2026, PR 4.1).

The unit tests mock httpx so they run offline: they check that STORAGE_BACKEND
selection routes put_blob/get_blob to the Walrus HTTP API, that the publisher
URL/params are built correctly, and that the blobId is pulled from both Walrus
store-response shapes. A live round-trip test runs only when WALRUS_PUBLISHER
and WALRUS_AGGREGATOR are set.
"""

from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

# Make `app` importable when running pytest from server/ — matches the
# pattern used by other phase tests in this directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
import pytest  # noqa: E402

from app import og_storage_client as c  # noqa: E402


class _Resp:
    """Minimal stand-in for an httpx.Response."""

    def __init__(self, *, status_code=200, json_body=None, content=b"", text="ok"):
        self.status_code = status_code
        self._json = json_body
        self.content = content
        self.text = text

    def json(self):
        if self._json is None:
            raise ValueError("no json body")
        return self._json


@pytest.fixture
def walrus_env(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "walrus")
    monkeypatch.setenv("WALRUS_PUBLISHER", "https://pub.example/")
    monkeypatch.setenv("WALRUS_AGGREGATOR", "https://agg.example/")
    monkeypatch.delenv("WALRUS_EPOCHS", raising=False)


def test_backend_defaults_to_0g(monkeypatch):
    monkeypatch.delenv("STORAGE_BACKEND", raising=False)
    assert c._storage_backend() == "0g"
    monkeypatch.setenv("STORAGE_BACKEND", "")
    assert c._storage_backend() == "0g"
    monkeypatch.setenv("STORAGE_BACKEND", "Walrus")
    assert c._storage_backend() == "walrus"


def test_put_blob_walrus_newly_created(walrus_env, monkeypatch):
    captured = {}

    def fake_put(url, params=None, content=None, timeout=None):
        captured.update(url=url, params=params, content=content)
        return _Resp(json_body={"newlyCreated": {"blobObject": {"blobId": "ABC123"}}})

    monkeypatch.setattr(httpx, "put", fake_put)
    result = c.put_blob(b"hello walrus")

    assert captured["url"] == "https://pub.example/v1/blobs"
    assert captured["params"] == {"epochs": "5"}  # default epochs
    assert captured["content"] == b"hello walrus"
    assert result.root_hash == "ABC123"
    assert result.tx_hash == ""


def test_put_blob_walrus_already_certified(walrus_env, monkeypatch):
    monkeypatch.setenv("WALRUS_EPOCHS", "12")
    captured = {}

    def fake_put(url, params=None, content=None, timeout=None):
        captured.update(params=params)
        return _Resp(json_body={"alreadyCertified": {"blobId": "XYZ"}})

    monkeypatch.setattr(httpx, "put", fake_put)
    result = c.put_blob(b"x")

    assert captured["params"] == {"epochs": "12"}
    assert result.root_hash == "XYZ"


def test_put_blob_walrus_unexpected_shape(walrus_env, monkeypatch):
    monkeypatch.setattr(httpx, "put", lambda *a, **k: _Resp(json_body={"weird": 1}))
    with pytest.raises(c.OgStorageError, match="unexpected shape"):
        c.put_blob(b"x")


def test_put_blob_walrus_http_error(walrus_env, monkeypatch):
    monkeypatch.setattr(
        httpx, "put", lambda *a, **k: _Resp(status_code=500, text="boom")
    )
    with pytest.raises(c.OgStorageError, match="HTTP 500"):
        c.put_blob(b"x")


def test_get_blob_walrus(walrus_env, monkeypatch):
    captured = {}

    def fake_get(url, timeout=None):
        captured["url"] = url
        return _Resp(content=b"the bytes")

    monkeypatch.setattr(httpx, "get", fake_get)
    data = c.get_blob("ABC123")

    assert captured["url"] == "https://agg.example/v1/blobs/ABC123"
    assert data == b"the bytes"


def test_get_blob_walrus_http_error(walrus_env, monkeypatch):
    monkeypatch.setattr(
        httpx, "get", lambda *a, **k: _Resp(status_code=404, text="missing")
    )
    with pytest.raises(c.OgStorageError, match="HTTP 404"):
        c.get_blob("nope")


def test_walrus_missing_publisher_env(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "walrus")
    monkeypatch.delenv("WALRUS_PUBLISHER", raising=False)
    with pytest.raises(c.OgStorageError, match="WALRUS_PUBLISHER"):
        c.put_blob(b"x")


def test_put_blob_rejects_empty_regardless_of_backend(walrus_env):
    with pytest.raises(c.OgStorageError, match="empty"):
        c.put_blob(b"")


@pytest.mark.skipif(
    not (os.environ.get("WALRUS_PUBLISHER") and os.environ.get("WALRUS_AGGREGATOR")),
    reason="WALRUS_PUBLISHER/WALRUS_AGGREGATOR not set; skipping live Walrus test",
)
def test_live_round_trip_small_blob(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "walrus")
    blob = b"chaingammon-walrus:" + secrets.token_bytes(64)
    result = c.put_blob(blob)
    assert result.root_hash, "expected a non-empty Walrus blobId"
    fetched = c.get_blob(result.root_hash)
    assert fetched == blob, "downloaded bytes did not match what we uploaded"
