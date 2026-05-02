"""
Tests for agent_wallets — server-managed per-agent EOAs for staked matches.

Hermetic: web3 connectivity + RPC calls are mocked so the suite runs
without a node. The keystore round-trip uses the real eth_account
implementation but with a low iterations count so it stays fast (~10 ms
per encrypt).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from web3 import Web3

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_wallets import AgentWalletError, AgentWalletManager  # noqa: E402

# A funded Hardhat dev address — used as the destination for withdraw tests.
DEST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ESCROW = "0x1206A93a9B76652382BC1F5164a8383a9F2A2e16"
RPC = "http://localhost:8545"


@pytest.fixture
def fast_manager(tmp_path):
    """An AgentWalletManager wired against a mocked Web3 with a tiny
    iteration count so encrypt/decrypt is ~10 ms."""
    with patch("app.agent_wallets.Web3") as mock_web3_cls:
        # Web3() returns an instance with .is_connected() == True and a
        # mocked .eth namespace. Test functions mutate the mock as needed.
        mock_w3 = MagicMock()
        mock_w3.is_connected.return_value = True
        mock_w3.eth.chain_id = 11155111
        # to_checksum_address / to_bytes are class-level helpers — keep the
        # real implementations so format validation still runs.
        mock_web3_cls.return_value = mock_w3
        mock_web3_cls.HTTPProvider = Web3.HTTPProvider
        mock_web3_cls.to_checksum_address = staticmethod(Web3.to_checksum_address)

        manager = AgentWalletManager(
            keystore_dir=tmp_path,
            passphrase="test-passphrase",
            rpc_url=RPC,
            match_escrow_address=ESCROW,
            iterations=2,
        )
        manager._mock_w3 = mock_w3  # expose for tests that need to set return values
        yield manager


def test_refuses_to_operate_without_passphrase(tmp_path):
    with patch("app.agent_wallets.Web3"):
        with pytest.raises(AgentWalletError, match="passphrase"):
            AgentWalletManager(
                keystore_dir=tmp_path,
                passphrase="",
                rpc_url=RPC,
                match_escrow_address=ESCROW,
            )


def test_create_then_get_address_round_trips(fast_manager, tmp_path):
    wallet = fast_manager.create(agent_id=42)
    assert wallet.agent_id == 42
    assert Web3.is_address(wallet.address)
    # Same address comes back via get_address (no decryption).
    assert fast_manager.get_address(42) == wallet.address
    # Keystore file persists at the expected path.
    assert (tmp_path / "42.json").exists()


def test_create_refuses_to_overwrite(fast_manager):
    fast_manager.create(agent_id=7)
    with pytest.raises(AgentWalletError, match="already exists"):
        fast_manager.create(agent_id=7)


def test_get_or_create_is_idempotent(fast_manager):
    a = fast_manager.get_or_create(agent_id=99)
    b = fast_manager.get_or_create(agent_id=99)
    assert a.address == b.address


def test_keystore_persists_across_manager_instances(fast_manager, tmp_path):
    # First manager creates the keystore.
    wallet = fast_manager.create(agent_id=3)

    # A fresh manager instance against the same keystore_dir reads it.
    with patch("app.agent_wallets.Web3") as mock_web3_cls:
        mock_w3 = MagicMock()
        mock_w3.is_connected.return_value = True
        mock_web3_cls.return_value = mock_w3
        mock_web3_cls.HTTPProvider = Web3.HTTPProvider
        mock_web3_cls.to_checksum_address = staticmethod(Web3.to_checksum_address)
        m2 = AgentWalletManager(
            keystore_dir=tmp_path,
            passphrase="test-passphrase",
            rpc_url=RPC,
            match_escrow_address=ESCROW,
            iterations=2,
        )
        assert m2.get_address(3) == wallet.address


def test_get_address_raises_for_missing_agent(fast_manager):
    with pytest.raises(AgentWalletError, match="No wallet"):
        fast_manager.get_address(404)


def test_deposit_rejects_malformed_match_id(fast_manager):
    fast_manager.create(agent_id=1)
    with pytest.raises(AgentWalletError, match="match_id"):
        fast_manager.deposit_to_escrow(agent_id=1, match_id_hex="not-hex", stake_wei=1)
    with pytest.raises(AgentWalletError, match="match_id"):
        fast_manager.deposit_to_escrow(agent_id=1, match_id_hex="0xabcd", stake_wei=1)


def test_deposit_rejects_non_positive_stake(fast_manager):
    fast_manager.create(agent_id=1)
    good_id = "0x" + "ab" * 32
    with pytest.raises(AgentWalletError, match="positive"):
        fast_manager.deposit_to_escrow(agent_id=1, match_id_hex=good_id, stake_wei=0)
    with pytest.raises(AgentWalletError, match="positive"):
        fast_manager.deposit_to_escrow(agent_id=1, match_id_hex=good_id, stake_wei=-5)


def test_deposit_refuses_when_escrow_unset(tmp_path):
    with patch("app.agent_wallets.Web3") as mock_web3_cls:
        mock_w3 = MagicMock()
        mock_w3.is_connected.return_value = True
        mock_web3_cls.return_value = mock_w3
        mock_web3_cls.HTTPProvider = Web3.HTTPProvider
        mock_web3_cls.to_checksum_address = staticmethod(Web3.to_checksum_address)
        m = AgentWalletManager(
            keystore_dir=tmp_path,
            passphrase="test",
            rpc_url=RPC,
            match_escrow_address=None,
            iterations=2,
        )
        m.create(agent_id=1)
        good_id = "0x" + "ab" * 32
        with pytest.raises(AgentWalletError, match="match_escrow_address not configured"):
            m.deposit_to_escrow(agent_id=1, match_id_hex=good_id, stake_wei=1)


def test_get_balance_wei_calls_get_balance(fast_manager):
    fast_manager.create(agent_id=5)
    fast_manager._mock_w3.eth.get_balance.return_value = 12345
    assert fast_manager.get_balance_wei(5) == 12345


def test_withdraw_zero_balance_errors(fast_manager):
    fast_manager.create(agent_id=8)
    fast_manager._mock_w3.eth.get_balance.return_value = 0
    with pytest.raises(AgentWalletError, match="balance is zero"):
        fast_manager.withdraw(agent_id=8, to=DEST)


def test_withdraw_below_gas_errors(fast_manager):
    fast_manager.create(agent_id=8)
    # Balance covers neither send + gas.
    fast_manager._mock_w3.eth.get_balance.return_value = 100
    fast_manager._mock_w3.eth.gas_price = 10
    # 21000 * 10 = 210_000 wei gas, balance is only 100 — drain mode fails.
    with pytest.raises(AgentWalletError, match="cover gas"):
        fast_manager.withdraw(agent_id=8, to=DEST)


def test_keystore_file_perms_are_0600(fast_manager, tmp_path):
    fast_manager.create(agent_id=12)
    path = tmp_path / "12.json"
    mode = path.stat().st_mode & 0o777
    assert mode == 0o600, f"keystore should be 0600, got {oct(mode)}"


def test_get_address_returns_checksummed_form(fast_manager, tmp_path):
    """v3 keystore stores `address` without 0x prefix; get_address must
    apply EIP-55 checksumming so callers see canonical 0x… form."""
    fast_manager.create(agent_id=99)
    record = json.loads((tmp_path / "99.json").read_text())
    assert not record["address"].startswith("0x")
    addr = fast_manager.get_address(99)
    assert addr.startswith("0x")
    assert addr == Web3.to_checksum_address(addr)
