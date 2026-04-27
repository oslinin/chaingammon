"""
Phase 11 live integration test — confirm a real round-trip against the
deployed PlayerSubnameRegistrar on 0G testnet.

Flow:
1. Mint a fresh subname (random label so re-runs don't clash with
   `SubnameAlreadyExists`).
2. setText("elo", "1500") on the subname.
3. Read it back via `text(node, "elo")` and confirm the value.

Skipped when the relevant env vars aren't present, so CI without secrets
stays green.
"""

from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

_SERVER_ENV = Path(__file__).resolve().parents[1] / ".env"
if _SERVER_ENV.exists():
    load_dotenv(_SERVER_ENV)

from app.ens_client import EnsClient  # noqa: E402

_REQUIRED = (
    "RPC_URL",
    "PLAYER_SUBNAME_REGISTRAR_ADDRESS",
    "DEPLOYER_PRIVATE_KEY",
)

pytestmark = pytest.mark.skipif(
    any(not os.environ.get(k) for k in _REQUIRED),
    reason=f"missing one of {_REQUIRED}; skipping live Phase 11 test",
)


def test_set_text_round_trip_on_live_registrar():
    ens = EnsClient.from_env()

    # Random label so the test is idempotent across re-runs (the registrar
    # rejects duplicate mints with `SubnameAlreadyExists`).
    label = "test-" + secrets.token_hex(4)
    owner = ens.account_address

    mint_tx = ens.mint_subname(label, owner)
    assert mint_tx.startswith("0x")

    node = ens.subname_node(label)
    # Sanity: contract-side namehash must match our local computation.
    assert ens.owner_of(node).lower() == owner.lower()

    set_tx = ens.set_text(node=node, key="elo", value="1500")
    assert set_tx.startswith("0x")

    # Read it back via the contract's view function.
    assert ens.text(node, "elo") == "1500"
