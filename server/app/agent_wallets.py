"""
AgentVault operator — posts match stakes on behalf of agents.

The per-agent EOA keystore is gone. Stakes now live in AgentVault.sol,
a single on-chain contract where:
  - Owners deposit/withdraw freely via their connected browser wallet.
  - The server operator key (SERVER_OPERATOR_PRIVATE_KEY) can call
    AgentVault.depositToEscrow() to move stake into MatchEscrow, but
    CANNOT withdraw to arbitrary addresses.

The operator key must be pre-approved by each agent's owner via
AgentVault.approve(agentId, operatorAddress, allowanceWei).
"""

from __future__ import annotations

import os
from typing import Optional

from eth_account import Account
from web3 import Web3
from web3.types import TxReceipt


class AgentWalletError(Exception):
    pass


# Inlined ABIs — no hardhat artifacts needed at runtime.
_VAULT_ABI = [
    {
        "type": "function",
        "name": "depositToEscrow",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "matchId", "type": "bytes32"},
            {"name": "stake", "type": "uint256"},
            {"name": "escrow", "type": "address"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "balances",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "allowances",
        "stateMutability": "view",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "operator", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]


class AgentVaultOperator:
    """Signs AgentVault.depositToEscrow() calls using the server operator key.

    The operator key is a dedicated EOA whose only power is calling
    depositToEscrow() up to the owner-approved allowance per agent.
    It cannot withdraw funds to arbitrary addresses.
    """

    def __init__(
        self,
        *,
        operator_private_key: str,
        vault_address: str,
        match_escrow_address: str,
        rpc_url: str,
    ) -> None:
        self._account = Account.from_key(operator_private_key)
        self._w3 = Web3(Web3.HTTPProvider(rpc_url))
        if not self._w3.is_connected():
            raise AgentWalletError(f"web3 cannot connect to RPC at {rpc_url}")
        self._vault = self._w3.eth.contract(
            address=Web3.to_checksum_address(vault_address),
            abi=_VAULT_ABI,
        )
        self._escrow_address = Web3.to_checksum_address(match_escrow_address)

    @classmethod
    def from_env(cls) -> "AgentVaultOperator":
        from .deployments import address_from_deployment

        rpc_url = os.environ.get("RPC_URL")
        if not rpc_url:
            raise AgentWalletError("Missing env var RPC_URL")
        operator_key = os.environ.get("SERVER_OPERATOR_PRIVATE_KEY")
        if not operator_key:
            raise AgentWalletError("Missing env var SERVER_OPERATOR_PRIVATE_KEY")
        vault = os.environ.get("AGENT_VAULT_ADDRESS") or address_from_deployment("AgentVault")
        if not vault:
            raise AgentWalletError("AgentVault address not configured — set AGENT_VAULT_ADDRESS")
        escrow = os.environ.get("MATCH_ESCROW_ADDRESS") or address_from_deployment("MatchEscrow")
        if not escrow:
            raise AgentWalletError("MatchEscrow address not configured — set MATCH_ESCROW_ADDRESS")
        return cls(
            operator_private_key=operator_key,
            vault_address=vault,
            match_escrow_address=escrow,
            rpc_url=rpc_url,
        )

    @property
    def operator_address(self) -> str:
        return self._account.address

    def deposit_to_escrow(
        self,
        *,
        agent_id: int,
        match_id_hex: str,
        stake_wei: int,
    ) -> str:
        """Call AgentVault.depositToEscrow() with the operator key.

        The vault deducts stake from the agent's balance and forwards it
        to MatchEscrow. Requires the owner to have approved this operator
        via AgentVault.approve(agentId, operatorAddress, allowanceWei).
        """
        if not match_id_hex.startswith("0x") or len(match_id_hex) != 66:
            raise AgentWalletError(f"match_id must be 0x + 64 hex chars: {match_id_hex!r}")
        if stake_wei <= 0:
            raise AgentWalletError(f"stake_wei must be positive, got {stake_wei}")

        nonce = self._w3.eth.get_transaction_count(self._account.address)
        tx = self._vault.functions.depositToEscrow(
            agent_id,
            self._w3.to_bytes(hexstr=match_id_hex),
            stake_wei,
            self._escrow_address,
        ).build_transaction(
            {
                "from": self._account.address,
                "nonce": nonce,
                "chainId": self._w3.eth.chain_id,
                "gas": 200_000,
            }
        )
        signed = self._account.sign_transaction(tx)
        tx_hash = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt: TxReceipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise AgentWalletError(f"depositToEscrow reverted: {tx_hash.hex()}")
        return tx_hash.hex()


# Backwards-compatible alias so code that still imports AgentWalletManager
# or AgentWalletError compiles without changes during the migration.
AgentWalletManager = AgentVaultOperator
