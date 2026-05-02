"""Read deployed contract addresses from contracts/deployments/<network>.json.

Single source of truth: deploy.js writes the JSON; the frontend imports it
directly via TypeScript imports; the backend reads it here. Each call site
that previously required `MATCH_REGISTRY_ADDRESS` etc. as env vars can fall
back to this lookup so a fresh redeploy + `pnpm install` is enough — no
manual server/.env edit needed.

Lookup keys off `CHAIN_ID` (env var) and the `chainId` field in each JSON.
Env-var addresses still take precedence in the from_env constructors so
existing test fixtures and one-off overrides keep working.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Optional


_DEPLOYMENTS_DIR = Path(__file__).resolve().parents[2] / "contracts" / "deployments"


@lru_cache(maxsize=8)
def load_deployment(chain_id: int) -> Optional[dict]:
    """Return the deployment record whose `chainId` matches, or None.

    Cached on `chain_id` so repeated calls don't re-read from disk; tests
    that monkeypatch env vars or the deployments dir should call
    `load_deployment.cache_clear()` between runs.
    """
    if not _DEPLOYMENTS_DIR.is_dir():
        return None
    for path in _DEPLOYMENTS_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("chainId") == chain_id:
            return data
    return None


def address_from_deployment(contract_name: str) -> Optional[str]:
    """Look up `contract_name` (e.g. `MatchRegistry`) in the deployment JSON
    matching `CHAIN_ID`. Returns None if `CHAIN_ID` is unset, no JSON
    matches, or the contract isn't listed."""
    chain_id_str = os.environ.get("CHAIN_ID")
    if not chain_id_str:
        return None
    try:
        chain_id = int(chain_id_str)
    except ValueError:
        return None
    record = load_deployment(chain_id)
    if record is None:
        return None
    return record.get("contracts", {}).get(contract_name)
