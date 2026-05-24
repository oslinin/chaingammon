"""
0G Storage client — thin Python wrapper around the og-bridge Node CLI.

There is no native Python SDK for 0G Storage, so we shell out to the
TypeScript SDK via CLI scripts in /og-bridge:

Two storage primitives are available, each suited to different artifacts:

  Blob storage (immutable, content-addressed):
    - og-bridge/src/upload.mjs    bytes via stdin → JSON {rootHash, txHash}
    - og-bridge/src/download.mjs  rootHash arg     → bytes via stdout
    Use for: per-match GameRecord blobs (fetched by root hash from MatchRegistry)

  KV storage (mutable, key-addressed):
    - og-bridge/src/kv-put.mjs    key arg + bytes via stdin → JSON {key, ok}
    - og-bridge/src/kv-get.mjs    key arg → bytes via stdout
    Use for: mutable agent state — NN weights and feature overlays — where
    every training run or game should overwrite in place without burning gas
    or orphaning old blobs.

Canonical KV key scheme:
  chaingammon/weights/agent/{agent_id}       — ONNX/PyTorch checkpoint
  chaingammon/overlay/agent/{agent_id}       — 21-float JSON style overlay
  chaingammon/overlay/human/{address_lower}  — future: per-human style profile
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
_KV_PUT_SCRIPT = _BRIDGE_DIR / "src" / "kv-put.mjs"
_KV_GET_SCRIPT = _BRIDGE_DIR / "src" / "kv-get.mjs"

_REQUIRED_ENV = ("OG_STORAGE_RPC", "OG_STORAGE_INDEXER", "OG_STORAGE_PRIVATE_KEY")

# Server-side JSON fallback for KV. Used when the 0G KV Node script fails
# (e.g. on testnet before the 0G SDK ships a KV client). Data is stored as
# base64 so the JSON file stays valid for arbitrary byte payloads.
_KV_FALLBACK_PATH = Path(os.environ.get("KV_MOCK_PATH", "/tmp/chaingammon-kv-mock.json"))


def _fallback_put(key: str, data: bytes) -> None:
    import base64
    store: dict = {}
    if _KV_FALLBACK_PATH.exists():
        try:
            store = json.loads(_KV_FALLBACK_PATH.read_text())
        except Exception:
            store = {}
    store[key] = base64.b64encode(data).decode()
    _KV_FALLBACK_PATH.write_text(json.dumps(store))


def _fallback_get(key: str) -> bytes:
    import base64
    if not _KV_FALLBACK_PATH.exists():
        raise OgStorageError(f"get_kv: key not found in fallback store: {key!r}")
    try:
        store = json.loads(_KV_FALLBACK_PATH.read_text())
    except Exception as e:
        raise OgStorageError(f"get_kv: could not read fallback store: {e}") from e
    if key not in store:
        raise OgStorageError(f"get_kv: key not found in fallback store: {key!r}")
    return base64.b64decode(store[key])


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


def put_kv(key: str, data: bytes, *, timeout: float = 30.0) -> None:
    """Write `data` to 0G KV under `key`. Overwrites any prior value.

    Tries the og-bridge Node script first; if it fails (e.g. testnet before
    the 0G SDK ships a KV client), falls back to a local JSON file at
    KV_MOCK_PATH (default /tmp/chaingammon-kv-mock.json). Data persists on
    the server across restarts and will be served by get_kv via the same
    fallback until 0G KV becomes available.
    """
    if not key:
        raise OgStorageError("put_kv: key must not be empty")
    if not data:
        raise OgStorageError("put_kv: data must not be empty")
    proc = subprocess.run(
        ["node", str(_KV_PUT_SCRIPT), key],
        input=data,
        capture_output=True,
        env=os.environ.copy(),
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        _fallback_put(key, data)


def get_kv(key: str, *, timeout: float = 30.0) -> bytes:
    """Fetch bytes from 0G KV. Raises OgStorageError if the key is not found.

    Tries the og-bridge Node script first; falls back to the local JSON file
    if the script fails (mirrors the put_kv fallback so the same data is
    readable on testnet until 0G KV is available).
    """
    if not key:
        raise OgStorageError("get_kv: key must not be empty")
    proc = subprocess.run(
        ["node", str(_KV_GET_SCRIPT), key],
        capture_output=True,
        env=os.environ.copy(),
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        return _fallback_get(key)
    return proc.stdout
