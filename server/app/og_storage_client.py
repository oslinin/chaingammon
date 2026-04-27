"""
0G Storage client — thin Python wrapper around the og-bridge Node CLI.

There is no native Python SDK for 0G Storage, so we shell out to the
TypeScript SDK via two CLI scripts in /og-bridge:

  - og-bridge/src/upload.mjs    bytes via stdin → JSON {rootHash, txHash}
  - og-bridge/src/download.mjs  rootHash arg     → bytes via stdout

put_blob and get_blob round-trip arbitrary bytes against 0G Storage testnet.
Phase 7 will use this client to upload per-match game records; Phase 8 to
upload the encrypted gnubg base weights; Phase 9 to upload per-agent
experience overlays.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Path to the og-bridge package at the repo root.
_BRIDGE_DIR = Path(__file__).resolve().parents[2] / "og-bridge"
_UPLOAD_SCRIPT = _BRIDGE_DIR / "src" / "upload.mjs"
_DOWNLOAD_SCRIPT = _BRIDGE_DIR / "src" / "download.mjs"

_REQUIRED_ENV = ("OG_STORAGE_RPC", "OG_STORAGE_INDEXER", "OG_STORAGE_PRIVATE_KEY")


class OgStorageError(RuntimeError):
    """Wraps any error from the og-bridge subprocess."""


@dataclass(frozen=True)
class UploadResult:
    """What 0G Storage returns from a successful upload."""

    root_hash: str  # 0x-prefixed Merkle root used to fetch the blob later
    tx_hash: str  # on-chain tx that committed the entry to the storage flow


def _check_env() -> None:
    missing = [k for k in _REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        raise OgStorageError(f"Missing env vars for 0G Storage: {missing}")


def put_blob(data: bytes, *, timeout: float = 180.0) -> UploadResult:
    """Upload arbitrary bytes to 0G Storage and return the Merkle root + tx hash.

    Uploads can take ~30s on testnet because the SDK waits for inclusion of the
    flow-contract tx that pins the data. Default timeout is 180s.
    """
    _check_env()
    if not data:
        raise OgStorageError("put_blob received empty bytes")
    proc = subprocess.run(
        ["node", str(_UPLOAD_SCRIPT)],
        input=data,
        capture_output=True,
        env=os.environ.copy(),
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise OgStorageError(
            f"og-bridge upload failed (exit {proc.returncode}): {proc.stderr.decode(errors='replace')}"
        )
    try:
        payload = json.loads(proc.stdout.decode().strip())
    except json.JSONDecodeError as e:
        raise OgStorageError(f"og-bridge upload returned non-JSON: {proc.stdout!r}") from e
    return UploadResult(root_hash=payload["rootHash"], tx_hash=payload["txHash"])


def get_blob(root_hash: str, *, timeout: float = 120.0) -> bytes:
    """Download a blob from 0G Storage by its Merkle root and return raw bytes."""
    _check_env()
    if not root_hash.startswith("0x"):
        raise OgStorageError(f"root_hash must start with 0x, got {root_hash!r}")
    proc = subprocess.run(
        ["node", str(_DOWNLOAD_SCRIPT), root_hash],
        capture_output=True,
        env=os.environ.copy(),
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise OgStorageError(
            f"og-bridge download failed (exit {proc.returncode}): {proc.stderr.decode(errors='replace')}"
        )
    return proc.stdout
