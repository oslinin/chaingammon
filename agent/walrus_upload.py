"""walrus_upload.py — agent-side helper to publish (typically AES-GCM
encrypted) blobs to Walrus.

Sibling of og_storage_upload.py: same UploadResult/error-class shape, an
alternative blob store wired into sample_trainer.py's --upload-to-walrus
flag. Unlike 0G Storage, Walrus's public testnet publisher needs no
wallet/private key on this side — it's a plain HTTP PUT to a publisher
operator who funds the on-chain registration itself (see docs.wal.app's
"Storing Blobs" HTTP API) — so this talks to Walrus directly over HTTP
rather than shelling out to a bridge process.

NOTE: this is NOT the Task 7 Seal-encrypted agent-weights path. That path
(sui/scripts/mint_agent.ts / fetch_weights.ts) Seal-encrypts an ONNX
export with @mysten/seal's SealClient — identity-based encryption gated
by an on-chain seal_approve policy (sources/agent.move), decryptable only
by whoever currently owns the on-chain Agent object. This module is the
much simpler "swap Walrus in as an alternative to 0G for the app-managed
AES-GCM key" helper for the Python/trainer side (checkpoint_encryption.py
still does the encrypting; this module only uploads/downloads bytes).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

import httpx

DEFAULT_PUBLISHER_URL = "https://publisher.walrus-testnet.walrus.space"
DEFAULT_AGGREGATOR_URL = "https://aggregator.walrus-testnet.walrus.space"


class WalrusUploadError(RuntimeError):
    """Wraps any error from a Walrus publisher/aggregator HTTP request."""


@dataclass(frozen=True)
class UploadResult:
    """Walrus's response on a successful upload.

    `blob_id` is what `fetch_blob` (or any aggregator) uses to fetch the
    blob back — the value to persist alongside the encryption key,
    analogous to og_storage_upload.UploadResult.root_hash.

    `sui_object_id` is the on-chain Blob object's id when the publisher
    registered a NEW blob (None on an `alreadyCertified` response, since
    no new object was created — an existing registration already covers
    this blob's content)."""
    blob_id: str
    sui_object_id: str | None


def _publisher_url() -> str:
    return os.environ.get("WALRUS_PUBLISHER_URL", DEFAULT_PUBLISHER_URL).rstrip("/")


def _aggregator_url() -> str:
    return os.environ.get("WALRUS_AGGREGATOR_URL", DEFAULT_AGGREGATOR_URL).rstrip("/")


def upload_checkpoint(blob: bytes, *, epochs: int = 1, timeout: float = 60.0) -> UploadResult:
    """Upload `blob` to Walrus via the publisher's HTTP API and return its
    blob id.

    `epochs` is how many Walrus storage epochs to pay for — 1 is the
    HTTP API's own default and is enough for a demo/checkpoint that gets
    re-uploaded on every training run. The publisher itself pays the
    on-chain registration/certification cost for its public testnet
    endpoint; nothing here needs a funded Sui address."""
    if not blob:
        raise WalrusUploadError("upload_checkpoint received empty bytes")

    url = f"{_publisher_url()}/v1/blobs?epochs={epochs}"
    try:
        resp = httpx.put(url, content=blob, timeout=timeout)
    except httpx.HTTPError as e:
        raise WalrusUploadError(f"Walrus publisher request failed: {e}") from e

    if resp.status_code >= 400:
        raise WalrusUploadError(
            f"Walrus publisher returned {resp.status_code}: {resp.text[:500]}"
        )

    try:
        parsed = resp.json()
    except json.JSONDecodeError as e:
        raise WalrusUploadError(
            f"Walrus publisher returned non-JSON: {resp.text[:500]!r}"
        ) from e

    # Two success shapes per the HTTP API: a brand-new registration, or a
    # pointer to an already-certified blob with identical content (Walrus
    # dedupes by content hash) — see docs.wal.app "Storing Blobs".
    if "newlyCreated" in parsed:
        try:
            blob_obj = parsed["newlyCreated"]["blobObject"]
            return UploadResult(blob_id=str(blob_obj["blobId"]), sui_object_id=str(blob_obj["id"]))
        except KeyError as e:
            raise WalrusUploadError(
                f"Walrus 'newlyCreated' response missing expected key {e}: {parsed}"
            ) from e
    if "alreadyCertified" in parsed:
        try:
            return UploadResult(blob_id=str(parsed["alreadyCertified"]["blobId"]), sui_object_id=None)
        except KeyError as e:
            raise WalrusUploadError(
                f"Walrus 'alreadyCertified' response missing expected key {e}: {parsed}"
            ) from e
    raise WalrusUploadError(
        f"Walrus publisher response has neither 'newlyCreated' nor 'alreadyCertified': {parsed}"
    )


def fetch_blob(blob_id: str, *, timeout: float = 60.0) -> bytes:
    """Fetch a blob's raw bytes from Walrus via the aggregator's HTTP API."""
    if not blob_id:
        raise WalrusUploadError("fetch_blob received an empty blob_id")

    url = f"{_aggregator_url()}/v1/blobs/{blob_id}"
    try:
        resp = httpx.get(url, timeout=timeout)
    except httpx.HTTPError as e:
        raise WalrusUploadError(f"Walrus aggregator request failed: {e}") from e
    if resp.status_code >= 400:
        raise WalrusUploadError(
            f"Walrus aggregator returned {resp.status_code} for blob {blob_id}"
        )
    return resp.content
