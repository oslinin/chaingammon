"""
Tests for POST /relay-settle — gasless settlement relay for Privy embedded
wallets.

Hermetic: the chain client is stubbed, so no RPC is needed. Verifies that the
endpoint forwards the browser-signed args to
`ChainClient.settle_with_session_keys` verbatim and maps a chain-level
revert (bad signature / nonce mismatch) to HTTP 400.

Run with:  cd server && uv run pytest tests/test_relay_settle.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import main as main_module  # noqa: E402
from app.chain_client import ChainError, FinalizedMatch  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

_VALID_PAYLOAD = {
    "human": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "agent_id": 1,
    "match_length": 3,
    "human_wins": True,
    "game_record_hash": "0x" + "00" * 32,
    "nonce": 0,
    "session_key": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "human_auth_sig": "0x" + "ab" * 65,
    "result_sig": "0x" + "cd" * 65,
}


class _StubChain:
    """Records the kwargs it was called with so the test can assert the
    endpoint forwarded the payload unchanged."""

    def __init__(self):
        self.called_with = None

    def settle_with_session_keys(self, **kwargs):
        self.called_with = kwargs
        return FinalizedMatch(match_id=42, tx_hash="0x" + "ef" * 32)


def test_relay_settle_happy_path(monkeypatch):
    chain = _StubChain()
    monkeypatch.setattr(main_module.ChainClient, "from_env", classmethod(lambda cls: chain))

    r = client.post("/relay-settle", json=_VALID_PAYLOAD)

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["match_id"] == 42
    assert body["tx_hash"] == "0x" + "ef" * 32
    # Payload forwarded verbatim (string nonce coerced to int).
    assert chain.called_with["human"] == _VALID_PAYLOAD["human"]
    assert chain.called_with["agent_id"] == 1
    assert chain.called_with["human_wins"] is True
    assert chain.called_with["nonce"] == 0
    assert chain.called_with["human_auth_sig"] == _VALID_PAYLOAD["human_auth_sig"]
    assert chain.called_with["result_sig"] == _VALID_PAYLOAD["result_sig"]


def test_relay_settle_chain_revert_maps_to_400(monkeypatch):
    class _Reverting:
        def settle_with_session_keys(self, **kwargs):
            raise ChainError("settleWithSessionKeys would revert: humanAuthSig not from human")

    monkeypatch.setattr(
        main_module.ChainClient, "from_env", classmethod(lambda cls: _Reverting())
    )

    r = client.post("/relay-settle", json=_VALID_PAYLOAD)

    assert r.status_code == 400
    assert "relay settlement failed" in r.json()["detail"]


def test_relay_settle_missing_field_is_422():
    payload = {k: v for k, v in _VALID_PAYLOAD.items() if k != "result_sig"}
    r = client.post("/relay-settle", json=payload)
    assert r.status_code == 422
