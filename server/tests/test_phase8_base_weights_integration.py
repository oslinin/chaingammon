"""
Phase 8 live integration test — confirm the chain of custody from a
freshly-minted agent's `dataHashes[0]` back to the encrypted blob on
0G Storage and out to a byte-exact match with /usr/lib/gnubg/gnubg.wd.

This is the proof that the iNFT's claim "this agent runs on real gnubg
weights" is verifiable, not vibes.

Skipped when the relevant env vars or the source weights file aren't
present.
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

from app.chain_client import ChainClient  # noqa: E402
from app.og_storage_client import get_blob  # noqa: E402
from app.weights import (  # noqa: E402
    EncryptedWeights,
    decrypt_weights,
    load_key_from_env,
)


WEIGHTS_PATH = Path("/usr/lib/gnubg/gnubg.wd")

_REQUIRED = (
    "OG_STORAGE_PRIVATE_KEY",
    "OG_STORAGE_INDEXER",
    "RPC_URL",
    "AGENT_REGISTRY_ADDRESS",
    "MATCH_REGISTRY_ADDRESS",
    "DEPLOYER_PRIVATE_KEY",
    "BASE_WEIGHTS_ENCRYPTION_KEY",
)

pytestmark = [
    pytest.mark.skipif(
        any(not os.environ.get(k) for k in _REQUIRED),
        reason=f"missing one of {_REQUIRED}; skipping live Phase 8 test",
    ),
    pytest.mark.skipif(
        not WEIGHTS_PATH.is_file(),
        reason=f"{WEIGHTS_PATH} not present; skipping",
    ),
]


def test_base_weights_hash_resolves_to_real_gnubg_weights():
    """The agent iNFT promise: dataHashes[0] points at gnubg's actual
    weights file, encrypted but recoverable with the project key."""
    chain = ChainClient.from_env()

    # 1. Read the contract's claimed base hash.
    on_chain_hash = chain.base_weights_hash()
    assert on_chain_hash != "0x" + "00" * 32, (
        "AgentRegistry.baseWeightsHash() is still the bytes32(0) placeholder; "
        "run scripts/upload_base_weights.py to pin the real hash"
    )

    # 2. Pull the encrypted blob from 0G Storage by that hash.
    blob = get_blob(on_chain_hash)
    envelope = EncryptedWeights.from_bytes(blob)

    # 3. Decrypt with the project's AES key.
    plaintext = decrypt_weights(envelope, load_key_from_env())

    # 4. Compare byte-for-byte with the on-disk gnubg weights.
    expected = WEIGHTS_PATH.read_bytes()
    assert plaintext == expected, (
        "decrypted blob does not match the local gnubg weights file — "
        "either the wrong file was uploaded, the encryption key changed, "
        "or the gnubg package on this machine differs from the one the "
        "blob was encrypted from"
    )


def test_minted_agent_inherits_the_same_base_hash():
    """Phase 5's design: every agent's dataHashes[0] should resolve to the
    SAME shared blob. The seed agent (id=1) was minted before Phase 8's
    setBaseWeightsHash call, so its on-the-fly read should reflect the
    current contract-level hash (not bytes32(0))."""
    chain = ChainClient.from_env()
    on_chain_hash = chain.base_weights_hash().lower()
    agent_hashes = chain.agent_data_hashes(1)
    assert agent_hashes[0].lower() == on_chain_hash, (
        f"agent #1 dataHashes[0] ({agent_hashes[0]}) should equal "
        f"contract baseWeightsHash ({on_chain_hash})"
    )
