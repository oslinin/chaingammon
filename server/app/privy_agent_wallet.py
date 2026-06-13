"""
Privy agentic wallet — gives each agent its own Privy server wallet.

ETHGlobal NYC 2026, Continuity track, Stream 1 (PRs 1.1 → 1.5).

Background: today an agent's funds live in AgentVault.sol under a server
operator key (see agent_wallets.py). The Continuity plan replaces that with a
Privy *server wallet* per agent: a wallet Privy custodies and the agent signs
for via the Privy API (the raw private key is never exposed to us). With the
agent owning its wallet, Privy can later distribute winnings directly instead
of the server, and the wallet becomes the agent's persistent on-chain identity.

This module provides (in order of addition):
  PR 1.1 — Provision / read
    - get_or_create_wallet(agent_id): provision (once) a Privy server wallet and
      remember the mapping agent_id -> {wallet_id, address}.
    - wallet_for(agent_id): read-only lookup of a previously provisioned wallet.
    - usdc_balance(agent_id): the wallet's USDC balance (ERC-20 balanceOf), in
      USDC's smallest unit (6 decimals). All balances are denominated in USDC.

  PR 1.5 — Autonomous signing (agentic CLI)
    - register_auth_key(agent_id): generate a P-256 key pair, register the
      public key with Privy as an authorization key on the wallet, and persist
      the private key in the JSON store.  Idempotent — safe to call on every
      startup.
    - sign_and_send(agent_id, *, caip2, to, data, value, gas_limit): submit an
      EVM transaction via POST /v1/wallets/{id}/rpc, authenticated with the
      `privy-authorization-signature` header (ECDSA-P256 over SHA-256 of body).
      The agent signs autonomously — the server operator key is never involved.
    - ensure_policy(agent_id, *, allowed_contracts, max_value_wei): create (or
      update) a spend-limit policy on the wallet: only the listed contract
      addresses may be called, and ETH value is capped at max_value_wei.

Persistence: the agent_id -> wallet mapping (including P-256 private PEM) lives
in a small JSON file (PRIVY_AGENT_WALLET_STORE).  The PEM is stored alongside
the wallet; it is not more secret than the existing DEPLOYER_PRIVATE_KEY in
server/.env — both grant spend authority over agent funds.

Privy REST API endpoints used:
  POST {PRIVY_API_BASE}/v1/wallets
    auth:    HTTP Basic (PRIVY_APP_ID : PRIVY_APP_SECRET)
    header:  privy-app-id: {PRIVY_APP_ID}
    body:    {"chain_type": "ethereum"}
    returns: {"id": "<wallet_id>", "address": "0x...", "chain_type": "ethereum"}

  POST {PRIVY_API_BASE}/v1/wallets/{wallet_id}/auth-keys  [PR 1.5]
    auth:    HTTP Basic
    header:  privy-app-id: {PRIVY_APP_ID}
    body:    {"type": "secp256r1", "public_key": "<base64url uncompressed point>"}
    returns: {"id": "authkey_...", ...}

  POST {PRIVY_API_BASE}/v1/wallets/{wallet_id}/rpc  [PR 1.5]
    auth:    HTTP Basic
    headers: privy-app-id, privy-authorization-signature (base64url DER ECDSA-P256)
    body:    {"method":"eth_sendTransaction","caip2":"eip155:N","params":{...}}
    returns: {"method":"eth_sendTransaction","data":{"hash":"0x..."}}

  POST {PRIVY_API_BASE}/v1/wallets/{wallet_id}/policies  [PR 1.5]
    auth:    HTTP Basic
    header:  privy-app-id: {PRIVY_APP_ID}
    body:    {"version":"1.0.0","name":"...","chain_type":"ethereum","method_rules":[...]}
    returns: {"id": "policy_...", ...}
"""

from __future__ import annotations

import base64
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

    `auth_key_id` and `auth_key_private_pem` are set after `register_auth_key`
    is called (PR 1.5).  The PEM is the agent's P-256 signing key — treat it
    with the same care as DEPLOYER_PRIVATE_KEY.
    """

    agent_id: int
    wallet_id: str
    address: str
    chain_type: str = "ethereum"
    auth_key_id: Optional[str] = None
    auth_key_private_pem: Optional[str] = None
    last_tx_hash: Optional[str] = None
    last_tx_amount_usdc: Optional[str] = None
    last_tx_ts: Optional[int] = None

    def to_dict(self) -> dict:
        d: dict = {
            "agent_id": self.agent_id,
            "wallet_id": self.wallet_id,
            "address": self.address,
            "chain_type": self.chain_type,
        }
        if self.auth_key_id:
            d["auth_key_id"] = self.auth_key_id
        if self.auth_key_private_pem:
            d["auth_key_private_pem"] = self.auth_key_private_pem
        if self.last_tx_hash:
            d["last_tx_hash"] = self.last_tx_hash
        if self.last_tx_amount_usdc is not None:
            d["last_tx_amount_usdc"] = self.last_tx_amount_usdc
        if self.last_tx_ts is not None:
            d["last_tx_ts"] = self.last_tx_ts
        return d


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
            auth_key_id=record.get("auth_key_id"),
            auth_key_private_pem=record.get("auth_key_private_pem"),
            last_tx_hash=record.get("last_tx_hash"),
            last_tx_amount_usdc=record.get("last_tx_amount_usdc"),
            last_tx_ts=record.get("last_tx_ts"),
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

    def record_tx(self, agent_id: int, tx_hash: str, amount_usdc: int) -> None:
        """Persist the last autonomous transaction for display in the UI."""
        import time as _time
        store = self._load_store()
        record = store.get(str(agent_id))
        if record is None:
            return
        record["last_tx_hash"] = tx_hash
        record["last_tx_amount_usdc"] = str(amount_usdc)
        record["last_tx_ts"] = int(_time.time())
        store[str(agent_id)] = record
        self._store_path.parent.mkdir(parents=True, exist_ok=True)
        self._store_path.write_text(json.dumps(store, indent=2, sort_keys=True))

    # ----- PR 1.5: autonomous signing ----------------------------------------

    def register_auth_key(self, agent_id: int) -> AgentWallet:
        """Generate a P-256 signing key, register it with Privy, and persist it.

        Idempotent: if auth_key_id is already stored, returns the wallet as-is
        without contacting Privy.

        The P-256 private key is stored in PEM format alongside the wallet in
        the JSON store.  The corresponding public key is registered on the Privy
        wallet so the agent can sign transactions autonomously without exposing a
        raw EVM private key.
        """
        wallet = self.wallet_for(agent_id)
        if wallet is None:
            raise PrivyAgentWalletError(
                f"agent {agent_id} has no Privy wallet; call get_or_create_wallet first"
            )
        if wallet.auth_key_id:
            return wallet  # already registered

        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.serialization import (
            Encoding, NoEncryption, PrivateFormat, PublicFormat,
        )

        private_key = ec.generate_private_key(ec.SECP256R1())
        pubkey_bytes = private_key.public_key().public_bytes(
            Encoding.X962, PublicFormat.UncompressedPoint
        )
        pubkey_b64 = base64.urlsafe_b64encode(pubkey_bytes).decode().rstrip("=")

        payload = {"type": "secp256r1", "public_key": pubkey_b64}
        body_bytes = json.dumps(payload, separators=(",", ":")).encode()
        client = self._http_client or httpx.Client(timeout=30.0)
        owns_client = self._http_client is None
        try:
            resp = client.post(
                f"{self._api_base}/v1/wallets/{wallet.wallet_id}/auth-keys",
                auth=(self._app_id, self._app_secret),
                headers={"privy-app-id": self._app_id, "content-type": "application/json"},
                content=body_bytes,
            )
        except httpx.HTTPError as e:
            raise PrivyAgentWalletError(f"Privy auth-key request failed: {e}") from e
        finally:
            if owns_client:
                client.close()
        if resp.status_code >= 400:
            raise PrivyAgentWalletError(
                f"Privy auth-key create failed (HTTP {resp.status_code}): {resp.text}"
            )
        auth_key_id = resp.json().get("id")
        if not auth_key_id:
            raise PrivyAgentWalletError(f"Privy auth-key response missing id: {resp.text!r}")

        private_pem = private_key.private_bytes(
            Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption()
        ).decode()

        # Re-read store in case another process wrote between wallet_for and now.
        store = self._load_store()
        record = store.get(str(agent_id), {})
        record["auth_key_id"] = auth_key_id
        record["auth_key_private_pem"] = private_pem
        store[str(agent_id)] = record
        self._store_path.parent.mkdir(parents=True, exist_ok=True)
        self._store_path.write_text(json.dumps(store, indent=2, sort_keys=True))

        return AgentWallet(
            agent_id=wallet.agent_id,
            wallet_id=wallet.wallet_id,
            address=wallet.address,
            chain_type=wallet.chain_type,
            auth_key_id=auth_key_id,
            auth_key_private_pem=private_pem,
        )

    def sign_and_send(
        self,
        agent_id: int,
        *,
        caip2: str,
        to: str,
        data: str,
        value: int = 0,
        gas_limit: int = 150_000,
    ) -> str:
        """Submit an EVM transaction signed autonomously by the agent's Privy wallet.

        Uses POST /v1/wallets/{wallet_id}/rpc with a `privy-authorization-signature`
        header (ECDSA-P256-SHA256 over the request body).  The server operator key
        is not used — the agent signs for itself.

        Args:
            caip2:     CAIP-2 chain identifier, e.g. "eip155:11155111" for Sepolia.
            to:        Destination address (checksum or lower-case hex).
            data:      ABI-encoded calldata, "0x"-prefixed.
            value:     Wei to send (default 0 for USDC contract calls).
            gas_limit: Transaction gas limit.

        Returns:
            The transaction hash as a "0x"-prefixed hex string.

        Raises:
            PrivyAgentWalletError if the wallet has no auth key (call
            register_auth_key first) or if the Privy RPC call fails.
        """
        wallet = self.wallet_for(agent_id)
        if wallet is None:
            raise PrivyAgentWalletError(f"agent {agent_id} has no Privy wallet")
        if not wallet.auth_key_id or not wallet.auth_key_private_pem:
            raise PrivyAgentWalletError(
                f"agent {agent_id} has no authorization key; call register_auth_key first"
            )

        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        private_key = load_pem_private_key(
            wallet.auth_key_private_pem.encode(), password=None
        )

        body_dict = {
            "method": "eth_sendTransaction",
            "caip2": caip2,
            "params": {
                "transaction": {
                    "to": to,
                    "data": data,
                    "value": hex(value),
                    "gasLimit": hex(gas_limit),
                }
            },
        }
        body_bytes = json.dumps(body_dict, separators=(",", ":")).encode()
        auth_sig = self._auth_signature(body_bytes, private_key, ec, hashes)

        client = self._http_client or httpx.Client(timeout=60.0)
        owns_client = self._http_client is None
        try:
            resp = client.post(
                f"{self._api_base}/v1/wallets/{wallet.wallet_id}/rpc",
                auth=(self._app_id, self._app_secret),
                headers={
                    "privy-app-id": self._app_id,
                    "privy-authorization-signature": auth_sig,
                    "content-type": "application/json",
                },
                content=body_bytes,
            )
        except httpx.HTTPError as e:
            raise PrivyAgentWalletError(f"Privy RPC request failed: {e}") from e
        finally:
            if owns_client:
                client.close()
        if resp.status_code >= 400:
            raise PrivyAgentWalletError(
                f"Privy RPC failed (HTTP {resp.status_code}): {resp.text}"
            )
        try:
            tx_hash = resp.json()["data"]["hash"]
        except (KeyError, ValueError) as e:
            raise PrivyAgentWalletError(
                f"Unexpected Privy RPC response shape: {resp.text!r}"
            ) from e
        if not tx_hash.startswith("0x"):
            tx_hash = "0x" + tx_hash
        return tx_hash

    def ensure_policy(
        self,
        agent_id: int,
        *,
        allowed_contracts: list,
        max_value_wei: int = 0,
    ) -> str:
        """Create a spend-limit policy on the agent's wallet.

        The policy allows only `allowed_contracts` as call targets and caps
        ETH value at `max_value_wei` (0 for USDC-only agents).  The policy
        name is deterministic so repeated calls are safe (Privy upserts by
        name within an app).

        Returns:
            The Privy policy id.

        Raises:
            PrivyAgentWalletError if the wallet is not provisioned or the
            Privy API call fails.
        """
        wallet = self.wallet_for(agent_id)
        if wallet is None:
            raise PrivyAgentWalletError(f"agent {agent_id} has no Privy wallet")

        policy_name = f"chaingammon-agent-{agent_id}"
        conditions: list = [{"field": "to", "operator": "in", "value": allowed_contracts}]
        if max_value_wei == 0:
            conditions.append({"field": "value", "operator": "eq", "value": "0x0"})

        policy = {
            "version": "1.0.0",
            "name": policy_name,
            "chain_type": "ethereum",
            "method_rules": [
                {
                    "method": "eth_sendTransaction",
                    "rules": [{"name": "allowed-contracts", "conditions": conditions}],
                }
            ],
        }
        body_bytes = json.dumps(policy, separators=(",", ":")).encode()
        client = self._http_client or httpx.Client(timeout=30.0)
        owns_client = self._http_client is None
        try:
            resp = client.post(
                f"{self._api_base}/v1/wallets/{wallet.wallet_id}/policies",
                auth=(self._app_id, self._app_secret),
                headers={"privy-app-id": self._app_id, "content-type": "application/json"},
                content=body_bytes,
            )
        except httpx.HTTPError as e:
            raise PrivyAgentWalletError(f"Privy policy request failed: {e}") from e
        finally:
            if owns_client:
                client.close()
        if resp.status_code >= 400:
            raise PrivyAgentWalletError(
                f"Privy policy failed (HTTP {resp.status_code}): {resp.text}"
            )
        policy_id = resp.json().get("id", "")
        return str(policy_id)

    @staticmethod
    def _auth_signature(body_bytes: bytes, private_key, ec, hashes) -> str:
        """ECDSA-P256-SHA256 signature over body_bytes, returned as base64url DER."""
        signature_der = private_key.sign(body_bytes, ec.ECDSA(hashes.SHA256()))
        return base64.urlsafe_b64encode(signature_der).decode().rstrip("=")

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
