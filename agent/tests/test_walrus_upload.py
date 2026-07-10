"""Tests for walrus_upload.py.

Run with:  cd agent && uv run pytest tests/test_walrus_upload.py -v

These tests do NOT hit a real Walrus publisher/aggregator — that
requires live network access, which this sandbox's egress policy blocks
(see sui/README.md's "unverified" caveats for the same limitation on the
Sui CLI). Instead they mock httpx.put/httpx.get and exercise the
response-parsing and error-handling paths, mirroring
test_og_storage_upload.py's approach for the 0G bridge.

For an actual upload against the public testnet publisher (from an
environment with network access):

    cd agent && uv run python -c "
        from walrus_upload import upload_checkpoint, fetch_blob
        result = upload_checkpoint(b'hello world')
        print(result)
        print(fetch_blob(result.blob_id))
    "
"""
from __future__ import annotations

import json
from unittest.mock import patch

import httpx
import pytest

from walrus_upload import UploadResult, WalrusUploadError, fetch_blob, upload_checkpoint


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def test_empty_blob_raises():
    with pytest.raises(WalrusUploadError, match="empty bytes"):
        upload_checkpoint(b"")


def test_empty_blob_id_raises():
    with pytest.raises(WalrusUploadError, match="empty blob_id"):
        fetch_blob("")


# ---------------------------------------------------------------------------
# upload_checkpoint
# ---------------------------------------------------------------------------


def _stub_response(status_code: int, json_body: dict | None = None, text: str = ""):
    resp = httpx.Response(
        status_code=status_code,
        content=json.dumps(json_body).encode() if json_body is not None else text.encode(),
        request=httpx.Request("PUT", "https://example.test/v1/blobs"),
    )
    return resp


def test_newly_created_happy_path():
    body = {"newlyCreated": {"blobObject": {"id": "0xobj", "blobId": "0xblob"}}}
    with patch.object(httpx, "put", return_value=_stub_response(200, body)):
        result = upload_checkpoint(b"some bytes")
    assert isinstance(result, UploadResult)
    assert result.blob_id == "0xblob"
    assert result.sui_object_id == "0xobj"


def test_already_certified_happy_path():
    body = {"alreadyCertified": {"blobId": "0xblob", "event": {"txDigest": "0xtx", "eventSeq": "0"}}}
    with patch.object(httpx, "put", return_value=_stub_response(200, body)):
        result = upload_checkpoint(b"some bytes")
    assert result.blob_id == "0xblob"
    assert result.sui_object_id is None


def test_http_error_status_raises():
    with patch.object(httpx, "put", return_value=_stub_response(500, text="internal error")):
        with pytest.raises(WalrusUploadError, match="500"):
            upload_checkpoint(b"some bytes")


def test_non_json_response_raises():
    with patch.object(httpx, "put", return_value=_stub_response(200, text="not json")):
        with pytest.raises(WalrusUploadError, match="non-JSON"):
            upload_checkpoint(b"some bytes")


def test_unrecognized_response_shape_raises():
    with patch.object(httpx, "put", return_value=_stub_response(200, {"somethingElse": {}})):
        with pytest.raises(WalrusUploadError, match="neither 'newlyCreated' nor 'alreadyCertified'"):
            upload_checkpoint(b"some bytes")


def test_newly_created_missing_key_raises():
    body = {"newlyCreated": {"blobObject": {"id": "0xobj"}}}  # blobId missing
    with patch.object(httpx, "put", return_value=_stub_response(200, body)):
        with pytest.raises(WalrusUploadError, match="missing expected key"):
            upload_checkpoint(b"some bytes")


def test_network_error_wrapped():
    with patch.object(httpx, "put", side_effect=httpx.ConnectError("connection refused")):
        with pytest.raises(WalrusUploadError, match="Walrus publisher request failed"):
            upload_checkpoint(b"some bytes")


def test_epochs_query_param_forwarded():
    captured = {}

    def fake_put(url, **kwargs):
        captured["url"] = url
        return _stub_response(200, {"alreadyCertified": {"blobId": "0xblob"}})

    with patch.object(httpx, "put", side_effect=fake_put):
        upload_checkpoint(b"some bytes", epochs=5)
    assert "epochs=5" in captured["url"]


# ---------------------------------------------------------------------------
# fetch_blob
# ---------------------------------------------------------------------------


def test_fetch_blob_happy_path():
    resp = httpx.Response(
        status_code=200, content=b"raw bytes",
        request=httpx.Request("GET", "https://example.test/v1/blobs/0xblob"),
    )
    with patch.object(httpx, "get", return_value=resp):
        assert fetch_blob("0xblob") == b"raw bytes"


def test_fetch_blob_http_error_raises():
    resp = httpx.Response(
        status_code=404, content=b"not found",
        request=httpx.Request("GET", "https://example.test/v1/blobs/0xmissing"),
    )
    with patch.object(httpx, "get", return_value=resp):
        with pytest.raises(WalrusUploadError, match="404"):
            fetch_blob("0xmissing")


def test_fetch_blob_network_error_wrapped():
    with patch.object(httpx, "get", side_effect=httpx.ConnectError("connection refused")):
        with pytest.raises(WalrusUploadError, match="Walrus aggregator request failed"):
            fetch_blob("0xblob")
