"""
Web3 client for the PlayerSubnameRegistrar (ENS-shaped subname registrar).

Phase 11 uses this from `/finalize` to push reputation updates (ELO,
last match id) into ENS text records on the player's
`<label>.chaingammon.eth` profile. v1 of the registrar is deployed on
0G testnet and is owner-only for both `mintSubname` and (server-side)
`setText`; the server signs with `DEPLOYER_PRIVATE_KEY`.

The minimal ABI is embedded so the server doesn't depend on hardhat
artifacts at runtime. Keep it in sync with
**contracts/src/PlayerSubnameRegistrar.sol**.
"""

from __future__ import annotations

import os
from typing import Optional

from eth_utils import keccak
from web3 import Web3
from web3.types import TxReceipt


_PLAYER_SUBNAME_REGISTRAR_ABI = [
    {
        "type": "function",
        "name": "parentNode",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "function",
        "name": "subnameNode",
        "stateMutability": "view",
        "inputs": [{"name": "label", "type": "string"}],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "function",
        "name": "mintSubname",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "label", "type": "string"},
            {"name": "subnameOwner_", "type": "address"},
        ],
        "outputs": [{"name": "node", "type": "bytes32"}],
    },
    {
        "type": "function",
        "name": "ownerOf",
        "stateMutability": "view",
        "inputs": [{"name": "node", "type": "bytes32"}],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "function",
        "name": "text",
        "stateMutability": "view",
        "inputs": [
            {"name": "node", "type": "bytes32"},
            {"name": "key", "type": "string"},
        ],
        "outputs": [{"name": "", "type": "string"}],
    },
    {
        "type": "function",
        "name": "setText",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "node", "type": "bytes32"},
            {"name": "key", "type": "string"},
            {"name": "value", "type": "string"},
        ],
        "outputs": [],
    },
    {
        "type": "event",
        "name": "TextRecordSet",
        "anonymous": False,
        "inputs": [
            {"name": "node", "type": "bytes32", "indexed": True},
            {"name": "key", "type": "string", "indexed": False},
            {"name": "value", "type": "string", "indexed": False},
        ],
    },
]


class EnsError(RuntimeError):
    """Wraps any error from the ENS subname registrar client."""


class EnsClient:
    """Owner-only client for PlayerSubnameRegistrar.

    The server is the contract owner on v1 (mint + setText both authorized
    by the deployer key). v2 / Phase 12 may open setText to subname owners
    via wallet signatures from the frontend.
    """

    def __init__(
        self,
        rpc_url: str,
        registrar_address: str,
        private_key: str,
    ) -> None:
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        if not self.w3.is_connected():
            raise EnsError(f"web3 cannot connect to RPC at {rpc_url}")
        self.account = self.w3.eth.account.from_key(private_key)
        self.registrar = self.w3.eth.contract(
            address=Web3.to_checksum_address(registrar_address),
            abi=_PLAYER_SUBNAME_REGISTRAR_ABI,
        )
        # parent_node is read once at construction so subname_node can be
        # computed locally without a per-label RPC. It's immutable on-chain.
        parent_bytes = self.registrar.functions.parentNode().call()
        self.parent_node = "0x" + parent_bytes.hex()

    @classmethod
    def from_env(cls) -> "EnsClient":
        """Construct from RPC_URL, PLAYER_SUBNAME_REGISTRAR_ADDRESS, DEPLOYER_PRIVATE_KEY."""
        for k in ("RPC_URL", "PLAYER_SUBNAME_REGISTRAR_ADDRESS", "DEPLOYER_PRIVATE_KEY"):
            if not os.environ.get(k):
                raise EnsError(f"Missing env var {k}")
        return cls(
            rpc_url=os.environ["RPC_URL"],
            registrar_address=os.environ["PLAYER_SUBNAME_REGISTRAR_ADDRESS"],
            private_key=os.environ["DEPLOYER_PRIVATE_KEY"],
        )

    @property
    def account_address(self) -> str:
        return self.account.address

    # --- pure / view -------------------------------------------------------

    def subname_node(self, label: str) -> str:
        """Compute the ENS namehash of `<label>.<parent>` locally.

        Mirrors `PlayerSubnameRegistrar.subnameNode` exactly:
        keccak256(parentNode || keccak256(label)). No RPC needed since
        parent_node is loaded once at construction.
        """
        if not label:
            raise EnsError("empty label")
        parent_bytes = bytes.fromhex(self.parent_node[2:])
        label_hash = keccak(text=label)
        return "0x" + keccak(parent_bytes + label_hash).hex()

    def text(self, node: str, key: str) -> str:
        """Read a text record. Returns "" if unset."""
        if not node.startswith("0x"):
            raise EnsError(f"node must start with 0x: {node!r}")
        node_bytes = bytes.fromhex(node[2:])
        return self.registrar.functions.text(node_bytes, key).call()

    def owner_of(self, node: str) -> str:
        if not node.startswith("0x"):
            raise EnsError(f"node must start with 0x: {node!r}")
        return self.registrar.functions.ownerOf(bytes.fromhex(node[2:])).call()

    # --- writes ------------------------------------------------------------

    def mint_subname(self, label: str, subname_owner: str) -> str:
        """Mint `<label>.<parent>` to `subname_owner`. Returns the tx hash.

        Owner-only on the registrar; the server signs. Phase 11 itself
        doesn't auto-mint — Phase 12 (frontend) drives the mint flow,
        but the method lives here so a single client covers all
        registrar writes.
        """
        if not label:
            raise EnsError("empty label")
        nonce = self.w3.eth.get_transaction_count(self.account.address)
        tx = self.registrar.functions.mintSubname(
            label,
            Web3.to_checksum_address(subname_owner),
        ).build_transaction(
            {
                "from": self.account.address,
                "nonce": nonce,
                "chainId": self.w3.eth.chain_id,
                "gas": 200_000,
            }
        )
        return self._send(tx, op="mintSubname")

    def set_text(self, *, node: str, key: str, value: str) -> str:
        """Push a single text record. Returns the tx hash."""
        if not node.startswith("0x"):
            raise EnsError(f"node must start with 0x: {node!r}")
        node_bytes = self.w3.to_bytes(hexstr=node)
        nonce = self.w3.eth.get_transaction_count(self.account.address)
        tx = self.registrar.functions.setText(node_bytes, key, value).build_transaction(
            {
                "from": self.account.address,
                "nonce": nonce,
                "chainId": self.w3.eth.chain_id,
                "gas": 150_000,
            }
        )
        return self._send(tx, op="setText")

    # --- internal ----------------------------------------------------------

    def _send(self, tx: dict, *, op: str) -> str:
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt: TxReceipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise EnsError(f"{op} tx reverted: {tx_hash.hex()}")
        tx_hash_hex = tx_hash.hex()
        if not tx_hash_hex.startswith("0x"):
            tx_hash_hex = "0x" + tx_hash_hex
        return tx_hash_hex
