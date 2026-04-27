"""
Phase 6 integration test — round-trip a blob through 0G Storage testnet.

This is a real-network test: it spends a tiny amount of testnet 0G to
publish bytes via the og-bridge Node helper. Skipped automatically when
OG_STORAGE_PRIVATE_KEY is not set in the env.
"""

from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

# Make `app` importable when running pytest from server/ — matches the
# pattern used by other phase tests in this directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from dotenv import load_dotenv

# Load server/.env so OG_STORAGE_* picks up automatically when running pytest.
_SERVER_ENV = Path(__file__).resolve().parents[1] / ".env"
if _SERVER_ENV.exists():
    load_dotenv(_SERVER_ENV)

from app.og_storage_client import get_blob, put_blob  # noqa: E402

pytestmark = pytest.mark.skipif(
    not os.environ.get("OG_STORAGE_PRIVATE_KEY"),
    reason="OG_STORAGE_PRIVATE_KEY not set; skipping live 0G Storage test",
)


def test_round_trip_small_blob():
    # 64 random bytes prefixed with a magic header so we can sanity-check
    # that what we got back is what we sent (no bytes-from-someone-else).
    blob = b"chaingammon-phase6:" + secrets.token_bytes(64)
    result = put_blob(blob)

    assert result.root_hash.startswith("0x"), f"unexpected rootHash: {result.root_hash!r}"
    assert result.tx_hash.startswith("0x"), f"unexpected txHash: {result.tx_hash!r}"
    assert len(result.root_hash) == 66, f"rootHash should be 32 bytes hex: {result.root_hash!r}"

    fetched = get_blob(result.root_hash)
    assert fetched == blob, "downloaded bytes did not match what we uploaded"
