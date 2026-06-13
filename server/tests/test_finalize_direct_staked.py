"""
Tests for POST /finalize-direct-staked.

Hermetic: mocks ChainClient and put_blob.
Verify that the endpoint functions correctly both when keeper_settle is
True (returning None for match_id and tx_hash) and when it is False (returning
the values from recordMatchAndSplit).

Run with:  cd server && uv run pytest tests/test_finalize_direct_staked.py -v
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import main as main_module  # noqa: E402
from app.main import app  # noqa: E402


@dataclass
class _RecordMatchResult:
    match_id: int
    tx_hash: str


class _MockChainClient:
    def __init__(self):
        self.record_match_and_split_calls = []

    def record_match_and_split(self, **kwargs):
        self.record_match_and_split_calls.append(kwargs)
        return _RecordMatchResult(match_id=45, tx_hash="0x" + "77" * 32)

    def agent_owner(self, agent_id: int) -> str:
        return "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

    def agent_elo(self, agent_id: int) -> int:
        return 1500

    def human_elo(self, human_address: str) -> int:
        return 1500


@dataclass
class _UploadResult:
    root_hash: str = "0x" + "fe" * 32


def _fake_put_blob(payload: bytes) -> _UploadResult:
    return _UploadResult()


def test_finalize_direct_staked_keeper_settle_true(monkeypatch):
    """
    When keeper_settle is True, it should skip the on-chain call and
    successfully return the response containing keeper_settle=True
    with None/null for tx_hash and match_id, without triggering a Pydantic
    validation error.
    """
    fake_chain = _MockChainClient()
    from app import chain_client as chain_client_module
    monkeypatch.setattr(
        chain_client_module.ChainClient, "from_env", classmethod(lambda cls: fake_chain)
    )
    monkeypatch.setattr(main_module, "put_blob", _fake_put_blob)

    client = TestClient(app)
    payload = {
        "winner_agent_id": 1,
        "winner_human_address": "0x0000000000000000000000000000000000000000",
        "loser_agent_id": 0,
        "loser_human_address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "winner_label": "agent-one",
        "loser_label": "player-one",
        "match_length": 3,
        "position_id": "position123",
        "gnubg_match_id": "match123",
        "score": [3, 0],
        "escrow_match_id": "0x" + "aa" * 32,
        "stake_wei": "100000000000000000",  # 0.1 ETH/USDC in wei
        "keeper_settle": True,
    }

    r = client.post("/finalize-direct-staked", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["keeper_settle"] is True
    assert body["tx_hash"] is None
    assert body["match_id"] is None
    assert body["escrow_match_id"] == "0x" + "aa" * 32
    assert body["root_hash"] == "0x" + "fe" * 32
    assert len(fake_chain.record_match_and_split_calls) == 0


def test_finalize_direct_staked_keeper_settle_false(monkeypatch):
    """
    When keeper_settle is False, it should execute the on-chain call
    using recordMatchAndSplit and return the tx_hash and match_id.
    """
    fake_chain = _MockChainClient()
    from app import chain_client as chain_client_module
    monkeypatch.setattr(
        chain_client_module.ChainClient, "from_env", classmethod(lambda cls: fake_chain)
    )
    monkeypatch.setattr(main_module, "put_blob", _fake_put_blob)

    client = TestClient(app)
    payload = {
        "winner_agent_id": 1,
        "winner_human_address": "0x0000000000000000000000000000000000000000",
        "loser_agent_id": 0,
        "loser_human_address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "winner_label": "agent-one",
        "loser_label": "player-one",
        "match_length": 3,
        "position_id": "position123",
        "gnubg_match_id": "match123",
        "score": [3, 0],
        "escrow_match_id": "0x" + "aa" * 32,
        "stake_wei": "100000000000000000",  # 0.1 ETH/USDC in wei
        "keeper_settle": False,
    }

    r = client.post("/finalize-direct-staked", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("keeper_settle") is not True
    assert body["tx_hash"] == "0x" + "77" * 32
    assert body["match_id"] == 45
    assert body["root_hash"] == "0x" + "fe" * 32
    assert len(fake_chain.record_match_and_split_calls) == 1
