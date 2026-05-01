"""og_storage_upload.py — agent-side wrapper to publish encrypted
checkpoints to 0G Storage.

The README's training lifecycle says:

    AES-GCM encrypt weights
    └─ Upload blob to 0G Storage  ← this module
    └─ Get Merkle root
    └─ KeeperHub workflow updates iNFT.dataHashes[1] = root

This module is the upload step. It shells out to the og-bridge Node
CLI (`og-bridge/src/upload.mjs`) the same way `server/app/og_storage_client.py`
and `agent/coach_compute_client.py` already do — there's no native
Python SDK for 0G Storage, so the TypeScript SDK is the canonical
client and the Python side talks to it via subprocess.

End-to-end flow for a trainer checkpoint:

    from sample_trainer import save_checkpoint, BackgammonNet
    from checkpoint_encryption import generate_key, encrypt_blob
    from og_storage_upload import upload_checkpoint

    save_checkpoint(net, Path("/tmp/local.pt"), match_count=N, extras_dim=K)
    raw   = Path("/tmp/local.pt").read_bytes()
    key   = generate_key()                                 # store under iNFT control
    sealed = encrypt_blob(raw, key, associated_data=str(inft_id).encode())
    result = upload_checkpoint(sealed)
    # result.root_hash is what KeeperHub writes to iNFT.dataHashes[1].

The local file format (the .pt save_checkpoint produces) is identical
shape; only the ciphertext envelope differs. So a holder of the key
can fetch + decrypt + load_checkpoint to resume training.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Path to og-bridge at the repo root.
# agent/og_storage_upload.py → parents[1] → repo root → og-bridge
_BRIDGE_DIR = Path(__file__).resolve().parents[1] / "og-bridge"
_UPLOAD_SCRIPT = _BRIDGE_DIR / "src" / "upload.mjs"

_REQUIRED_ENV_TESTNET = (
    "OG_STORAGE_RPC",
    "OG_STORAGE_INDEXER",
    "OG_STORAGE_PRIVATE_KEY",
)


class OgUploadError(RuntimeError):
    """Wraps any error from the og-bridge upload subprocess."""


@dataclass(frozen=True)
class UploadResult:
    """0G Storage's response on a successful upload.

    `root_hash` is the 32-byte Merkle root (hex-prefixed) that any
    other client uses to fetch the blob — and is the value committed
    to `iNFT.dataHashes[1]` for trainer checkpoints.

    `tx_hash` is the on-chain tx that pinned the entry to the storage
    flow contract, useful for explorer links + audit trails."""
    root_hash: str
    tx_hash: str


def _check_env() -> None:
    """Verify the env vars the og-bridge upload script needs are set.

    The bridge supports two modes via OG_STORAGE_MODE: testnet (default)
    and localhost (against MockOgStorage). Localhost mode has its own
    optional env (LOCALHOST_RPC etc.); we only enforce testnet env up
    front because that's the production path. Localhost runs surface
    their own errors from the bridge directly."""
    if os.environ.get("OG_STORAGE_MODE", "testnet") == "localhost":
        return
    missing = [k for k in _REQUIRED_ENV_TESTNET if not os.environ.get(k)]
    if missing:
        raise OgUploadError(
            f"Missing env vars for 0G Storage upload: {missing}. "
            f"See server/.env.example for the canonical names."
        )


def upload_checkpoint(blob: bytes, *, timeout: float = 180.0) -> UploadResult:
    """Upload `blob` (typically the encrypted-checkpoint envelope from
    `checkpoint_encryption.encrypt_blob`) to 0G Storage and return the
    Merkle root + on-chain tx hash.

    `timeout` defaults to 180s because testnet uploads wait on the
    flow-contract tx to be included — typically 20-40s but can spike."""
    _check_env()
    if not blob:
        raise OgUploadError("upload_checkpoint received empty bytes")
    if not _UPLOAD_SCRIPT.exists():
        raise OgUploadError(
            f"og-bridge upload script not found at {_UPLOAD_SCRIPT}. "
            f"Run `pnpm install` from the repo root first."
        )

    try:
        proc = subprocess.run(
            ["node", str(_UPLOAD_SCRIPT)],
            input=blob,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise OgUploadError(
            f"og-bridge upload timed out after {timeout}s"
        ) from e

    if proc.returncode != 0:
        # The bridge writes diagnostics to stderr; surface them so the
        # caller can see what 0G refused.
        stderr = proc.stderr.decode("utf-8", errors="replace").strip()
        raise OgUploadError(
            f"og-bridge upload failed (exit {proc.returncode}): {stderr}"
        )

    try:
        parsed = json.loads(proc.stdout.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise OgUploadError(
            f"og-bridge upload returned non-JSON: "
            f"{proc.stdout!r}"
        ) from e

    try:
        return UploadResult(
            root_hash=str(parsed["rootHash"]),
            tx_hash=str(parsed["txHash"]),
        )
    except KeyError as e:
        raise OgUploadError(
            f"og-bridge upload response missing expected key {e}: {parsed}"
        ) from e
