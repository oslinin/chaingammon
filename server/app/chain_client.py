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
_AGENT_REGISTRY_ABI = [
    {
        "type": "function",
        "name": "baseWeightsHash",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "function",
        "name": "setBaseWeightsHash",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "newHash", "type": "bytes32"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "agentCount",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "ownerOf",
        "stateMutability": "view",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "function",
        "name": "tier",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "type": "function",
        "name": "dataHashes",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bytes32[2]"}],
    },
    {
        "type": "event",
        "name": "BaseWeightsHashSet",
        "anonymous": False,
        "inputs": [{"name": "baseWeightsHash", "type": "bytes32", "indexed": False}],
    },
    {
        "type": "function",
        "name": "updateOverlayHash",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "newOverlayHash", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "experienceVersion",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint32"}],
    },
    {
        "type": "function",
        "name": "matchCount",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint32"}],
    },
    {
        "type": "event",
        "name": "OverlayUpdated",
        "anonymous": False,
        "inputs": [
            {"name": "agentId", "type": "uint256", "indexed": True},
            {"name": "overlayHash", "type": "bytes32", "indexed": False},
            {"name": "experienceVersion", "type": "uint32", "indexed": False},
        ],
    },
]


_MATCH_REGISTRY_ABI = [
    {
        "type": "function",
        "name": "nonces",
        "stateMutability": "view",
        "inputs": [{"name": "human", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "settleWithSessionKeys",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "human", "type": "address"},
            {"name": "agentId", "type": "uint256"},
            {"name": "matchLength", "type": "uint16"},
            {"name": "humanWins", "type": "bool"},
            {"name": "gameRecordHash", "type": "bytes32"},
            {"name": "nonce", "type": "uint256"},
            {"name": "sessionKey", "type": "address"},
            {"name": "humanAuthSig", "type": "bytes"},
            {"name": "resultSig", "type": "bytes"},
        ],
        "outputs": [{"name": "matchId", "type": "uint256"}],
    },
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
        "name": "recordMatchAndSplit",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "winnerAgentId", "type": "uint256"},
            {"name": "winnerHuman", "type": "address"},
            {"name": "loserAgentId", "type": "uint256"},
            {"name": "loserHuman", "type": "address"},
            {"name": "matchLength", "type": "uint16"},
            {"name": "gameRecordHash", "type": "bytes32"},
            {"name": "escrowMatchId", "type": "bytes32"},
            {"name": "winners", "type": "address[]"},
            {"name": "shares", "type": "uint256[]"},
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
    """Owner-only client for MatchRegistry + AgentRegistry. v1 uses one
    wallet (the deployer) to call `recordMatch` and `setBaseWeightsHash`.
    v2 (Phase 18) routes mutations through KeeperHub instead.
    """

    def __init__(
        self,
        rpc_url: str,
        match_registry_address: str,
        private_key: str,
        agent_registry_address: Optional[str] = None,
    ) -> None:
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        if not self.w3.is_connected():
            raise ChainError(f"web3 cannot connect to RPC at {rpc_url}")
        self.account = self.w3.eth.account.from_key(private_key)
        self.match_registry = self.w3.eth.contract(
            address=Web3.to_checksum_address(match_registry_address),
            abi=_MATCH_REGISTRY_ABI,
        )
        self.agent_registry = (
            self.w3.eth.contract(
                address=Web3.to_checksum_address(agent_registry_address),
                abi=_AGENT_REGISTRY_ABI,
            )
            if agent_registry_address
            else None
        )

    @classmethod
    def from_env(cls) -> "ChainClient":
        """Construct from RPC_URL, DEPLOYER_PRIVATE_KEY, and contract addresses.

        Contract addresses are sourced in this order, per name:
          1. Env var (e.g. MATCH_REGISTRY_ADDRESS) — explicit override.
          2. contracts/deployments/<network>.json keyed by CHAIN_ID — the
             single source of truth written by deploy.js. Lets a fresh
             redeploy take effect without editing server/.env.
        """
        from .deployments import address_from_deployment

        for k in ("RPC_URL", "DEPLOYER_PRIVATE_KEY"):
            if not os.environ.get(k):
                raise ChainError(f"Missing env var {k}")
        match_registry = (
            os.environ.get("MATCH_REGISTRY_ADDRESS")
            or address_from_deployment("MatchRegistry")
        )
        if not match_registry:
            raise ChainError(
                "Missing MATCH_REGISTRY_ADDRESS — set it in server/.env or "
                "ensure CHAIN_ID matches a contracts/deployments/*.json"
            )
        agent_registry = (
            os.environ.get("AGENT_REGISTRY_ADDRESS")
            or address_from_deployment("AgentRegistry")
        )
        return cls(
            rpc_url=os.environ["RPC_URL"],
            match_registry_address=match_registry,
            private_key=os.environ["DEPLOYER_PRIVATE_KEY"],
            agent_registry_address=agent_registry,
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

    def record_match_and_split(
        self,
        *,
        winner_agent_id: int,
        winner_human: str,
        loser_agent_id: int,
        loser_human: str,
        match_length: int,
        game_record_hash: str,
        escrow_match_id: str,
        winners: list,
        shares: list,
    ) -> FinalizedMatch:
        """Send a recordMatchAndSplit tx (record + atomic escrow payout)
        and wait for inclusion. Returns the new matchId. `winners` and
        `shares` align: winners[i] receives shares[i] wei, sum(shares)
        must equal the escrow pot."""
        if not game_record_hash.startswith("0x"):
            raise ChainError(f"game_record_hash must start with 0x: {game_record_hash!r}")
        if not escrow_match_id.startswith("0x"):
            raise ChainError(f"escrow_match_id must start with 0x: {escrow_match_id!r}")
        if len(winners) != len(shares):
            raise ChainError("winners/shares length mismatch")

        zero_addr = "0x0000000000000000000000000000000000000000"
        winner_h = Web3.to_checksum_address(winner_human) if winner_human != zero_addr else zero_addr
        loser_h = Web3.to_checksum_address(loser_human) if loser_human != zero_addr else zero_addr
        winners_checked = [Web3.to_checksum_address(w) for w in winners]

        nonce = self.w3.eth.get_transaction_count(self.account.address)
        tx = self.match_registry.functions.recordMatchAndSplit(
            winner_agent_id,
            winner_h,
            loser_agent_id,
            loser_h,
            match_length,
            self.w3.to_bytes(hexstr=game_record_hash),
            self.w3.to_bytes(hexstr=escrow_match_id),
            winners_checked,
            [int(s) for s in shares],
        ).build_transaction(
            {
                "from": self.account.address,
                "nonce": nonce,
                "chainId": self.w3.eth.chain_id,
                # Higher than recordMatch — also writes to MatchEscrow and
                # makes N transfers in the loop.
                "gas": 800_000,
            }
        )
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt: TxReceipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise ChainError(f"recordMatchAndSplit tx reverted: {tx_hash.hex()}")

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=UserWarning)
            logs = self.match_registry.events.MatchRecorded().process_receipt(receipt)
        if not logs:
            raise ChainError("MatchRecorded event missing from receipt")
        match_id = int(logs[0]["args"]["matchId"])
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

    def agent_count(self) -> int:
        """Total number of agents minted on AgentRegistry. Mirrors the
        `agentCount()` view the frontend's AgentsList reads."""
        contract = self._require_agent_registry()
        return int(contract.functions.agentCount().call())

    def agent_elo(self, agent_id: int) -> int:
        return int(self.match_registry.functions.agentElo(agent_id).call())

    def human_elo(self, human: str) -> int:
        return int(self.match_registry.functions.humanElo(Web3.to_checksum_address(human)).call())

    def get_nonce(self, human: str) -> int:
        """Read the current settleWithSessionKeys nonce for a human address."""
        return int(self.match_registry.functions.nonces(Web3.to_checksum_address(human)).call())

    # --- AgentRegistry views + setters (Phase 8) ----------------------------

    def _require_agent_registry(self):
        if self.agent_registry is None:
            raise ChainError("AGENT_REGISTRY_ADDRESS not set on this ChainClient")
        return self.agent_registry

    def base_weights_hash(self) -> str:
        contract = self._require_agent_registry()
        raw = contract.functions.baseWeightsHash().call()
        return "0x" + raw.hex()

    def set_base_weights_hash(self, new_hash: str) -> str:
        """Owner-only on AgentRegistry. Updates the shared `dataHashes[0]`
        every agent points at. Returns the tx hash."""
        if not new_hash.startswith("0x"):
            raise ChainError(f"new_hash must start with 0x: {new_hash!r}")
        contract = self._require_agent_registry()
        nonce = self.w3.eth.get_transaction_count(self.account.address)
        tx = contract.functions.setBaseWeightsHash(
            self.w3.to_bytes(hexstr=new_hash)
        ).build_transaction(
            {
                "from": self.account.address,
                "nonce": nonce,
                "chainId": self.w3.eth.chain_id,
                "gas": 100_000,
            }
        )
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise ChainError(f"setBaseWeightsHash tx reverted: {tx_hash.hex()}")
        tx_hash_hex = tx_hash.hex()
        if not tx_hash_hex.startswith("0x"):
            tx_hash_hex = "0x" + tx_hash_hex
        return tx_hash_hex

    def agent_data_hashes(self, agent_id: int) -> list[str]:
        """Returns [baseWeightsHash, overlayHash] for an agent."""
        contract = self._require_agent_registry()
        raw = contract.functions.dataHashes(agent_id).call()
        return ["0x" + h.hex() for h in raw]

    def agent_tier(self, agent_id: int) -> int:
        contract = self._require_agent_registry()
        return int(contract.functions.tier(agent_id).call())

    def agent_match_count(self, agent_id: int) -> int:
        contract = self._require_agent_registry()
        return int(contract.functions.matchCount(agent_id).call())

    def agent_owner(self, agent_id: int) -> str:
        """Return the ERC-721 owner address of the agent NFT."""
        contract = self._require_agent_registry()
        return str(contract.functions.ownerOf(agent_id).call())

    def agent_experience_version(self, agent_id: int) -> int:
        contract = self._require_agent_registry()
        return int(contract.functions.experienceVersion(agent_id).call())

    def update_overlay_hash(self, agent_id: int, new_overlay_hash: str) -> str:
        """Owner-only on AgentRegistry. Sets the agent's `dataHashes[1]`
        (the experience overlay hash) and bumps `matchCount` and
        `experienceVersion` together. Returns the tx hash.

        Phase 18 will move this through a KeeperHub workflow; for v1 the
        server signs directly."""
        if not new_overlay_hash.startswith("0x"):
            raise ChainError(f"new_overlay_hash must start with 0x: {new_overlay_hash!r}")
        contract = self._require_agent_registry()
        nonce = self.w3.eth.get_transaction_count(self.account.address)
        tx = contract.functions.updateOverlayHash(
            agent_id,
            self.w3.to_bytes(hexstr=new_overlay_hash),
        ).build_transaction(
            {
                "from": self.account.address,
                "nonce": nonce,
                "chainId": self.w3.eth.chain_id,
                "gas": 150_000,
            }
        )
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise ChainError(f"updateOverlayHash tx reverted: {tx_hash.hex()}")
        tx_hash_hex = tx_hash.hex()
        if not tx_hash_hex.startswith("0x"):
            tx_hash_hex = "0x" + tx_hash_hex
        return tx_hash_hex
