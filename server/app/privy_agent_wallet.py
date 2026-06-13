"""
Privy agentic wallet — gives each agent its own Privy server wallet.

ETHGlobal NYC 2026, Continuity track, Stream 1 (PR 1.1).

Background: today an agent's funds live in AgentVault.sol under a server
operator key (see agent_wallets.py). The Continuity plan replaces that with a
Privy *server wallet* per agent: a wallet Privy custodies and the agent signs
for via the Privy API (the raw private key is never exposed to us). With the
agent owning its wallet, Privy can later distribute winnings directly instead
of the server, and the wallet becomes the agent's persistent on-chain identity.

This module is additive — nothing is removed yet. It provides:
  - get_or_create_wallet(agent_id): provision (once) a Privy server wallet and
    remember the mapping agent_id -> {wallet_id, address}.
  - wallet_for(agent_id): read-only lookup of a previously provisioned wallet.
  - usdc_balance(agent_id): the wallet's USDC balance (ERC-20 balanceOf), in
    USDC's smallest unit (6 decimals). All balances are denominated in USDC.

The agent_id -> wallet mapping is persisted to a small JSON file (configurable
via PRIVY_AGENT_WALLET_STORE) so provisioning is idempotent across restarts.
This mirrors the local-JSON fallback pattern in og_storage_client.py and keeps
the module hermetically testable with no live Privy or RPC dependency.

Privy server-wallet REST API
(https://docs.privy.io/recipes/agent-integrations/agent-cli):
  POST {PRIVY_API_BASE}/v1/wallets
    auth:    HTTP Basic (PRIVY_APP_ID : PRIVY_APP_SECRET)
    header:  privy-app-id: {PRIVY_APP_ID}
    body:    {"chain_type": "ethereum"}
    returns: {"id": "<wallet_id>", "address": "0x...", "chain_type": "ethereum"}
Wallets that sign/send (PR 1.2) may additionally need a
`privy-authorization-signature` header from a P-256 authorization key; that is
out of scope for provisioning + balance reads here.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx

DEFAULT_PRIVY_API_BASE = "https://api.privy.io"
DEFAULT_STORE_PATH = "/tmp/chaingammon-privy-agent-wallets.json"


class PrivyAgentWalletError(Exception):
    """Any failure provisioning or reading a Privy agent wallet."""


@dataclass(frozen=True)
class AgentWallet:
    """A Privy server wallet bound to one agent.

    `wallet_id` is Privy's handle used to sign/send from the wallet via the
    Privy API; `address` is the EVM address that holds USDC.
    """

    agent_id: int
    wallet_id: str
    address: str
    chain_type: str = "ethereum"

    def to_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "wallet_id": self.wallet_id,
            "address": self.address,
            "chain_type": self.chain_type,
        }


# Minimal ERC-20 ABI — only balanceOf is needed to read a USDC balance.
_ERC20_ABI = [
    {
        "type": "function",
        "name": "balanceOf",
        "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    }
]


class PrivyAgentWallets:
    """Provisions and reads Privy server wallets, one per agent.

    Construct directly (tests inject `http_client` / `usdc_contract`) or via
    `from_env()` for the live server.
    """

    def __init__(
        self,
        *,
        app_id: str,
        app_secret: str,
        api_base: str = DEFAULT_PRIVY_API_BASE,
        store_path: "str | Path" = DEFAULT_STORE_PATH,
        usdc_contract=None,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        if not app_id:
            raise PrivyAgentWalletError("app_id must not be empty")
        if not app_secret:
            raise PrivyAgentWalletError("app_secret must not be empty")
        self._app_id = app_id
        self._app_secret = app_secret
        self._api_base = api_base.rstrip("/")
        self._store_path = Path(store_path)
        self._usdc_contract = usdc_contract
        self._http_client = http_client

    @classmethod
    def from_env(cls) -> "PrivyAgentWallets":
        app_id = os.environ.get("PRIVY_APP_ID")
        if not app_id:
            raise PrivyAgentWalletError("Missing env var PRIVY_APP_ID")
        app_secret = os.environ.get("PRIVY_APP_SECRET")
        if not app_secret:
            raise PrivyAgentWalletError("Missing env var PRIVY_APP_SECRET")
        # USDC token: explicit env override, else the same deployment-JSON source
        # the frontend uses (dep.contracts.UsdcToken via chains.ts), so balance
        # reads work automatically wherever the USDC contracts are deployed.
        usdc_token = os.environ.get("USDC_TOKEN_ADDRESS")
        if not usdc_token:
            from .deployments import address_from_deployment

            usdc_token = address_from_deployment("UsdcToken")
        return cls(
            app_id=app_id,
            app_secret=app_secret,
            api_base=os.environ.get("PRIVY_API_BASE", DEFAULT_PRIVY_API_BASE),
            store_path=os.environ.get("PRIVY_AGENT_WALLET_STORE", DEFAULT_STORE_PATH),
            usdc_contract=cls._build_usdc_contract(
                rpc_url=os.environ.get("RPC_URL"),
                usdc_token_address=usdc_token,
            ),
        )

    @staticmethod
    def _build_usdc_contract(*, rpc_url: Optional[str], usdc_token_address: Optional[str]):
        """Build a read-only USDC ERC-20 contract, or None if unconfigured.

        Balance reads are optional in PR 1.1: when RPC_URL or USDC_TOKEN_ADDRESS
        is unset (e.g. before USDC is deployed on the target chain), the wallet
        still provisions and usdc_balance() raises a clear 'not configured'
        error rather than crashing the server at import time.
        """
        if not rpc_url or not usdc_token_address:
            return None
        from web3 import Web3

        w3 = Web3(Web3.HTTPProvider(rpc_url))
        return w3.eth.contract(
            address=Web3.to_checksum_address(usdc_token_address),
            abi=_ERC20_ABI,
        )

    # ----- persistence -----

    def _load_store(self) -> dict:
        if not self._store_path.exists():
            return {}
        try:
            return json.loads(self._store_path.read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_wallet(self, wallet: AgentWallet) -> None:
        store = self._load_store()
        store[str(wallet.agent_id)] = wallet.to_dict()
        self._store_path.parent.mkdir(parents=True, exist_ok=True)
        self._store_path.write_text(json.dumps(store, indent=2, sort_keys=True))

    def wallet_for(self, agent_id: int) -> Optional[AgentWallet]:
        """Return the agent's provisioned wallet, or None if not provisioned."""
        record = self._load_store().get(str(agent_id))
        if not record:
            return None
        return AgentWallet(
            agent_id=int(record["agent_id"]),
            wallet_id=record["wallet_id"],
            address=record["address"],
            chain_type=record.get("chain_type", "ethereum"),
        )

    # ----- provisioning -----

    def get_or_create_wallet(self, agent_id: int, *, chain_type: str = "ethereum") -> AgentWallet:
        """Return the agent's Privy wallet, provisioning one on first call.

        Idempotent: once a wallet exists in the store, no Privy API call is made.
        """
        if agent_id <= 0:
            raise PrivyAgentWalletError(f"agent_id must be a positive int, got {agent_id}")
        existing = self.wallet_for(agent_id)
        if existing is not None:
            return existing

        payload = self._create_remote_wallet(chain_type=chain_type)
        wallet_id = payload.get("id")
        address = payload.get("address")
        if not wallet_id or not address:
            raise PrivyAgentWalletError(f"Privy wallet response missing id/address: {payload!r}")
        wallet = AgentWallet(
            agent_id=agent_id,
            wallet_id=wallet_id,
            address=address,
            chain_type=payload.get("chain_type", chain_type),
        )
        self._save_wallet(wallet)
        return wallet

    def _create_remote_wallet(self, *, chain_type: str) -> dict:
        client = self._http_client or httpx.Client(timeout=30.0)
        owns_client = self._http_client is None
        try:
            resp = client.post(
                f"{self._api_base}/v1/wallets",
                auth=(self._app_id, self._app_secret),
                headers={"privy-app-id": self._app_id},
                json={"chain_type": chain_type},
            )
        except httpx.HTTPError as e:
            raise PrivyAgentWalletError(f"Privy wallet request failed: {e}") from e
        finally:
            if owns_client:
                client.close()
        if resp.status_code >= 400:
            raise PrivyAgentWalletError(
                f"Privy wallet create failed (HTTP {resp.status_code}): {resp.text}"
            )
        try:
            return resp.json()
        except ValueError as e:
            raise PrivyAgentWalletError(f"Privy returned non-JSON: {resp.text!r}") from e

    # ----- balance -----

    def usdc_balance(self, agent_id: int) -> int:
        """Return the agent wallet's USDC balance in USDC's smallest unit (6 decimals).

        Raises PrivyAgentWalletError if the agent has no wallet yet, or if USDC
        reads are not configured (RPC_URL + USDC_TOKEN_ADDRESS).
        """
        wallet = self.wallet_for(agent_id)
        if wallet is None:
            raise PrivyAgentWalletError(
                f"agent {agent_id} has no Privy wallet; provision it first"
            )
        if self._usdc_contract is None:
            raise PrivyAgentWalletError(
                "USDC balance not configured — set RPC_URL and USDC_TOKEN_ADDRESS"
            )
        from web3 import Web3

        addr = Web3.to_checksum_address(wallet.address)
        return int(self._usdc_contract.functions.balanceOf(addr).call())
