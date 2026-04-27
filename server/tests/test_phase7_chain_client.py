"""
Phase 7 unit tests for the ChainClient web3 wrapper.

These are fast, no-network tests. The ChainClient builds a tx, signs it,
sends it, waits for the receipt, and parses MatchRecorded out of the
logs — every step is mocked so the test is deterministic and runs in
milliseconds. The live testnet round-trip lives in
`test_phase7_game_record.py`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# Make `app` importable when running pytest from server/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from app.chain_client import (  # noqa: E402
    ChainClient,
    ChainError,
    FinalizedMatch,
)


# Hardhat's well-known test accounts — convenient for mocked-but-realistic
# values. No keys live on a real chain matter here.
TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
TEST_REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

GAME_RECORD_HASH = "0x" + "ab" * 32
TX_HASH_BYTES = bytes.fromhex("11" * 32)
EXPECTED_TX_HASH = "0x" + "11" * 32
EXPECTED_MATCH_ID = 7


def _make_client(*, status: int = 1, with_event: bool = True) -> ChainClient:
    """Construct a ChainClient with every web3 dependency mocked.

    Bypasses `__init__` (which would otherwise require a live RPC) and
    wires up just the attributes `record_match` reads.
    """
    client = ChainClient.__new__(ChainClient)

    # ----- account -----
    account = MagicMock()
    account.address = TEST_ADDRESS
    signed = MagicMock()
    signed.raw_transaction = b"raw-tx-bytes"
    account.sign_transaction.return_value = signed
    client.account = account

    # ----- contract function chain: contract.functions.recordMatch(...).build_transaction(...) -----
    record_match_call = MagicMock()
    record_match_call.build_transaction.return_value = {"to": TEST_REGISTRY, "from": TEST_ADDRESS}
    contract_functions = MagicMock()
    contract_functions.recordMatch.return_value = record_match_call

    # ----- event processing on the receipt -----
    contract_events = MagicMock()
    if with_event:
        contract_events.MatchRecorded.return_value.process_receipt.return_value = [
            {"args": {"matchId": EXPECTED_MATCH_ID}}
        ]
    else:
        contract_events.MatchRecorded.return_value.process_receipt.return_value = []

    contract = MagicMock()
    contract.functions = contract_functions
    contract.events = contract_events
    client.match_registry = contract

    # ----- web3 -----
    w3 = MagicMock()
    w3.eth.get_transaction_count.return_value = 42
    w3.eth.chain_id = 16602
    w3.eth.send_raw_transaction.return_value = MagicMock(hex=lambda: EXPECTED_TX_HASH[2:])
    receipt = MagicMock()
    receipt.status = status
    w3.eth.wait_for_transaction_receipt.return_value = receipt
    w3.to_bytes = lambda hexstr: bytes.fromhex(hexstr[2:])
    client.w3 = w3

    return client


# --- input validation --------------------------------------------------------


def test_record_match_rejects_unprefixed_hash():
    client = _make_client()
    with pytest.raises(ChainError, match="must start with 0x"):
        client.record_match(
            winner_agent_id=0,
            winner_human=TEST_ADDRESS,
            loser_agent_id=1,
            loser_human="0x0000000000000000000000000000000000000000",
            match_length=1,
            game_record_hash="ab" * 32,  # no 0x
        )


# --- happy path --------------------------------------------------------------


def test_record_match_returns_match_id_and_prefixed_tx_hash():
    client = _make_client()
    result = client.record_match(
        winner_agent_id=0,
        winner_human=TEST_ADDRESS,
        loser_agent_id=1,
        loser_human="0x0000000000000000000000000000000000000000",
        match_length=1,
        game_record_hash=GAME_RECORD_HASH,
    )
    assert isinstance(result, FinalizedMatch)
    assert result.match_id == EXPECTED_MATCH_ID
    assert result.tx_hash == EXPECTED_TX_HASH
    assert result.tx_hash.startswith("0x")


def test_record_match_passes_args_to_contract():
    client = _make_client()
    client.record_match(
        winner_agent_id=0,
        winner_human=TEST_ADDRESS,
        loser_agent_id=1,
        loser_human="0x0000000000000000000000000000000000000000",
        match_length=3,
        game_record_hash=GAME_RECORD_HASH,
    )
    # The contract's recordMatch should have been called once with our six args.
    record_match_fn = client.match_registry.functions.recordMatch
    record_match_fn.assert_called_once()
    args = record_match_fn.call_args.args
    assert args[0] == 0  # winner_agent_id
    assert args[1] == TEST_ADDRESS  # winner_human (checksummed)
    assert args[2] == 1  # loser_agent_id
    assert args[3] == "0x0000000000000000000000000000000000000000"  # loser_human (zero)
    assert args[4] == 3  # match_length
    assert args[5] == bytes.fromhex(GAME_RECORD_HASH[2:])  # hash as bytes32


def test_record_match_uses_correct_chain_id_and_nonce_in_built_tx():
    client = _make_client()
    client.record_match(
        winner_agent_id=0,
        winner_human=TEST_ADDRESS,
        loser_agent_id=1,
        loser_human="0x0000000000000000000000000000000000000000",
        match_length=1,
        game_record_hash=GAME_RECORD_HASH,
    )
    build_tx = client.match_registry.functions.recordMatch.return_value.build_transaction
    tx_params = build_tx.call_args.args[0]
    assert tx_params["from"] == TEST_ADDRESS
    assert tx_params["nonce"] == 42
    assert tx_params["chainId"] == 16602


# --- error paths -------------------------------------------------------------


def test_record_match_raises_when_receipt_reverts():
    client = _make_client(status=0)
    with pytest.raises(ChainError, match="reverted"):
        client.record_match(
            winner_agent_id=0,
            winner_human=TEST_ADDRESS,
            loser_agent_id=1,
            loser_human="0x0000000000000000000000000000000000000000",
            match_length=1,
            game_record_hash=GAME_RECORD_HASH,
        )


def test_record_match_raises_when_event_missing():
    client = _make_client(with_event=False)
    with pytest.raises(ChainError, match="MatchRecorded event missing"):
        client.record_match(
            winner_agent_id=0,
            winner_human=TEST_ADDRESS,
            loser_agent_id=1,
            loser_human="0x0000000000000000000000000000000000000000",
            match_length=1,
            game_record_hash=GAME_RECORD_HASH,
        )


# --- from_env construction (constructor doesn't run web3) --------------------


def test_from_env_raises_when_required_var_missing(monkeypatch):
    for k in ("RPC_URL", "MATCH_REGISTRY_ADDRESS", "DEPLOYER_PRIVATE_KEY"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(ChainError, match="Missing env var"):
        ChainClient.from_env()


def test_from_env_constructs_when_all_vars_present(monkeypatch):
    """Patch Web3 so the constructor doesn't actually open a network connection."""
    monkeypatch.setenv("RPC_URL", "http://nowhere.example")
    monkeypatch.setenv("MATCH_REGISTRY_ADDRESS", TEST_REGISTRY)
    monkeypatch.setenv("DEPLOYER_PRIVATE_KEY", TEST_KEY)

    with patch("app.chain_client.Web3") as web3_cls:
        instance = MagicMock()
        instance.is_connected.return_value = True
        instance.eth.account.from_key.return_value = MagicMock(address=TEST_ADDRESS)
        web3_cls.return_value = instance
        web3_cls.HTTPProvider = MagicMock()
        web3_cls.to_checksum_address = lambda x: x

        client = ChainClient.from_env()
        assert isinstance(client, ChainClient)
        web3_cls.HTTPProvider.assert_called_once_with("http://nowhere.example")


def test_from_env_raises_when_rpc_unreachable(monkeypatch):
    monkeypatch.setenv("RPC_URL", "http://nowhere.example")
    monkeypatch.setenv("MATCH_REGISTRY_ADDRESS", TEST_REGISTRY)
    monkeypatch.setenv("DEPLOYER_PRIVATE_KEY", TEST_KEY)

    with patch("app.chain_client.Web3") as web3_cls:
        instance = MagicMock()
        instance.is_connected.return_value = False
        web3_cls.return_value = instance
        web3_cls.HTTPProvider = MagicMock()
        web3_cls.to_checksum_address = lambda x: x

        with pytest.raises(ChainError, match="cannot connect"):
            ChainClient.from_env()
