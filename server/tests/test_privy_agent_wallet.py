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
