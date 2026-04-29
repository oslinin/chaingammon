"""
backgammon/og/storage.py — 0G Storage integration for checkpoint and game record persistence.

Uses the same og-bridge Node.js shim as the rest of this repo
(og-bridge/src/upload.mjs / download.mjs).  Requires env vars:
  OG_STORAGE_RPC, OG_STORAGE_INDEXER, OG_STORAGE_PRIVATE_KEY

Storage keys are content-addressed: sha256(weights_bytes) for
checkpoints, ensuring deduplication across nodes.

When storage env vars are absent, functions raise OgStorageError
rather than silently no-op-ing, so callers can guard with --no-storage.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
from pathlib import Path
from typing import Any

import torch

# Path to og-bridge scripts at the repo root.
_BRIDGE_DIR = Path(__file__).resolve().parents[3] / "og-bridge"
_UPLOAD = _BRIDGE_DIR / "src" / "upload.mjs"
_DOWNLOAD = _BRIDGE_DIR / "src" / "download.mjs"

_REQUIRED_ENV = ("OG_STORAGE_RPC", "OG_STORAGE_INDEXER", "OG_STORAGE_PRIVATE_KEY")

_URI_PREFIX = "0g://"


class OgStorageError(RuntimeError):
    """Raised when the og-bridge subprocess fails."""


def _check_env() -> None:
    missing = [k for k in _REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        raise OgStorageError(f"Missing 0G Storage env vars: {missing}")


def _upload_bytes(data: bytes, *, timeout: float = 180.0) -> str:
    """Upload raw bytes; return 0G URI string."""
    _check_env()
    proc = subprocess.run(
        ["node", str(_UPLOAD)],
        input=data,
        capture_output=True,
        env=os.environ.copy(),
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise OgStorageError(
            f"og-bridge upload failed: {proc.stderr.decode(errors='replace')}"
        )
    payload = json.loads(proc.stdout.decode().strip())
    root_hash: str = payload["rootHash"]
    return f"{_URI_PREFIX}{root_hash}"


def _download_bytes(uri: str, *, timeout: float = 120.0) -> bytes:
    """Download raw bytes from a 0G URI."""
    _check_env()
    if not uri.startswith(_URI_PREFIX):
        raise OgStorageError(f"Invalid 0G URI: {uri!r}")
    root_hash = uri[len(_URI_PREFIX):]
    proc = subprocess.run(
        ["node", str(_DOWNLOAD), root_hash],
        capture_output=True,
        env=os.environ.copy(),
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise OgStorageError(
            f"og-bridge download failed: {proc.stderr.decode(errors='replace')}"
        )
    return proc.stdout


def upload_checkpoint(state_dict: dict[str, Any]) -> str:
    """Serialise *state_dict* and upload to 0G Storage.

    Returns a ``0g://0x<rootHash>`` URI.  The root hash is sha256 of the
    serialised weights bytes, so identical weights deduplicate automatically.
    """
    buf = io.BytesIO()
    torch.save(state_dict, buf)
    data = buf.getvalue()
    return _upload_bytes(data)


def download_checkpoint(uri: str) -> dict[str, Any]:
    """Download checkpoint bytes from *uri* and deserialise with torch.load."""
    data = _download_bytes(uri)
    buf = io.BytesIO(data)
    return torch.load(buf, map_location="cpu", weights_only=True)


def upload_game_record(trajectory_dict: dict) -> str:
    """Serialise a game record dict to JSON and upload to 0G Storage.

    Returns a ``0g://0x<rootHash>`` URI.
    """
    data = json.dumps(trajectory_dict, ensure_ascii=False).encode("utf-8")
    return _upload_bytes(data)
