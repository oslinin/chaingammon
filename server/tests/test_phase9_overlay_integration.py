"""
Phase 9 integration tests — overlay persistence via 0G KV.

Includes:
  - Localhost mock tests (always run): verify that _persist_overlay_kv and
    _fetch_overlay use KV correctly and that a subsequent _fetch_overlay call
    reads back the overlay written by finalize.
  - Live network tests (skipped unless env vars are set): the old blob-based
    overlay path is preserved here for reference but the KV path is the
    canonical one going forward.

Skipped automatically when the live-network env vars or the deployed
AgentRegistry address aren't set (for the live tests only).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

_SERVER_ENV = Path(__file__).resolve().parents[1] / ".env"
if _SERVER_ENV.exists():
    load_dotenv(_SERVER_ENV)

from app.agent_overlay import (  # noqa: E402
    Overlay,
    update_overlay,
)
from app.chain_client import ChainClient  # noqa: E402
from app.game_record import MoveEntry  # noqa: E402
from app.og_storage_client import OgStorageError, get_blob, get_kv, put_blob, put_kv  # noqa: E402


_REQUIRED = (
    "OG_STORAGE_PRIVATE_KEY",
    "OG_STORAGE_INDEXER",
    "RPC_URL",
    "AGENT_REGISTRY_ADDRESS",
    "MATCH_REGISTRY_ADDRESS",
    "DEPLOYER_PRIVATE_KEY",
)

_live_skip = pytest.mark.skipif(
    any(not os.environ.get(k) for k in _REQUIRED),
    reason=f"missing one of {_REQUIRED}; skipping live Phase 9 test",
)

SEED_AGENT_ID = 1


# ---------------------------------------------------------------------------
# Localhost KV integration tests — always run (no live network required)
# ---------------------------------------------------------------------------


@pytest.fixture()
def kv_localhost_clean(monkeypatch):
    """Run each KV test in localhost mode with a clean mock file."""
    monkeypatch.setenv("OG_STORAGE_MODE", "localhost")
    mock_path = Path("/tmp/chaingammon-kv-mock.json")
    mock_path.unlink(missing_ok=True)
    yield
    mock_path.unlink(missing_ok=True)


def test_finalize_writes_overlay_to_kv_and_fetch_overlay_reads_it_back(
    kv_localhost_clean,
):
    """_persist_overlay_kv writes to KV; a subsequent get_kv call reads it back."""
    # Import here so we pick up the monkeypatched env.
    from app.main import _persist_overlay_kv, _fetch_overlay

    agent_id = 99
    moves = [
        MoveEntry(turn=0, dice=[3, 1], move="8/5 6/5"),
        MoveEntry(turn=0, dice=[6, 2], move="13/7 13/11"),
    ]
    result = _persist_overlay_kv(agent_id, moves, won=True)
    assert "error" not in result, f"persist_overlay_kv failed: {result}"
    assert result["agent_id"] == agent_id
    assert result["match_count"] == 1

    # get_kv should return the updated overlay.
    kv_key = f"chaingammon/overlay/agent/{agent_id}"
    raw = get_kv(kv_key)
    fetched = Overlay.from_bytes(raw)
    assert fetched.match_count == 1
    assert fetched.values["build_5_point"] > 0.0  # "8/5 6/5" → build_5_point signal


def test_fetch_overlay_returns_default_for_cold_start_agent(kv_localhost_clean):
    """_fetch_overlay returns Overlay.default() when no KV key exists."""
    from app.main import _fetch_overlay

    # agent 888 has never played — key absent in fresh mock.
    overlay = _fetch_overlay(888)
    assert overlay == Overlay.default()
    assert overlay.match_count == 0


def test_two_consecutive_persist_overlay_kv_accumulate_match_count(
    kv_localhost_clean,
):
    """Each call to _persist_overlay_kv increments match_count by 1."""
    from app.main import _persist_overlay_kv

    agent_id = 77
    moves = [MoveEntry(turn=0, dice=[3, 1], move="8/5 6/5")]

    r1 = _persist_overlay_kv(agent_id, moves, won=True)
    r2 = _persist_overlay_kv(agent_id, moves, won=False)
    assert r1["match_count"] == 1
    assert r2["match_count"] == 2

    # KV stores the latest overlay.
    kv_key = f"chaingammon/overlay/agent/{agent_id}"
    final = Overlay.from_bytes(get_kv(kv_key))
    assert final.match_count == 2


# ---------------------------------------------------------------------------
# Live network tests — skipped unless live env vars are set
# ---------------------------------------------------------------------------


@_live_skip
def test_overlay_update_lands_on_chain_and_round_trips_through_0g_storage():
    chain = ChainClient.from_env()

    # Snapshot pre-update on-chain state.
    pre_hashes = chain.agent_data_hashes(SEED_AGENT_ID)
    pre_version = chain.agent_experience_version(SEED_AGENT_ID)

    # Read existing overlay (or default if iNFT still has bytes32(0)).
    pre_overlay_hash = pre_hashes[1]
    if pre_overlay_hash == "0x" + "00" * 32:
        current = Overlay.default()
    else:
        current = Overlay.from_bytes(get_blob(pre_overlay_hash))

    # Synthetic finished match — three "build the 5-point" moves, agent won.
    moves = [
        MoveEntry(turn=1, dice=[3, 1], move="8/5 6/5"),
        MoveEntry(turn=1, dice=[6, 1], move="13/7 8/7"),
        MoveEntry(turn=1, dice=[5, 2], move="13/8 13/11"),
    ]
    new_overlay = update_overlay(
        current,
        agent_moves=moves,
        won=True,
        match_count=current.match_count,
    )

    # Upload + pin on-chain.
    upload = put_blob(new_overlay.to_bytes())
    assert upload.root_hash.startswith("0x")
    chain.update_overlay_hash(SEED_AGENT_ID, upload.root_hash)

    # Verify on-chain state.
    post_hashes = chain.agent_data_hashes(SEED_AGENT_ID)
    assert post_hashes[1].lower() == upload.root_hash.lower(), (
        "iNFT.dataHashes[1] should equal the just-uploaded overlay rootHash"
    )
    assert post_hashes[0] == pre_hashes[0], (
        "baseWeightsHash (dataHashes[0]) must NOT change when overlay updates"
    )

    post_version = chain.agent_experience_version(SEED_AGENT_ID)
    assert post_version == pre_version + 1, (
        f"experienceVersion should bump by exactly 1 (was {pre_version}, now {post_version})"
    )

    # Round-trip: download the blob and confirm it's the same overlay.
    fetched = Overlay.from_bytes(get_blob(upload.root_hash))
    assert fetched == new_overlay
    # The downloaded match_count should reflect the +1 from this update.
    assert fetched.match_count == current.match_count + 1


@_live_skip
def test_two_consecutive_updates_produce_distinct_overlay_hashes():
    """Each match generates a different blob (different match_count, possibly
    different values), so the on-chain hash should change every time. This
    is what makes the iNFT's history visible — every match is a distinct
    `experienceVersion` with its own immutable archive."""
    chain = ChainClient.from_env()
    pre_hashes_0 = chain.agent_data_hashes(SEED_AGENT_ID)

    # First update.
    pre_overlay_hash = pre_hashes_0[1]
    current = (
        Overlay.default()
        if pre_overlay_hash == "0x" + "00" * 32
        else Overlay.from_bytes(get_blob(pre_overlay_hash))
    )
    overlay_1 = update_overlay(
        current,
        agent_moves=[MoveEntry(turn=1, dice=[3, 1], move="8/5 6/5")],
        won=True,
        match_count=current.match_count,
    )
    upload_1 = put_blob(overlay_1.to_bytes())
    chain.update_overlay_hash(SEED_AGENT_ID, upload_1.root_hash)

    # Second update — different moves, different match_count, different blob.
    overlay_2 = update_overlay(
        overlay_1,
        agent_moves=[MoveEntry(turn=1, dice=[5, 2], move="24/22 24/19")],
        won=False,
        match_count=overlay_1.match_count,
    )
    upload_2 = put_blob(overlay_2.to_bytes())
    chain.update_overlay_hash(SEED_AGENT_ID, upload_2.root_hash)

    assert upload_1.root_hash != upload_2.root_hash, "two distinct updates must produce distinct hashes"

    final_hashes = chain.agent_data_hashes(SEED_AGENT_ID)
    assert final_hashes[1].lower() == upload_2.root_hash.lower()
