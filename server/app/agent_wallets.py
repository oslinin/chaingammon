"""
Per-agent server-managed wallets for staked matches.

Each agent (an ERC-7857 iNFT in MatchRegistry) gets a dedicated EOA whose
private key is generated server-side, encrypted at rest as a v3 JSON
keystore, and held in `server/data/agent_keys/<agentId>.json`. The agent's
owner pre-funds the wallet by sending ETH to its address; when the agent
plays a staked match, the server signs `MatchEscrow.deposit` with this
key, and `MatchEscrow.payoutWinner` (called via the settler path) sends
winnings back to the same address. The owner withdraws via
`AgentWalletManager.withdraw`.

This is the K2-minimal trust model from
docs/keeperhub-feedback.md:
  - The server holds the private key for the agent's lifetime.
  - There is no on-chain authorization tying the wallet to the iNFT
    holder; the server is fully trusted to manage the key.
  - The keystore is encrypted at rest with a passphrase from
    AGENT_KEYSTORE_PASSPHRASE; if the env var is unset the manager
    refuses to operate (no plaintext fallback in production paths).

A future K2-full implementation would add an EIP-712 authorization
signature from the iNFT owner so a server compromise can't move funds
without owner intent. Out of scope here.
"""

from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from eth_account import Account
from web3 import Web3
from web3.types import TxReceipt

# MatchEscrow's `deposit` is the only function the agent's session key
# needs to call from this module. ABI inlined so the server doesn't depend
# on hardhat artifacts at runtime. Keep in sync with
# contracts/src/MatchEscrow.sol.
_MATCH_ESCROW_ABI = [
    {
        "type": "function",
        "name": "deposit",
        "stateMutability": "payable",
        "inputs": [
            {"name": "matchId", "type": "bytes32"},
            {"name": "expected", "type": "uint256"},
        ],
        "outputs": [],
    },
]


class AgentWalletError(Exception):
    pass


@dataclass(frozen=True)
class AgentWallet:
    agent_id: int
    address: str


class AgentWalletManager:
    """Manage per-agent server-side EOAs.

    Construct via `AgentWalletManager.from_env()` in production paths;
    pass keystore_dir / passphrase / rpc_url explicitly in tests.
    """

    # eth_account's default keystore iterations (~2^18 PBKDF2 rounds) take
    # ~1 s per encrypt/decrypt on a modern laptop. Production keeps the
    # default; tests pass a smaller value to keep the suite fast.
    DEFAULT_ITERATIONS = 2 ** 18

    def __init__(
        self,
        *,
        keystore_dir: Path,
        passphrase: str,
        rpc_url: str,
        match_escrow_address: Optional[str],
        iterations: int = DEFAULT_ITERATIONS,
    ) -> None:
        if not passphrase:
            raise AgentWalletError(
                "AgentWalletManager refuses to operate without a passphrase. "
                "Set AGENT_KEYSTORE_PASSPHRASE."
            )
        self._keystore_dir = Path(keystore_dir)
        self._keystore_dir.mkdir(parents=True, exist_ok=True)
        self._passphrase = passphrase
        self._iterations = iterations
        self._w3 = Web3(Web3.HTTPProvider(rpc_url))
        if not self._w3.is_connected():
            raise AgentWalletError(f"web3 cannot connect to RPC at {rpc_url}")
        self._match_escrow = (
            self._w3.eth.contract(
                address=Web3.to_checksum_address(match_escrow_address),
                abi=_MATCH_ESCROW_ABI,
            )
            if match_escrow_address
            else None
        )

    @classmethod
    def from_env(cls) -> "AgentWalletManager":
        from .deployments import address_from_deployment

        rpc_url = os.environ.get("RPC_URL")
        if not rpc_url:
            raise AgentWalletError("Missing env var RPC_URL")
        passphrase = os.environ.get("AGENT_KEYSTORE_PASSPHRASE", "")
        keystore_dir = Path(
            os.environ.get(
                "AGENT_KEYSTORE_DIR",
                str(Path(__file__).resolve().parents[1] / "data" / "agent_keys"),
            )
        )
        match_escrow = (
            os.environ.get("MATCH_ESCROW_ADDRESS")
            or address_from_deployment("MatchEscrow")
        )
        return cls(
            keystore_dir=keystore_dir,
            passphrase=passphrase,
            rpc_url=rpc_url,
            match_escrow_address=match_escrow,
        )

    # ── Storage ────────────────────────────────────────────────────────────

    def _keystore_path(self, agent_id: int) -> Path:
        return self._keystore_dir / f"{agent_id}.json"

    def has_wallet(self, agent_id: int) -> bool:
        return self._keystore_path(agent_id).exists()

    def get_address(self, agent_id: int) -> str:
        """Read the public address from the v3 keystore without decrypting
        the private key (avoids the PBKDF2 cost on the read path)."""
        path = self._keystore_path(agent_id)
        if not path.exists():
            raise AgentWalletError(f"No wallet for agent {agent_id}")
        record = json.loads(path.read_text())
        return Web3.to_checksum_address("0x" + record["address"])

    def create(self, agent_id: int) -> AgentWallet:
        """Generate a fresh keypair for agent_id, persist the v3 keystore,
        and return the AgentWallet record. Refuses to overwrite an existing
        keystore — call get_or_create() if you want idempotent semantics."""
        path = self._keystore_path(agent_id)
        if path.exists():
            raise AgentWalletError(f"Wallet for agent {agent_id} already exists")
        account = Account.create()
        keystore = Account.encrypt(account.key, self._passphrase, iterations=self._iterations)
        # Write 0600 so other users on the host can't read the encrypted blob.
        # (Defense in depth — even encrypted, narrow perms are cheap.)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(keystore))
        tmp.chmod(stat.S_IRUSR | stat.S_IWUSR)
        tmp.replace(path)
        return AgentWallet(agent_id=agent_id, address=Web3.to_checksum_address(account.address))

    def get_or_create(self, agent_id: int) -> AgentWallet:
        if self.has_wallet(agent_id):
            return AgentWallet(agent_id=agent_id, address=self.get_address(agent_id))
        return self.create(agent_id)

    def _load_account(self, agent_id: int):
        path = self._keystore_path(agent_id)
        if not path.exists():
            raise AgentWalletError(f"No wallet for agent {agent_id}")
        keystore = json.loads(path.read_text())
        privkey = Account.decrypt(keystore, self._passphrase)
        return Account.from_key(privkey)

    # ── Reads ──────────────────────────────────────────────────────────────

    def get_balance_wei(self, agent_id: int) -> int:
        addr = self.get_address(agent_id)
        return int(self._w3.eth.get_balance(Web3.to_checksum_address(addr)))

    # ── Writes ─────────────────────────────────────────────────────────────

    def deposit_to_escrow(
        self,
        *,
        agent_id: int,
        match_id_hex: str,
        stake_wei: int,
    ) -> str:
        """Sign and send `MatchEscrow.deposit(matchId, stake)` from the
        agent's session-key wallet. Returns the tx hash. Caller is
        responsible for ensuring the wallet has stake_wei + gas headroom."""
        if self._match_escrow is None:
            raise AgentWalletError(
                "match_escrow_address not configured — set MATCH_ESCROW_ADDRESS "
                "or ensure the deployment record carries it."
            )
        if not match_id_hex.startswith("0x") or len(match_id_hex) != 66:
            raise AgentWalletError(f"match_id must be 0x + 64 hex chars: {match_id_hex!r}")
        if stake_wei <= 0:
            raise AgentWalletError(f"stake_wei must be positive, got {stake_wei}")

        account = self._load_account(agent_id)
        nonce = self._w3.eth.get_transaction_count(account.address)
        tx = self._match_escrow.functions.deposit(
            self._w3.to_bytes(hexstr=match_id_hex),
            stake_wei,
        ).build_transaction(
            {
                "from": account.address,
                "nonce": nonce,
                "value": stake_wei,
                "chainId": self._w3.eth.chain_id,
                "gas": 200_000,
            }
        )
        signed = account.sign_transaction(tx)
        tx_hash = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt: TxReceipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise AgentWalletError(f"deposit tx reverted: {tx_hash.hex()}")
        return tx_hash.hex()

    def withdraw(
        self,
        *,
        agent_id: int,
        to: str,
        amount_wei: Optional[int] = None,
    ) -> str:
        """Send ETH from the agent's wallet to `to`. If amount_wei is None,
        drain the entire balance minus gas. Returns the tx hash."""
        account = self._load_account(agent_id)
        recipient = Web3.to_checksum_address(to)
        balance = int(self._w3.eth.get_balance(account.address))
        if balance == 0:
            raise AgentWalletError(f"agent {agent_id} balance is zero")
        gas_limit = 21_000
        gas_price = int(self._w3.eth.gas_price)
        gas_cost = gas_limit * gas_price
        if amount_wei is None:
            send_amount = balance - gas_cost
            if send_amount <= 0:
                raise AgentWalletError(
                    f"agent {agent_id} balance ({balance} wei) doesn't cover gas ({gas_cost} wei)"
                )
        else:
            send_amount = int(amount_wei)
            if send_amount + gas_cost > balance:
                raise AgentWalletError(
                    f"insufficient balance: {balance} wei < {send_amount} + {gas_cost} (gas)"
                )

        nonce = self._w3.eth.get_transaction_count(account.address)
        tx = {
            "from": account.address,
            "to": recipient,
            "value": send_amount,
            "nonce": nonce,
            "chainId": self._w3.eth.chain_id,
            "gas": gas_limit,
            "gasPrice": gas_price,
        }
        signed = account.sign_transaction(tx)
        tx_hash = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt: TxReceipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise AgentWalletError(f"withdraw tx reverted: {tx_hash.hex()}")
        return tx_hash.hex()
