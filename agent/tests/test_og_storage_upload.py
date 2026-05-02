"""Tests for og_storage_upload.py.

Run with:  cd agent && uv run pytest tests/test_og_storage_upload.py -v

These tests do NOT spin up a real 0G Storage testnet upload — that
requires a funded wallet, network access, and is the integration test
covered by `pnpm test` end-to-end. Instead they exercise the
input-validation and subprocess-error paths so the helper fails fast
and informatively when called wrong.

For the actual upload happy path, run:

    OG_STORAGE_MODE=localhost \\
    OG_STORAGE_PRIVATE_KEY=0x... \\
    LOCALHOST_MOCK_OG_STORAGE=0x... \\
    cd agent && uv run python -c "
        from og_storage_upload import upload_checkpoint
        print(upload_checkpoint(b'hello world'))
    "

— which exercises the og-bridge against the local Hardhat MockOgStorage.
"""
from __future__ import annotations

import json
import subprocess
from unittest.mock import patch

import pytest

import og_storage_upload
from og_storage_upload import (
    OgUploadError,
    UploadResult,
    upload_checkpoint,
)


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def test_empty_blob_raises():
    with patch.dict("os.environ", {
        "OG_STORAGE_RPC": "x",
        "OG_STORAGE_INDEXER": "y",
        "OG_STORAGE_PRIVATE_KEY": "z",
    }):
        with pytest.raises(OgUploadError, match="empty bytes"):
            upload_checkpoint(b"")


def test_missing_env_raises_in_testnet_mode():
    with patch.dict("os.environ", {}, clear=True):
        with pytest.raises(OgUploadError, match="Missing env vars"):
            upload_checkpoint(b"some bytes")


def test_localhost_mode_skips_testnet_env_check():
    """OG_STORAGE_MODE=localhost is the dev path against MockOgStorage;
    the testnet env triple isn't required there. _check_env should
    return without raising — the empty-blob check then catches us
    before we actually try to subprocess."""
    with patch.dict("os.environ", {"OG_STORAGE_MODE": "localhost"}, clear=True):
        # Empty blob still fails, but we want to confirm it's the empty-blob
        # check that fires (post env-check), not the missing-env check.
        with pytest.raises(OgUploadError, match="empty bytes"):
            upload_checkpoint(b"")


# ---------------------------------------------------------------------------
# Subprocess error handling
# ---------------------------------------------------------------------------


def _stub_completed(returncode: int, stdout: bytes, stderr: bytes = b""):
    return subprocess.CompletedProcess(
        args=["node"], returncode=returncode, stdout=stdout, stderr=stderr,
    )


@pytest.fixture
def env_set():
    with patch.dict("os.environ", {
        "OG_STORAGE_RPC": "https://example",
        "OG_STORAGE_INDEXER": "https://example",
        "OG_STORAGE_PRIVATE_KEY": "0xdeadbeef",
    }):
        yield


def test_happy_path_returns_upload_result(env_set):
    """A well-formed bridge response yields a populated UploadResult."""
    response = json.dumps({"rootHash": "0xabc", "txHash": "0x123"}).encode()
    with patch.object(subprocess, "run", return_value=_stub_completed(0, response)):
        result = upload_checkpoint(b"some bytes")
    assert isinstance(result, UploadResult)
    assert result.root_hash == "0xabc"
    assert result.tx_hash == "0x123"


def test_nonzero_exit_surfaces_stderr(env_set):
    """When the bridge fails the helper must surface the stderr text
    so the caller knows what 0G refused."""
    with patch.object(
        subprocess, "run",
        return_value=_stub_completed(1, b"", b"insufficient balance"),
    ):
        with pytest.raises(OgUploadError, match="insufficient balance"):
            upload_checkpoint(b"some bytes")


def test_non_json_stdout_raises(env_set):
    """A protocol error (bridge changed shape, version mismatch) must
    fail loudly, not silently."""
    with patch.object(subprocess, "run", return_value=_stub_completed(0, b"not json")):
        with pytest.raises(OgUploadError, match="non-JSON"):
            upload_checkpoint(b"some bytes")


def test_missing_keys_in_response_raises(env_set):
    """If the bridge returns JSON but without the expected keys, fail
    early with a clear message."""
    response = json.dumps({"rootHash": "0xabc"}).encode()  # txHash missing
    with patch.object(subprocess, "run", return_value=_stub_completed(0, response)):
        with pytest.raises(OgUploadError, match="missing expected key"):
            upload_checkpoint(b"some bytes")


def test_timeout_surfaces_as_OgUploadError(env_set):
    with patch.object(
        subprocess, "run",
        side_effect=subprocess.TimeoutExpired(cmd="node", timeout=180.0),
    ):
        with pytest.raises(OgUploadError, match="timed out"):
            upload_checkpoint(b"some bytes", timeout=180.0)


# ---------------------------------------------------------------------------
# Bridge script presence
# ---------------------------------------------------------------------------


def test_missing_bridge_script_raises(env_set, tmp_path, monkeypatch):
    """If og-bridge isn't installed, the helper must fail with an
    actionable message ('run pnpm install') rather than a confusing
    FileNotFoundError from subprocess."""
    monkeypatch.setattr(og_storage_upload, "_UPLOAD_SCRIPT",
                        tmp_path / "missing.mjs")
    with pytest.raises(OgUploadError, match="not found"):
        upload_checkpoint(b"some bytes")
