"""Tests for og_storage_download.py.

Run with:  cd agent && uv run pytest tests/test_og_storage_download.py -v

These tests do NOT spin up a real 0G Storage download — that's the
integration-test path. They cover input validation, env enforcement,
and subprocess error-surfacing so the helper fails fast and clearly
when called wrong.

Bonus coverage: an end-to-end round-trip test that mocks both the
upload and download subprocesses and verifies that
encrypt → upload → download → decrypt recovers the original
checkpoint bytes.
"""
from __future__ import annotations

import json
import subprocess
from unittest.mock import patch

import pytest

import og_storage_download
from checkpoint_encryption import decrypt_blob, encrypt_blob, generate_key
from og_storage_download import (
    OgDownloadError,
    fetch_checkpoint,
)
from og_storage_upload import upload_checkpoint


VALID_HASH = "0x" + "ab" * 32   # 0x-prefixed 64 hex chars


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def test_rejects_non_hash_input():
    """Calls with a clearly-malformed hash should fail before
    spawning a subprocess — saves a noisy failure later."""
    with patch.dict("os.environ", {"OG_STORAGE_INDEXER": "https://x"}):
        for bad in ("0xabc", "abcd", VALID_HASH[2:], VALID_HASH + "ff"):
            with pytest.raises(OgDownloadError, match="root_hash must"):
                fetch_checkpoint(bad)


def test_missing_env_raises_in_testnet_mode():
    """Without OG_STORAGE_INDEXER the bridge will fail anyway; we
    surface that up-front with a clear message."""
    with patch.dict("os.environ", {}, clear=True):
        with pytest.raises(OgDownloadError, match="Missing env vars"):
            fetch_checkpoint(VALID_HASH)


def test_localhost_mode_skips_testnet_env_check(tmp_path, monkeypatch):
    """OG_STORAGE_MODE=localhost is the dev path against
    MockOgStorage; it doesn't need OG_STORAGE_INDEXER."""
    monkeypatch.setattr(og_storage_download, "_DOWNLOAD_SCRIPT",
                        tmp_path / "missing.mjs")
    with patch.dict("os.environ", {"OG_STORAGE_MODE": "localhost"}, clear=True):
        # Should now fail on the script-presence check, NOT on env —
        # the env-missing check would say 'Missing env vars' instead.
        with pytest.raises(OgDownloadError, match="not found"):
            fetch_checkpoint(VALID_HASH)


# ---------------------------------------------------------------------------
# Subprocess error handling
# ---------------------------------------------------------------------------


def _stub_completed(returncode: int, stdout: bytes, stderr: bytes = b""):
    return subprocess.CompletedProcess(
        args=["node"], returncode=returncode, stdout=stdout, stderr=stderr,
    )


@pytest.fixture
def env_set():
    with patch.dict("os.environ", {"OG_STORAGE_INDEXER": "https://example"}):
        yield


def test_happy_path_returns_bytes(env_set):
    """A well-formed bridge response yields the raw bytes."""
    with patch.object(subprocess, "run",
                      return_value=_stub_completed(0, b"the blob")):
        assert fetch_checkpoint(VALID_HASH) == b"the blob"


def test_nonzero_exit_surfaces_stderr(env_set):
    with patch.object(
        subprocess, "run",
        return_value=_stub_completed(1, b"", b"hash not found"),
    ):
        with pytest.raises(OgDownloadError, match="hash not found"):
            fetch_checkpoint(VALID_HASH)


def test_zero_byte_response_raises(env_set):
    """An empty stdout almost certainly means the indexer doesn't have
    the blob — surface that instead of returning empty bytes."""
    with patch.object(subprocess, "run", return_value=_stub_completed(0, b"")):
        with pytest.raises(OgDownloadError, match="0 bytes"):
            fetch_checkpoint(VALID_HASH)


def test_timeout_surfaces_as_OgDownloadError(env_set):
    with patch.object(
        subprocess, "run",
        side_effect=subprocess.TimeoutExpired(cmd="node", timeout=180.0),
    ):
        with pytest.raises(OgDownloadError, match="timed out"):
            fetch_checkpoint(VALID_HASH, timeout=180.0)


def test_missing_bridge_script_raises(env_set, tmp_path, monkeypatch):
    monkeypatch.setattr(og_storage_download, "_DOWNLOAD_SCRIPT",
                        tmp_path / "missing.mjs")
    with pytest.raises(OgDownloadError, match="not found"):
        fetch_checkpoint(VALID_HASH)


# ---------------------------------------------------------------------------
# End-to-end round-trip (mocked upload + download)
# ---------------------------------------------------------------------------


def test_encrypt_upload_download_decrypt_round_trip():
    """Stitch all four pieces of the checkpoint lifecycle together:

        encrypt_blob → upload_checkpoint → fetch_checkpoint → decrypt_blob

    The upload + download subprocesses are mocked, but the encryption
    layer is real — this catches a class of bug where one side
    serializes nonce|ciphertext but the other expects ciphertext|nonce."""
    plaintext = b"the trained value-net state_dict bytes"
    key = generate_key()
    sealed = encrypt_blob(plaintext, key)

    # Mock upload first.
    upload_response = json.dumps({"rootHash": VALID_HASH, "txHash": "0x1"}).encode()
    env = {
        "OG_STORAGE_RPC": "x",
        "OG_STORAGE_INDEXER": "y",
        "OG_STORAGE_PRIVATE_KEY": "z",
    }
    with patch.dict("os.environ", env), \
         patch.object(subprocess, "run",
                      return_value=_stub_completed(0, upload_response)):
        upload_result = upload_checkpoint(sealed)

    assert upload_result.root_hash == VALID_HASH

    # Now mock download to return the sealed bytes back.
    with patch.dict("os.environ", env), \
         patch.object(subprocess, "run",
                      return_value=_stub_completed(0, sealed)):
        fetched_sealed = fetch_checkpoint(upload_result.root_hash)

    assert fetched_sealed == sealed
    assert decrypt_blob(fetched_sealed, key) == plaintext
