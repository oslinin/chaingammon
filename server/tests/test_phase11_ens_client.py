"""
Phase 11 unit tests for the ENS subname registrar wrapper.

These mirror the **server/tests/test_phase7_chain_client.py** pattern: every
web3 dependency is mocked so the tests run in milliseconds and don't need
RPC access. The live testnet round-trip lives in
**server/tests/test_phase11_ens_live.py** (skipped without env vars).

What we cover:
- `subname_node(label)` returns the keccak256(parentNode || keccak256(label))
  computed entirely client-side (no RPC needed for label hashing).
- `set_text(node, key, value)` builds, signs, sends a tx and waits for the
  receipt; raises `ChainError` if the tx reverts.
- `text(node, key)` calls the contract's view function and returns the
  string value.
- `from_env()` raises if any required env var is missing and otherwise
  constructs without hitting a real RPC.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# Make `app` importable when running pytest from server/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from app.ens_client import EnsClient, EnsError  # noqa: E402

# Hardhat well-known account — same convention as the chain_client tests.
TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
TEST_REGISTRAR = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

# Arbitrary 32-byte parent node (would be namehash("chaingammon.eth") in prod).
TEST_PARENT = "0x" + "cc" * 32

EXPECTED_TX_HASH = "0x" + "22" * 32


def _make_client(*, status: int = 1) -> EnsClient:
    """Build an EnsClient with every web3 dependency mocked."""
    client = EnsClient.__new__(EnsClient)

    # ----- account -----
    account = MagicMock()
    account.address = TEST_ADDRESS
    signed = MagicMock()
    signed.raw_transaction = b"raw-tx-bytes"
    account.sign_transaction.return_value = signed
    client.account = account

    # ----- contract function chain -----
    set_text_call = MagicMock()
    set_text_call.build_transaction.return_value = {
        "to": TEST_REGISTRAR,
        "from": TEST_ADDRESS,
    }
    contract_functions = MagicMock()
    contract_functions.setText.return_value = set_text_call
    # `text(node, key).call()` → returned value
    contract_functions.text.return_value.call.return_value = "1500"
    contract_functions.ownerOf.return_value.call.return_value = TEST_ADDRESS

    contract = MagicMock()
    contract.functions = contract_functions
    client.registrar = contract

    # ----- web3 -----
    w3 = MagicMock()
    w3.eth.get_transaction_count.return_value = 7
    w3.eth.chain_id = 16602
    w3.eth.send_raw_transaction.return_value = MagicMock(hex=lambda: EXPECTED_TX_HASH[2:])
    receipt = MagicMock()
    receipt.status = status
    w3.eth.wait_for_transaction_receipt.return_value = receipt
    w3.to_bytes = lambda hexstr: bytes.fromhex(hexstr[2:])
    client.w3 = w3

    # parent_node is loaded eagerly at construction in real init; here we
    # set it directly because we bypassed __init__.
    client.parent_node = TEST_PARENT

    return client


# --- subname_node ------------------------------------------------------------


def test_subname_node_matches_solidity_namehash():
    """Pure client-side hash: keccak256(parentNode || keccak256(label)).

    Mirrors PlayerSubnameRegistrar.subnameNode in Solidity exactly. Tested
    against a hand-computed reference value derived from the same
    keccak chain so a future ABI/algorithm drift gets caught here.
    """
    from eth_utils import keccak

    client = _make_client()
    label = "alice"
    expected = keccak(bytes.fromhex(TEST_PARENT[2:]) + keccak(text=label)).hex()
    expected = "0x" + expected
    assert client.subname_node(label) == expected


def test_subname_node_rejects_empty_label():
    client = _make_client()
    with pytest.raises(EnsError, match="empty label"):
        client.subname_node("")


# --- set_text ----------------------------------------------------------------


def test_set_text_builds_signed_tx_and_returns_prefixed_hash():
    client = _make_client()
    node = "0x" + "ab" * 32
    tx_hash = client.set_text(node=node, key="elo", value="1500")
    assert tx_hash == EXPECTED_TX_HASH
    assert tx_hash.startswith("0x")

    # Contract was called once with our args.
    set_text_fn = client.registrar.functions.setText
    set_text_fn.assert_called_once()
    args = set_text_fn.call_args.args
    assert args[0] == bytes.fromhex(node[2:])  # node passed as bytes32
    assert args[1] == "elo"
    assert args[2] == "1500"


def test_set_text_rejects_unprefixed_node():
    client = _make_client()
    with pytest.raises(EnsError, match="must start with 0x"):
        client.set_text(node="ab" * 32, key="elo", value="1500")


def test_set_text_uses_correct_chain_id_and_nonce():
    client = _make_client()
    client.set_text(node="0x" + "ab" * 32, key="elo", value="1500")
    build_tx = client.registrar.functions.setText.return_value.build_transaction
    tx_params = build_tx.call_args.args[0]
    assert tx_params["from"] == TEST_ADDRESS
    assert tx_params["nonce"] == 7
    assert tx_params["chainId"] == 16602


def test_set_text_raises_on_revert():
    client = _make_client(status=0)
    with pytest.raises(EnsError, match="reverted"):
        client.set_text(node="0x" + "ab" * 32, key="elo", value="1500")


# --- text (view) -------------------------------------------------------------


def test_text_returns_string_value():
    client = _make_client()
    val = client.text(node="0x" + "ab" * 32, key="elo")
    assert val == "1500"

    text_fn = client.registrar.functions.text
    text_fn.assert_called_once()
    args = text_fn.call_args.args
    assert args[0] == bytes.fromhex("ab" * 32)
    assert args[1] == "elo"


# --- from_env ----------------------------------------------------------------


def test_from_env_raises_when_required_var_missing(monkeypatch):
    for k in ("RPC_URL", "PLAYER_SUBNAME_REGISTRAR_ADDRESS", "DEPLOYER_PRIVATE_KEY"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(EnsError, match="Missing env var"):
        EnsClient.from_env()


def test_from_env_constructs_when_all_vars_present(monkeypatch):
    """Construct without hitting a real RPC. Verifies the parent_node read
    is performed once at init (we pre-load it for cheap subname_node calls)."""
    monkeypatch.setenv("RPC_URL", "http://nowhere.example")
    monkeypatch.setenv("PLAYER_SUBNAME_REGISTRAR_ADDRESS", TEST_REGISTRAR)
    monkeypatch.setenv("DEPLOYER_PRIVATE_KEY", TEST_KEY)

    with patch("app.ens_client.Web3") as web3_cls:
        instance = MagicMock()
        instance.is_connected.return_value = True
        instance.eth.account.from_key.return_value = MagicMock(address=TEST_ADDRESS)

        # registrar.functions.parentNode().call() returns parent node bytes32
        parent_bytes = bytes.fromhex(TEST_PARENT[2:])
        instance.eth.contract.return_value.functions.parentNode.return_value.call.return_value = (
            parent_bytes
        )

        web3_cls.return_value = instance
        web3_cls.HTTPProvider = MagicMock()
        web3_cls.to_checksum_address = lambda x: x

        client = EnsClient.from_env()
        assert isinstance(client, EnsClient)
        assert client.parent_node == TEST_PARENT
        web3_cls.HTTPProvider.assert_called_once_with("http://nowhere.example")


def test_from_env_raises_when_rpc_unreachable(monkeypatch):
    monkeypatch.setenv("RPC_URL", "http://nowhere.example")
    monkeypatch.setenv("PLAYER_SUBNAME_REGISTRAR_ADDRESS", TEST_REGISTRAR)
    monkeypatch.setenv("DEPLOYER_PRIVATE_KEY", TEST_KEY)

    with patch("app.ens_client.Web3") as web3_cls:
        instance = MagicMock()
        instance.is_connected.return_value = False
        web3_cls.return_value = instance
        web3_cls.HTTPProvider = MagicMock()
        web3_cls.to_checksum_address = lambda x: x

        with pytest.raises(EnsError, match="cannot connect"):
            EnsClient.from_env()
