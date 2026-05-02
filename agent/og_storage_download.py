"""og_storage_download.py — agent-side wrapper to fetch checkpoints from 0G Storage.

Symmetric of `og_storage_upload.upload_checkpoint`: takes a Merkle
root hash (the value committed to `iNFT.dataHashes[1]`) and returns
the raw bytes — typically a sealed checkpoint envelope from
`checkpoint_encryption.encrypt_blob`.

Closes the resume-training read path:

    sealed = fetch_checkpoint(root_hash)                  # this module
    raw    = decrypt_blob(sealed, key)                    # checkpoint_encryption
    Path("/tmp/resumed.pt").write_bytes(raw)
    net, mc = load_checkpoint(Path("/tmp/resumed.pt"))    # sample_trainer

This module shells out to `og-bridge/src/download.mjs` the same way
`og_storage_upload.py` shells out to `upload.mjs` — there is no native
Python SDK for 0G Storage, and the TypeScript SDK is the canonical
client.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path


_BRIDGE_DIR = Path(__file__).resolve().parents[1] / "og-bridge"
_DOWNLOAD_SCRIPT = _BRIDGE_DIR / "src" / "download.mjs"

# Testnet mode requires only the indexer URL — the bridge fetches blobs
# read-only, so OG_STORAGE_PRIVATE_KEY isn't needed for the download path
# (mirrors the env enforcement in og-bridge/src/download.mjs itself).
_REQUIRED_ENV_TESTNET = ("OG_STORAGE_INDEXER",)

# 0x-prefixed 64 hex chars (32 bytes).
_ROOT_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


class OgDownloadError(RuntimeError):
    """Wraps any error from the og-bridge download subprocess."""


def _check_env() -> None:
    if os.environ.get("OG_STORAGE_MODE", "testnet") == "localhost":
        return
    missing = [k for k in _REQUIRED_ENV_TESTNET if not os.environ.get(k)]
    if missing:
        raise OgDownloadError(
            f"Missing env vars for 0G Storage download: {missing}. "
            f"See server/.env.example for the canonical names."
        )


def fetch_checkpoint(root_hash: str, *, timeout: float = 180.0) -> bytes:
    """Fetch the bytes published under `root_hash` from 0G Storage.

    `root_hash` must be a 0x-prefixed 32-byte hex string (the same
    format `og_storage_upload.UploadResult.root_hash` produces).
    `timeout` defaults to 180s — testnet downloads occasionally wait
    on the indexer to finish syncing recently-published blobs.

    Returns the raw bytes. The caller is responsible for any
    decryption / decoding (production callers pass the result to
    `checkpoint_encryption.decrypt_blob`)."""
    if not _ROOT_HASH_RE.match(root_hash):
        raise OgDownloadError(
            f"root_hash must be 0x-prefixed 64 hex chars (32 bytes), "
            f"got {root_hash!r}"
        )
    _check_env()
    if not _DOWNLOAD_SCRIPT.exists():
        raise OgDownloadError(
            f"og-bridge download script not found at {_DOWNLOAD_SCRIPT}. "
            f"Run `pnpm install` from the repo root first."
        )

    try:
        proc = subprocess.run(
            ["node", str(_DOWNLOAD_SCRIPT), root_hash],
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise OgDownloadError(
            f"og-bridge download timed out after {timeout}s"
        ) from e

    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="replace").strip()
        raise OgDownloadError(
            f"og-bridge download failed (exit {proc.returncode}): {stderr}"
        )

    if not proc.stdout:
        raise OgDownloadError(
            f"og-bridge returned 0 bytes for {root_hash} — likely the "
            f"hash is unknown to the indexer or the blob has been "
            f"unpinned."
        )
    return proc.stdout
