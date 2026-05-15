"""
0G Storage client — thin Python wrapper around the og-bridge Node CLI.

There is no native Python SDK for 0G Storage, so we shell out to the
TypeScript SDK (for blobs) or the 0G KV REST API (for key-value) via four
CLI scripts in /og-bridge:

  - og-bridge/src/upload.mjs    bytes via stdin → JSON {rootHash, txHash}
  - og-bridge/src/download.mjs  rootHash arg     → bytes via stdout
  - og-bridge/src/kv-put.mjs    key arg + bytes via stdin → JSON {key, ok}
  - og-bridge/src/kv-get.mjs    key arg          → bytes via stdout

Two storage primitives and when to use each:

  Blob storage (put_blob / get_blob):
    Content-addressed, immutable, hash committed on-chain. Use for large
    artifacts whose integrity must be cryptographically provable — e.g.
    NN weight checkpoints stored under dataHashes[1] of an agent iNFT.

  KV store (put_kv / get_kv):
    Mutable, latest-value semantics, keyed by an arbitrary string. Use for
    small frequently-updated data where an on-chain hash commitment is not
    required — e.g. per-agent style overlays updated after every match.
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

    In localhost mode (OG_STORAGE_MODE=localhost) this writes to a local
    JSON file mock and does not require OG_STORAGE_* env vars.
    In testnet mode OG_KV_URL must be set.
    """
    if not data:
        raise OgStorageError("put_kv received empty bytes")
    env = os.environ.copy()
    if env.get("OG_STORAGE_MODE") != "localhost":
        if not env.get("OG_KV_URL"):
            raise OgStorageError("Missing OG_KV_URL env var for 0G KV writes")
    proc = subprocess.run(
        ["node", str(_KV_PUT_SCRIPT), key],
        input=data,
        capture_output=True,
        env=env,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise OgStorageError(
            f"og-bridge kv-put failed (exit {proc.returncode}): {proc.stderr.decode(errors='replace')}"
        )
    try:
        payload = json.loads(proc.stdout.decode().strip())
    except json.JSONDecodeError as e:
        raise OgStorageError(f"og-bridge kv-put returned non-JSON: {proc.stdout!r}") from e
    if not payload.get("ok"):
        raise OgStorageError(f"og-bridge kv-put reported failure: {payload}")


def get_kv(key: str, *, timeout: float = 30.0) -> bytes:
    """Fetch bytes stored under `key` from 0G KV. Raises OgStorageError if not found.

    In localhost mode (OG_STORAGE_MODE=localhost) this reads from the local
    JSON file mock. In testnet mode OG_KV_URL must be set.
    """
    env = os.environ.copy()
    if env.get("OG_STORAGE_MODE") != "localhost":
        if not env.get("OG_KV_URL"):
            raise OgStorageError("Missing OG_KV_URL env var for 0G KV reads")
    proc = subprocess.run(
        ["node", str(_KV_GET_SCRIPT), key],
        capture_output=True,
        env=env,
        timeout=timeout,
        check=False,
    )
    if proc.returncode == 2:
        # Exit 2 from kv-get.mjs means key not found.
        raise OgStorageError(f"0G KV key not found: {key!r}")
    if proc.returncode != 0:
        raise OgStorageError(
            f"og-bridge kv-get failed (exit {proc.returncode}): {proc.stderr.decode(errors='replace')}"
        )
    return proc.stdout
