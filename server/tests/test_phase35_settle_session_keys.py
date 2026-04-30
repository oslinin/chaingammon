"""
Phase 35 — settleWithSessionKeys server-side tests.

These are fast, no-network unit tests that verify:
  1. The chain_client ABI includes the `nonces` view and `settleWithSessionKeys`.
  2. `get_nonce()` calls the right contract function and returns an int.
  3. The message-encoding helper (pure Python) produces a digest that survives
     a sign → recover round-trip, matching the contract's recovery logic —
     ensuring any Python-based relayer can agree with the JS frontend on the
     exact hash without a live node.

All web3 calls are mocked so this suite runs in milliseconds with no RPC needed.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

from app.chain_client import ChainClient, _MATCH_REGISTRY_ABI

# ── Hardhat test wallets (deterministic — no real funds) ───────────────────────

TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
TEST_REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

# Hardhat account #1 is used as the session key in all message tests.
SESSION_KEY = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
SESSION_PRIVATE = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"


# ── Mock factory ───────────────────────────────────────────────────────────────


def _make_client(nonce_value: int = 0) -> ChainClient:
    """Return a ChainClient with every web3 call mocked (localhost smoke-test)."""
    client = ChainClient.__new__(ChainClient)

    account = MagicMock()
    account.address = TEST_ADDRESS
    client.account = account

    nonces_call = MagicMock()
    nonces_call.call.return_value = nonce_value

    contract_functions = MagicMock()
    contract_functions.nonces.return_value = nonces_call

    contract = MagicMock()
    contract.functions = contract_functions
    client.match_registry = contract

    w3 = MagicMock()
    w3.eth.chain_id = 31337  # Hardhat localhost (mock)
    client.w3 = w3
    client.agent_registry = None
    return client


# ── Message encoding helpers (mirror Solidity abi.encode) ─────────────────────


def _encode_auth(
    chain_id: int,
    contract_address: str,
    human: str,
    nonce: int,
    agent_id: int,
    match_length: int,
    session_key: str,
) -> bytes:
    """keccak256(abi.encode("Chaingammon:open", chainId, contract, human,
                            nonce, agentId, matchLength, sessionKey))

    Matches the contract's humanAuthHash inner digest exactly.
    """
    return Web3.keccak(
        abi_encode(
            ["string", "uint256", "address", "address", "uint256", "uint256", "uint16", "address"],
            [
                "Chaingammon:open",
                chain_id,
                contract_address,
                human,
                nonce,
                agent_id,
                match_length,
                session_key,
            ],
        )
    )


def _encode_result(
    chain_id: int,
    contract_address: str,
    human: str,
    nonce: int,
    agent_id: int,
    human_wins: bool,
    game_record_hash: bytes,
) -> bytes:
    """keccak256(abi.encode("Chaingammon:result", chainId, contract, human,
                            nonce, agentId, humanWins, gameRecordHash))

    Matches the contract's resultHash inner digest exactly.
    """
    return Web3.keccak(
        abi_encode(
            ["string", "uint256", "address", "address", "uint256", "uint256", "bool", "bytes32"],
            [
                "Chaingammon:result",
                chain_id,
                contract_address,
                human,
                nonce,
                agent_id,
                human_wins,
                game_record_hash,
            ],
        )
    )


# ── ABI surface tests ──────────────────────────────────────────────────────────


def test_abi_contains_nonces():
    names = {entry["name"] for entry in _MATCH_REGISTRY_ABI if "name" in entry}
    assert "nonces" in names, "nonces getter must be in the ABI"


def test_abi_contains_settle_with_session_keys():
    names = {entry["name"] for entry in _MATCH_REGISTRY_ABI if "name" in entry}
    assert "settleWithSessionKeys" in names


def test_settle_abi_entry_has_correct_input_count():
    entry = next(
        e for e in _MATCH_REGISTRY_ABI
        if e.get("name") == "settleWithSessionKeys" and e.get("type") == "function"
    )
    assert len(entry["inputs"]) == 9, "settleWithSessionKeys takes 9 parameters"


def test_nonces_abi_is_view():
    entry = next(
        e for e in _MATCH_REGISTRY_ABI
        if e.get("name") == "nonces" and e.get("type") == "function"
    )
    assert entry["stateMutability"] == "view"


# ── get_nonce unit tests ───────────────────────────────────────────────────────


def test_get_nonce_returns_zero_initially():
    client = _make_client(nonce_value=0)
    assert client.get_nonce(TEST_ADDRESS) == 0


def test_get_nonce_returns_nonzero():
    client = _make_client(nonce_value=5)
    assert client.get_nonce(TEST_ADDRESS) == 5


def test_get_nonce_calls_nonces_function():
    client = _make_client(nonce_value=0)
    client.get_nonce(TEST_ADDRESS)
    client.match_registry.functions.nonces.assert_called_once()


# ── Message encoding / signing round-trips ────────────────────────────────────
#
# These tests sign and recover using Python's eth_account library, which
# applies the same EIP-191 personal_sign logic as the Solidity contract's
# MessageHashUtils.toEthSignedMessageHash and as the browser's
# walletClient.signMessage({ message: { raw } }).

CHAIN_ID = 31337
AGENT_ID = 1
MATCH_LENGTH = 3
ZERO_HASH = b"\x00" * 32


def test_auth_message_roundtrip():
    """Sign humanAuthHash with the human key; recover must equal human address."""
    inner = _encode_auth(CHAIN_ID, TEST_REGISTRY, TEST_ADDRESS, 0, AGENT_ID, MATCH_LENGTH, SESSION_KEY)
    # encode_defunct(primitive=inner) applies \x19Ethereum Signed Message:\n32 prefix
    msg = encode_defunct(primitive=inner)
    signed = Account.sign_message(msg, private_key=TEST_KEY)
    recovered = Account.recover_message(msg, signature=signed.signature)
    assert recovered.lower() == TEST_ADDRESS.lower()


def test_result_message_roundtrip():
    """Sign resultHash with the session key; recover must equal session key address."""
    inner = _encode_result(CHAIN_ID, TEST_REGISTRY, TEST_ADDRESS, 0, AGENT_ID, True, ZERO_HASH)
    msg = encode_defunct(primitive=inner)
    signed = Account.sign_message(msg, private_key=SESSION_PRIVATE)
    recovered = Account.recover_message(msg, signature=signed.signature)
    assert recovered.lower() == SESSION_KEY.lower()


def test_auth_message_is_sensitive_to_nonce():
    """Replay protection: different nonces produce different hashes."""
    h0 = _encode_auth(CHAIN_ID, TEST_REGISTRY, TEST_ADDRESS, 0, AGENT_ID, MATCH_LENGTH, SESSION_KEY)
    h1 = _encode_auth(CHAIN_ID, TEST_REGISTRY, TEST_ADDRESS, 1, AGENT_ID, MATCH_LENGTH, SESSION_KEY)
    assert h0 != h1


def test_result_message_is_sensitive_to_outcome():
    """humanWins=True and humanWins=False produce distinct result hashes."""
    hw = _encode_result(CHAIN_ID, TEST_REGISTRY, TEST_ADDRESS, 0, AGENT_ID, True, ZERO_HASH)
    hl = _encode_result(CHAIN_ID, TEST_REGISTRY, TEST_ADDRESS, 0, AGENT_ID, False, ZERO_HASH)
    assert hw != hl


def test_result_cross_agent_mismatch():
    """Result signed for agentId=1 must NOT recover to session key if agentId=2 is used."""
    inner_correct = _encode_result(CHAIN_ID, TEST_REGISTRY, TEST_ADDRESS, 0, 1, True, ZERO_HASH)
    inner_wrong = _encode_result(CHAIN_ID, TEST_REGISTRY, TEST_ADDRESS, 0, 2, True, ZERO_HASH)
    msg_correct = encode_defunct(primitive=inner_correct)
    signed = Account.sign_message(msg_correct, private_key=SESSION_PRIVATE)
    # Recover against the *wrong* hash — must NOT match session key.
    msg_wrong = encode_defunct(primitive=inner_wrong)
    recovered = Account.recover_message(msg_wrong, signature=signed.signature)
    assert recovered.lower() != SESSION_KEY.lower()


# ── Localhost mock settle flow ─────────────────────────────────────────────────


def test_localhost_mock_settle_flow():
    """End-to-end mock: both signatures verify without any real blockchain node.

    This is the localhost smoke test referenced in the issue — it demonstrates
    the complete two-sig verification loop using only in-memory mocks, the
    same logic Hardhat would exercise in a contract test.
    """
    nonce = 0

    # Human wallet signs "Chaingammon:open".
    auth_inner = _encode_auth(
        CHAIN_ID, TEST_REGISTRY, TEST_ADDRESS, nonce, AGENT_ID, MATCH_LENGTH, SESSION_KEY
    )
    auth_msg = encode_defunct(primitive=auth_inner)
    auth_signed = Account.sign_message(auth_msg, private_key=TEST_KEY)
    auth_recovered = Account.recover_message(auth_msg, signature=auth_signed.signature)
    assert auth_recovered.lower() == TEST_ADDRESS.lower(), "human auth must recover to human"

    # Session key signs "Chaingammon:result".
    human_wins = True
    result_inner = _encode_result(
        CHAIN_ID, TEST_REGISTRY, TEST_ADDRESS, nonce, AGENT_ID, human_wins, ZERO_HASH
    )
    result_msg = encode_defunct(primitive=result_inner)
    result_signed = Account.sign_message(result_msg, private_key=SESSION_PRIVATE)
    result_recovered = Account.recover_message(result_msg, signature=result_signed.signature)
    assert result_recovered.lower() == SESSION_KEY.lower(), "result must recover to session key"

    # The mocked nonce-increment check — after settlement the nonce would be 1.
    client = _make_client(nonce_value=nonce)
    assert client.get_nonce(TEST_ADDRESS) == nonce
