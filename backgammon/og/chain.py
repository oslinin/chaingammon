"""
backgammon/og/chain.py — Web3 client for the Tournament ELO contract on 0G Chain.

Reads the deployed contract address from deployments/0g_testnet.json
(written by contracts/script/deploy_tournament.js).  Never hardcodes addresses.

Required env vars:
  OG_RPC_URL          — e.g. https://evmrpc-testnet.0g.ai
  DEPLOYER_PRIVATE_KEY — hex private key for signing / gas

Functions:
  report_match(agent_a, agent_b, score_a, sig_a, sig_b) → tx_hash
  get_elo(agent)  → int
  top_n(n)        → list[(address, elo)]
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

# ── Deployment manifest ───────────────────────────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEPLOY_FILE = _REPO_ROOT / "deployments" / "0g_testnet.json"


def _load_deployment() -> tuple[str, list]:
    """Return (contract_address, abi)."""
    if not _DEPLOY_FILE.exists():
        raise FileNotFoundError(
            f"Deployment file not found: {_DEPLOY_FILE}. "
            "Run: npx hardhat run contracts/script/deploy_tournament.js --network 0g-testnet"
        )
    with open(_DEPLOY_FILE) as f:
        data = json.load(f)
    address = data["Tournament"]["address"]
    abi = data["Tournament"]["abi"]
    return address, abi


# ── Web3 helpers ──────────────────────────────────────────────────────────────

def _get_w3():
    from web3 import Web3
    rpc = os.environ.get("OG_RPC_URL") or "https://evmrpc-testnet.0g.ai"
    w3 = Web3(Web3.HTTPProvider(rpc))
    if not w3.is_connected():
        raise ConnectionError(f"Cannot connect to RPC: {rpc}")
    return w3


def _get_contract():
    w3 = _get_w3()
    address, abi = _load_deployment()
    return w3, w3.eth.contract(address=Web3.to_checksum_address(address), abi=abi)


# ── Public API ────────────────────────────────────────────────────────────────

def report_match(
    agent_a: str,
    agent_b: str,
    score_a: int,
    sig_a: bytes,
    sig_b: bytes,
) -> str:
    """Submit a co-signed match result and return the transaction hash."""
    from web3 import Web3
    w3, contract = _get_contract()
    priv = os.environ.get("DEPLOYER_PRIVATE_KEY")
    if not priv:
        raise EnvironmentError("DEPLOYER_PRIVATE_KEY not set")
    account = w3.eth.account.from_key(priv)
    score_b = 0   # derived from context; contract uses score_a + score_b internally

    tx = contract.functions.reportMatch(
        Web3.to_checksum_address(agent_a),
        Web3.to_checksum_address(agent_b),
        score_a,
        0,         # score_b placeholder — contract derives from n_games
        sig_a,
        sig_b,
    ).build_transaction({
        "from": account.address,
        "nonce": w3.eth.get_transaction_count(account.address),
        "gas": 200_000,
    })
    signed = w3.eth.account.sign_transaction(tx, priv)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    return tx_hash.hex()


def get_elo(agent: str) -> int:
    """Return on-chain ELO for *agent* address (default 1500)."""
    from web3 import Web3
    _, contract = _get_contract()
    return int(contract.functions.eloRating(Web3.to_checksum_address(agent)).call())


def top_n(n: int) -> list[tuple[str, int]]:
    """Return the top *n* (address, elo) pairs sorted by descending ELO."""
    _, contract = _get_contract()
    result = contract.functions.topN(n).call()
    return [(addr, int(elo)) for addr, elo in result]
