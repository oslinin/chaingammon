"""
Phase 7 integration test — wire game-end → 0G Storage upload → on-chain
`recordMatch` so each match's full game record is cryptographically tied
to the on-chain match metadata.

This is a live-network test (0G testnet); skipped automatically when the
required env vars aren't set.
"""

from __future__ import annotations

import os
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

# Make `app` importable when running pytest from server/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from dotenv import load_dotenv

_SERVER_ENV = Path(__file__).resolve().parents[1] / ".env"
if _SERVER_ENV.exists():
    load_dotenv(_SERVER_ENV)

from app.chain_client import ChainClient  # noqa: E402
from app.game_record import (  # noqa: E402
    GameRecord,
    PlayerRef,
    serialize_record,
)
from app.og_storage_client import get_blob, put_blob  # noqa: E402

_REQUIRED = (
    "OG_STORAGE_PRIVATE_KEY",
    "OG_STORAGE_RPC",
    "OG_STORAGE_INDEXER",
    "RPC_URL",
    "MATCH_REGISTRY_ADDRESS",
    "DEPLOYER_PRIVATE_KEY",
)

pytestmark = pytest.mark.skipif(
    any(not os.environ.get(k) for k in _REQUIRED),
    reason=f"missing one of {_REQUIRED}; skipping live Phase 7 test",
)


def _synthetic_record(human: str) -> GameRecord:
    """A minimally-realistic finished match — 1-pointer, human beats agent #1."""
    return GameRecord(
        envelope_version=1,
        match_length=1,
        final_score=[1, 0],
        winner=PlayerRef(kind="human", address=human, agent_id=None),
        loser=PlayerRef(kind="agent", address=None, agent_id=1),
        final_position_id="4HPwATDgc/ABMA",
        final_match_id="cAkAAAAAAAAA",
        moves=[
            {"turn": 0, "dice": [3, 1], "move": "8/5 6/5"},
            {"turn": 1, "dice": [4, 2], "move": "24/22 13/9"},
        ],
        cube_actions=[],
        started_at=datetime.now(timezone.utc).isoformat(),
        ended_at=datetime.now(timezone.utc).isoformat(),
        # ad-hoc tag so we can confirm the blob we get back is the one we sent
        notes=f"phase7-test-{secrets.token_hex(4)}",
    )


def test_finalize_match_round_trip():
    """
    1. Build a synthetic finished GameRecord.
    2. Serialize to JSON bytes.
    3. Upload to 0G Storage → root_hash.
    4. Call MatchRegistry.recordMatch with that root_hash via web3.py.
    5. Read the match back on-chain and assert .gameRecordHash == root_hash.
    6. Re-download from 0G Storage and assert byte-exact equality.
    """
    chain = ChainClient.from_env()
    human = chain.account_address  # use the deployer wallet as the "human"
    record = _synthetic_record(human=human)
    payload = serialize_record(record)

    upload = put_blob(payload)
    assert upload.root_hash.startswith("0x")

    finalized = chain.record_match(
        winner_agent_id=0,
        winner_human=human,
        loser_agent_id=record.loser.agent_id,
        loser_human="0x0000000000000000000000000000000000000000",
        match_length=record.match_length,
        game_record_hash=upload.root_hash,
    )
    assert finalized.match_id >= 0
    assert finalized.tx_hash.startswith("0x")

    on_chain = chain.get_match(finalized.match_id)
    assert on_chain["gameRecordHash"].lower() == upload.root_hash.lower(), (
        "on-chain gameRecordHash should match the 0G Storage rootHash we just uploaded"
    )

    fetched = get_blob(upload.root_hash)
    assert fetched == payload, "downloaded blob must equal the bytes we uploaded"
