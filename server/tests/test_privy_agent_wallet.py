"""
Hermetic tests for privy_agent_wallet (ETHGlobal NYC 2026, Stream 1 / PR 1.1).

No live Privy API or RPC: the Privy HTTP call is faked with httpx.MockTransport
and the USDC balance read uses an injected fake ERC-20 contract. The
agent_id -> wallet store is a per-test temp file.
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.privy_agent_wallet import (  # noqa: E402
    AgentWallet,
    PrivyAgentWalletError,
    PrivyAgentWallets,
)

# A valid, checksummable 20-byte address for the fake Privy wallet.
_ADDR = "0x" + "ab" * 20


def _mock_client(calls: list) -> httpx.Client:
    """An httpx.Client whose POST /v1/wallets always returns a fixed wallet.

    Every request is appended to `calls` so tests can assert how many times the
    Privy API was actually hit (idempotency).
    """

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200,
            json={"id": "wal_test", "address": _ADDR, "chain_type": "ethereum"},
        )

    return httpx.Client(transport=httpx.MockTransport(handler))


class _FakeUsdc:
    """Stands in for a web3 ERC-20 contract: .functions.balanceOf(addr).call()."""

    def __init__(self, balance: int) -> None:
        self.functions = _FakeFns(balance)


class _FakeFns:
    def __init__(self, balance: int) -> None:
        self._balance = balance

    def balanceOf(self, _addr):  # noqa: N802 — mirrors the ERC-20 ABI name
        return _FakeCall(self._balance)


class _FakeCall:
    def __init__(self, balance: int) -> None:
        self._balance = balance

    def call(self) -> int:
        return self._balance


def _wallets(tmp_path, *, calls=None, usdc=None) -> PrivyAgentWallets:
    return PrivyAgentWallets(
        app_id="app-id",
        app_secret="app-secret",
        store_path=tmp_path / "wallets.json",
        http_client=_mock_client(calls if calls is not None else []),
        usdc_contract=usdc,
    )


def test_get_or_create_provisions_and_persists(tmp_path):
    calls: list = []
    w = _wallets(tmp_path, calls=calls)
    wallet = w.get_or_create_wallet(1)
    assert isinstance(wallet, AgentWallet)
    assert wallet.agent_id == 1
    assert wallet.wallet_id == "wal_test"
    assert wallet.address == _ADDR
    assert len(calls) == 1
    assert (tmp_path / "wallets.json").exists()


def test_get_or_create_is_idempotent(tmp_path):
    calls: list = []
    w = _wallets(tmp_path, calls=calls)
    first = w.get_or_create_wallet(2)
    second = w.get_or_create_wallet(2)
    assert first == second
    assert len(calls) == 1  # second call hits the store, not Privy


def test_wallet_for_returns_none_when_unprovisioned(tmp_path):
    w = _wallets(tmp_path)
    assert w.wallet_for(999) is None


def test_wallet_persists_across_instances(tmp_path):
    store = tmp_path / "wallets.json"
    w1 = PrivyAgentWallets(
        app_id="a", app_secret="s", store_path=store, http_client=_mock_client([])
    )
    created = w1.get_or_create_wallet(3)
    # A fresh instance (simulating a server restart) reads the same store.
    w2 = PrivyAgentWallets(
        app_id="a", app_secret="s", store_path=store, http_client=_mock_client([])
    )
    assert w2.wallet_for(3) == created


def test_store_isolates_agents(tmp_path):
    w = _wallets(tmp_path)
    a = w.get_or_create_wallet(10)
    b = w.get_or_create_wallet(11)
    assert (a.agent_id, b.agent_id) == (10, 11)
    assert w.wallet_for(10) == a
    assert w.wallet_for(11) == b


def test_usdc_balance_reads_erc20(tmp_path):
    w = _wallets(tmp_path, usdc=_FakeUsdc(1_500_000))  # 1.5 USDC (6 decimals)
    w.get_or_create_wallet(5)
    assert w.usdc_balance(5) == 1_500_000


def test_usdc_balance_requires_wallet(tmp_path):
    w = _wallets(tmp_path, usdc=_FakeUsdc(0))
    with pytest.raises(PrivyAgentWalletError, match="no Privy wallet"):
        w.usdc_balance(404)


def test_usdc_balance_unconfigured_raises(tmp_path):
    w = _wallets(tmp_path, usdc=None)
    w.get_or_create_wallet(6)
    with pytest.raises(PrivyAgentWalletError, match="not configured"):
        w.usdc_balance(6)


def test_get_or_create_rejects_nonpositive_agent_id(tmp_path):
    w = _wallets(tmp_path)
    with pytest.raises(PrivyAgentWalletError):
        w.get_or_create_wallet(0)


def test_create_remote_wallet_surfaces_http_error(tmp_path):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    w = PrivyAgentWallets(
        app_id="a", app_secret="s", store_path=tmp_path / "s.json", http_client=client
    )
    with pytest.raises(PrivyAgentWalletError, match="HTTP 401"):
        w.get_or_create_wallet(1)


def test_from_env_requires_credentials(monkeypatch):
    monkeypatch.delenv("PRIVY_APP_ID", raising=False)
    monkeypatch.delenv("PRIVY_APP_SECRET", raising=False)
    with pytest.raises(PrivyAgentWalletError, match="PRIVY_APP_ID"):
        PrivyAgentWallets.from_env()
    monkeypatch.setenv("PRIVY_APP_ID", "x")
    with pytest.raises(PrivyAgentWalletError, match="PRIVY_APP_SECRET"):
        PrivyAgentWallets.from_env()


# ----- endpoint wiring -----


def test_endpoint_provisions_and_returns_balance(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from app import main

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"id": "wal_ep", "address": _ADDR, "chain_type": "ethereum"}
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    fake = PrivyAgentWallets(
        app_id="a",
        app_secret="s",
        store_path=tmp_path / "ep.json",
        http_client=client,
        usdc_contract=_FakeUsdc(2_000_000),
    )
    monkeypatch.setattr(main.PrivyAgentWallets, "from_env", classmethod(lambda cls: fake))

    tc = TestClient(main.app)
    r = tc.post("/agents/7/privy-wallet")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["wallet_id"] == "wal_ep"
    assert body["address"] == _ADDR
    assert body["usdc_balance"] == "2000000"


def test_endpoint_503_when_privy_unconfigured(monkeypatch):
    from fastapi.testclient import TestClient

    from app import main

    def _raise(_cls):
        raise PrivyAgentWalletError("Missing env var PRIVY_APP_ID")

    monkeypatch.setattr(main.PrivyAgentWallets, "from_env", classmethod(_raise))

    tc = TestClient(main.app)
    r = tc.post("/agents/7/privy-wallet")
    assert r.status_code == 503


# ─── PR 1.2: payout routing ────────────────────────────────────────────────


def test_privy_wallet_address_for_returns_address_when_provisioned(tmp_path):
    """_privy_wallet_address_for returns the Privy wallet address when the
    agent has been provisioned (store file exists with the mapping)."""
    import json, os

    from app.main import _privy_wallet_address_for

    store = tmp_path / "wallets.json"
    store.write_text(json.dumps({"5": {"agent_id": 5, "wallet_id": "wal_x",
                                       "address": _ADDR, "chain_type": "ethereum"}}))
    os.environ["PRIVY_AGENT_WALLET_STORE"] = str(store)
    os.environ.setdefault("PRIVY_APP_ID", "app_test")
    os.environ.setdefault("PRIVY_APP_SECRET", "secret_test")

    addr = _privy_wallet_address_for(5)
    assert addr == _ADDR

    del os.environ["PRIVY_AGENT_WALLET_STORE"]


def test_privy_wallet_address_for_returns_none_when_not_provisioned(tmp_path):
    """Returns None (triggering fallback to agent_owner) when the agent has
    no entry in the store."""
    import json, os

    from app.main import _privy_wallet_address_for

    store = tmp_path / "wallets.json"
    store.write_text(json.dumps({}))
    os.environ["PRIVY_AGENT_WALLET_STORE"] = str(store)
    os.environ.setdefault("PRIVY_APP_ID", "app_test")
    os.environ.setdefault("PRIVY_APP_SECRET", "secret_test")

    assert _privy_wallet_address_for(99) is None

    del os.environ["PRIVY_AGENT_WALLET_STORE"]


def test_privy_wallet_address_for_returns_none_when_unconfigured(monkeypatch):
    """Returns None (no exception) when PRIVY_APP_ID is missing."""
    from app import main

    def _raise(_cls):
        raise PrivyAgentWalletError("Missing env var PRIVY_APP_ID")

    monkeypatch.setattr(main.PrivyAgentWallets, "from_env", classmethod(_raise))
    assert main._privy_wallet_address_for(1) is None


# ─── PR 1.5: autonomous signing ────────────────────────────────────────────


def _wallets_with_wallet(tmp_path, *, agent_id=20) -> PrivyAgentWallets:
    """Helper: a PrivyAgentWallets instance that already has agent provisioned."""
    calls: list = []
    w = _wallets(tmp_path, calls=calls)
    w.get_or_create_wallet(agent_id)
    return w


def test_register_auth_key_calls_privy_and_persists(tmp_path):
    """register_auth_key POSTs a secp256r1 public key to Privy and stores
    the resulting auth_key_id + private PEM in the wallet store."""
    import json as json_

    auth_key_responses: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/auth-keys" in str(request.url):
            auth_key_responses.append(request)
            return httpx.Response(200, json={"id": "authkey_test", "type": "secp256r1"})
        # wallet provisioning
        return httpx.Response(
            200, json={"id": "wal_r", "address": _ADDR, "chain_type": "ethereum"}
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    w = PrivyAgentWallets(
        app_id="a", app_secret="s", store_path=tmp_path / "w.json", http_client=client
    )
    w.get_or_create_wallet(20)
    wallet = w.register_auth_key(20)

    # One POST to /auth-keys was made.
    assert len(auth_key_responses) == 1
    req = auth_key_responses[0]
    body = json_.loads(req.content)
    assert body["type"] == "secp256r1"
    # Public key is a non-empty base64url string.
    assert len(body["public_key"]) > 40

    # auth_key_id and private PEM stored on the returned wallet.
    assert wallet.auth_key_id == "authkey_test"
    assert "BEGIN" in (wallet.auth_key_private_pem or "")

    # Persisted to disk — a fresh instance can read it back.
    w2 = PrivyAgentWallets(
        app_id="a", app_secret="s", store_path=tmp_path / "w.json",
        http_client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    w2_wallet = w2.wallet_for(20)
    assert w2_wallet is not None
    assert w2_wallet.auth_key_id == "authkey_test"


def test_register_auth_key_is_idempotent(tmp_path):
    """Calling register_auth_key twice does not hit Privy a second time."""
    auth_key_calls: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/auth-keys" in str(request.url):
            auth_key_calls.append(request)
            return httpx.Response(200, json={"id": "authkey_once", "type": "secp256r1"})
        return httpx.Response(
            200, json={"id": "wal_idem", "address": _ADDR, "chain_type": "ethereum"}
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    w = PrivyAgentWallets(
        app_id="a", app_secret="s", store_path=tmp_path / "w.json", http_client=client
    )
    w.get_or_create_wallet(21)
    w.register_auth_key(21)
    w.register_auth_key(21)  # second call — should NOT hit Privy

    assert len(auth_key_calls) == 1


def test_register_auth_key_requires_provisioned_wallet(tmp_path):
    w = _wallets(tmp_path)
    with pytest.raises(PrivyAgentWalletError, match="no Privy wallet"):
        w.register_auth_key(999)


def test_sign_and_send_sends_correct_rpc_body(tmp_path):
    """sign_and_send posts eth_sendTransaction JSON to /rpc with the
    privy-authorization-signature header set."""
    import json as json_

    from cryptography.hazmat.primitives.asymmetric import ec as ec_
    from cryptography.hazmat.primitives import hashes as hashes_
    from cryptography.hazmat.primitives.serialization import (
        Encoding, NoEncryption, PrivateFormat, PublicFormat,
    )

    rpc_requests: list = []
    private_key = ec_.generate_private_key(ec_.SECP256R1())
    private_pem = private_key.private_bytes(
        Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption()
    ).decode()

    def handler(request: httpx.Request) -> httpx.Response:
        if "/rpc" in str(request.url):
            rpc_requests.append(request)
            return httpx.Response(200, json={"method": "eth_sendTransaction",
                                              "data": {"hash": "0xdeadbeef"}})
        return httpx.Response(
            200, json={"id": "wal_rpc", "address": _ADDR, "chain_type": "ethereum"}
        )

    import json as json_

    # Pre-populate store with wallet + auth key.
    store_path = tmp_path / "w.json"
    store_path.write_text(json_.dumps({
        "22": {
            "agent_id": 22, "wallet_id": "wal_rpc", "address": _ADDR,
            "chain_type": "ethereum",
            "auth_key_id": "authkey_rpc",
            "auth_key_private_pem": private_pem,
        }
    }))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    w = PrivyAgentWallets(app_id="a", app_secret="s", store_path=store_path, http_client=client)
    tx_hash = w.sign_and_send(
        22,
        caip2="eip155:11155111",
        to="0x" + "cc" * 20,
        data="0x1234",
    )
    assert tx_hash == "0xdeadbeef"
    assert len(rpc_requests) == 1

    req = rpc_requests[0]
    # Authorization signature header must be present and non-empty.
    sig_header = req.headers.get("privy-authorization-signature", "")
    assert len(sig_header) > 10

    # The signature must be a valid ECDSA-P256 signature over the body.
    body_bytes = req.content
    body_dict = json_.loads(body_bytes)
    assert body_dict["method"] == "eth_sendTransaction"
    assert body_dict["caip2"] == "eip155:11155111"
    assert body_dict["params"]["transaction"]["to"] == "0x" + "cc" * 20

    from cryptography.hazmat.primitives.asymmetric import ec as ec_
    from cryptography.hazmat.primitives import hashes as hashes_
    import base64 as b64

    sig_bytes = b64.urlsafe_b64decode(sig_header + "==")  # restore padding
    # Verify the signature against the canonical body bytes.
    private_key.public_key().verify(sig_bytes, body_bytes, ec_.ECDSA(hashes_.SHA256()))
    # If verify() doesn't raise, the signature is valid.


def test_sign_and_send_requires_auth_key(tmp_path):
    """sign_and_send raises if the wallet has no auth key registered."""
    import json as json_

    store_path = tmp_path / "w.json"
    store_path.write_text(json_.dumps({
        "23": {"agent_id": 23, "wallet_id": "wal_nk", "address": _ADDR, "chain_type": "ethereum"}
    }))
    w = PrivyAgentWallets(app_id="a", app_secret="s", store_path=store_path,
                          http_client=_mock_client([]))
    with pytest.raises(PrivyAgentWalletError, match="authorization key"):
        w.sign_and_send(23, caip2="eip155:1", to=_ADDR, data="0x")


def test_ensure_policy_posts_correct_payload(tmp_path):
    """ensure_policy sends a method_rules policy to /v1/wallets/{id}/policies."""
    import json as json_

    policy_requests: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/policies" in str(request.url):
            policy_requests.append(request)
            return httpx.Response(200, json={"id": "policy_abc"})
        return httpx.Response(
            200, json={"id": "wal_pol", "address": _ADDR, "chain_type": "ethereum"}
        )

    store_path = tmp_path / "w.json"
    store_path.write_text(json_.dumps({
        "24": {"agent_id": 24, "wallet_id": "wal_pol", "address": _ADDR, "chain_type": "ethereum"}
    }))
    client = httpx.Client(transport=httpx.MockTransport(handler))
    w = PrivyAgentWallets(app_id="a", app_secret="s", store_path=store_path, http_client=client)

    policy_id = w.ensure_policy(24, allowed_contracts=["0xDividend", "0xUsdc"])
    assert policy_id == "policy_abc"

    req = policy_requests[0]
    body = json_.loads(req.content)
    assert body["version"] == "1.0.0"
    assert body["chain_type"] == "ethereum"
    rules = body["method_rules"][0]
    assert rules["method"] == "eth_sendTransaction"
    conditions = rules["rules"][0]["conditions"]
    to_cond = next(c for c in conditions if c["field"] == "to")
    assert "0xDividend" in to_cond["value"]
    # max_value_wei=0 default → value eq 0x0 condition added
    val_cond = next(c for c in conditions if c["field"] == "value")
    assert val_cond["operator"] == "eq"
