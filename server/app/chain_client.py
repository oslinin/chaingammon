"""
Web3 client for the on-chain MatchRegistry.

Phase 7 uses this directly to call `recordMatch` after every match. Phase
17/18 will replace the direct call with a KeeperHub workflow trigger;
this client will then be used for read-only paths (`get_match`, `agent_elo`).

The minimal ABI is embedded so the server doesn't depend on hardhat
artifacts at runtime (those live in `contracts/artifacts/` and are
gitignored). Keep it in sync with **contracts/src/MatchRegistry.sol**.
"""

from __future__ import annotations

import os
import warnings
from dataclasses import dataclass
from typing import Optional

from web3 import Web3
from web3.types import TxReceipt

# Minimal ABI — only the methods + events we touch. Mirrors
# contracts/src/MatchRegistry.sol exactly.
_MATCH_REGISTRY_ABI = [
    {
        "type": "function",
        "name": "recordMatch",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "winnerAgentId", "type": "uint256"},
            {"name": "winnerHuman", "type": "address"},
            {"name": "loserAgentId", "type": "uint256"},
            {"name": "loserHuman", "type": "address"},
            {"name": "matchLength", "type": "uint16"},
            {"name": "gameRecordHash", "type": "bytes32"},
        ],
        "outputs": [{"name": "matchId", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "getMatch",
        "stateMutability": "view",
        "inputs": [{"name": "matchId", "type": "uint256"}],
        "outputs": [
            {
                "type": "tuple",
                "components": [
                    {"name": "timestamp", "type": "uint64"},
                    {"name": "winnerAgentId", "type": "uint256"},
                    {"name": "winnerHuman", "type": "address"},
                    {"name": "loserAgentId", "type": "uint256"},
                    {"name": "loserHuman", "type": "address"},
                    {"name": "matchLength", "type": "uint16"},
                    {"name": "gameRecordHash", "type": "bytes32"},
                ],
            }
        ],
    },
    {
        "type": "function",
        "name": "matchCount",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "agentElo",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "humanElo",
        "stateMutability": "view",
        "inputs": [{"name": "human", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "event",
        "name": "MatchRecorded",
        "anonymous": False,
        "inputs": [
            {"name": "matchId", "type": "uint256", "indexed": True},
            {"name": "winnerAgentId", "type": "uint256", "indexed": False},
            {"name": "winnerHuman", "type": "address", "indexed": False},
            {"name": "loserAgentId", "type": "uint256", "indexed": False},
            {"name": "loserHuman", "type": "address", "indexed": False},
            {"name": "newWinnerElo", "type": "uint256", "indexed": False},
            {"name": "newLoserElo", "type": "uint256", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "EloUpdated",
        "anonymous": False,
        "inputs": [
            {"name": "agentId", "type": "uint256", "indexed": True},
            {"name": "human", "type": "address", "indexed": True},
            {"name": "oldElo", "type": "uint256", "indexed": False},
            {"name": "newElo", "type": "uint256", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "GameRecordStored",
        "anonymous": False,
        "inputs": [
            {"name": "matchId", "type": "uint256", "indexed": True},
            {"name": "gameRecordHash", "type": "bytes32", "indexed": False},
        ],
    },
]


class ChainError(RuntimeError):
    """Wraps any error from the on-chain client."""


@dataclass(frozen=True)
class FinalizedMatch:
    """Result of recording a match on-chain."""

    match_id: int
    tx_hash: str


class ChainClient:
    """Owner-only client for MatchRegistry. v1 uses one wallet (the deployer)
    to call `recordMatch`. v2 (Phase 18) routes through KeeperHub instead.
    """

    def __init__(
        self,
        rpc_url: str,
        match_registry_address: str,
        private_key: str,
    ) -> None:
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        if not self.w3.is_connected():
            raise ChainError(f"web3 cannot connect to RPC at {rpc_url}")
        self.account = self.w3.eth.account.from_key(private_key)
        self.match_registry = self.w3.eth.contract(
            address=Web3.to_checksum_address(match_registry_address),
            abi=_MATCH_REGISTRY_ABI,
        )

    @classmethod
    def from_env(cls) -> "ChainClient":
        """Construct from RPC_URL, MATCH_REGISTRY_ADDRESS, DEPLOYER_PRIVATE_KEY."""
        for k in ("RPC_URL", "MATCH_REGISTRY_ADDRESS", "DEPLOYER_PRIVATE_KEY"):
            if not os.environ.get(k):
                raise ChainError(f"Missing env var {k}")
        return cls(
            rpc_url=os.environ["RPC_URL"],
            match_registry_address=os.environ["MATCH_REGISTRY_ADDRESS"],
            private_key=os.environ["DEPLOYER_PRIVATE_KEY"],
        )

    @property
    def account_address(self) -> str:
        return self.account.address

    def record_match(
        self,
        *,
        winner_agent_id: int,
        winner_human: str,
        loser_agent_id: int,
        loser_human: str,
        match_length: int,
        game_record_hash: str,
    ) -> FinalizedMatch:
        """Send a recordMatch tx and wait for inclusion. Returns the new matchId."""
        if not game_record_hash.startswith("0x"):
            raise ChainError(f"game_record_hash must start with 0x: {game_record_hash!r}")

        zero_addr = "0x0000000000000000000000000000000000000000"
        winner_h = Web3.to_checksum_address(winner_human) if winner_human != zero_addr else zero_addr
        loser_h = Web3.to_checksum_address(loser_human) if loser_human != zero_addr else zero_addr

        nonce = self.w3.eth.get_transaction_count(self.account.address)
        tx = self.match_registry.functions.recordMatch(
            winner_agent_id,
            winner_h,
            loser_agent_id,
            loser_h,
            match_length,
            self.w3.to_bytes(hexstr=game_record_hash),
        ).build_transaction(
            {
                "from": self.account.address,
                "nonce": nonce,
                "chainId": self.w3.eth.chain_id,
                # Generous gas limit; recordMatch is small but writes to multiple mappings.
                "gas": 500_000,
            }
        )
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt: TxReceipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise ChainError(f"recordMatch tx reverted: {tx_hash.hex()}")

        # Read MatchRecorded event for the assigned matchId. process_receipt
        # walks every log and warns on non-matching ones (e.g. EloUpdated,
        # GameRecordStored that fire in the same tx); suppress those — they
        # aren't errors, just web3.py being chatty.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=UserWarning)
            logs = self.match_registry.events.MatchRecorded().process_receipt(receipt)
        if not logs:
            raise ChainError("MatchRecorded event missing from receipt")
        match_id = int(logs[0]["args"]["matchId"])
        # web3.py's HexBytes.hex() omits the "0x" prefix; add it for consistency.
        tx_hash_hex = tx_hash.hex()
        if not tx_hash_hex.startswith("0x"):
            tx_hash_hex = "0x" + tx_hash_hex
        return FinalizedMatch(match_id=match_id, tx_hash=tx_hash_hex)

    def get_match(self, match_id: int) -> dict:
        """Read a recorded match. Returns a dict mirroring MatchInfo struct."""
        raw = self.match_registry.functions.getMatch(match_id).call()
        return {
            "timestamp": int(raw[0]),
            "winnerAgentId": int(raw[1]),
            "winnerHuman": raw[2],
            "loserAgentId": int(raw[3]),
            "loserHuman": raw[4],
            "matchLength": int(raw[5]),
            "gameRecordHash": "0x" + raw[6].hex(),
        }

    def match_count(self) -> int:
        return int(self.match_registry.functions.matchCount().call())

    def agent_elo(self, agent_id: int) -> int:
        return int(self.match_registry.functions.agentElo(agent_id).call())

    def human_elo(self, human: str) -> int:
        return int(self.match_registry.functions.humanElo(Web3.to_checksum_address(human)).call())
