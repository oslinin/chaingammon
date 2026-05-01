"""Tests for POST /agents/{agent_id}/recommend-teammate.

Run with: cd server && uv run pytest tests/test_recommend_teammate_endpoint.py -v

Mocks ChainClient.from_env to return a fake chain that maps agent_id ->
weights_hash, and patches the module-level `get_blob` so the resolver
fetches synthetic bytes (overlay JSON for some agents, torch checkpoint
for others, zero-hash for cold-start).
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))

from app import main as main_mod  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


# ─── fixtures ────────────────────────────────────────────────────────────────


def _torch_blob(*, extras_dim: int = 16, match_count: int = 5) -> bytes:
    """Bytes of a `torch.save`-format BackgammonNet checkpoint, matching
    sample_trainer.save_checkpoint's envelope. Used as the on-0G-storage
    blob for trained agents."""
    import torch

    from sample_trainer import BackgammonNet

    net = BackgammonNet(extras_dim=extras_dim, core_seed=0xBACC, extras_seed=99)
    state = {
        "model": net.state_dict(),
        "match_count": match_count,
        "extras_dim": extras_dim,
        "in_dim": 198,
    }
    buf = io.BytesIO()
    torch.save(state, buf)
    return buf.getvalue()


def _overlay_blob(values: dict, match_count: int) -> bytes:
    """Phase 9 overlay JSON envelope. Used as the on-0G-storage blob
    for untrained (overlay-only) agents."""
    return json.dumps({
        "version": 1,
        "match_count": match_count,
        # Overlay schema requires every CATEGORIES key. Pad missing
        # ones to 0 — Overlay.from_bytes does the parsing on the
        # endpoint side via load_profile.
        "values": _pad_overlay_values(values),
    }, sort_keys=True).encode("utf-8")


def _pad_overlay_values(values: dict) -> dict:
    """Fill in zero values for any missing CATEGORIES key — the
    Overlay schema requires every category present."""
    from app.agent_overlay import CATEGORIES
    return {c: float(values.get(c, 0.0)) for c in CATEGORIES}


@pytest.fixture
def fake_chain(monkeypatch):
    """Wire ChainClient.from_env to return a configurable fake whose
    `agent_data_hashes(aid)` returns whatever the test sets up.

    Returns a dict: tests populate `chain.hashes[aid] = "0x..."`.
    """
    chain = MagicMock()
    chain.agent_registry = object()  # truthy — not None
    chain.hashes = {}

    def agent_data_hashes(aid: int):
        # dataHashes[0] is base weights (unused here), [1] is the per-agent
        # hash the resolver reads.
        h = chain.hashes.get(aid, "0x" + "00" * 32)
        return ["0x" + "00" * 32, h]

    chain.agent_data_hashes.side_effect = agent_data_hashes
    monkeypatch.setattr(main_mod.ChainClient, "from_env", classmethod(lambda cls: chain))
    return chain


@pytest.fixture
def fake_get_blob(monkeypatch):
    """Hand back synthetic bytes for any (hash → bytes) mapping the test
    populates. The endpoint passes `fetch=get_blob` to load_profile, so
    patching the module-level `get_blob` covers every resolver call."""
    blobs: dict[str, bytes] = {}

    def fake(hash_str: str) -> bytes:
        if hash_str not in blobs:
            from app.og_storage_client import OgStorageError
            raise OgStorageError(f"no blob for {hash_str}")
        return blobs[hash_str]

    monkeypatch.setattr(main_mod, "get_blob", fake)
    return blobs


# ─── tests ───────────────────────────────────────────────────────────────────


def test_requester_model_returns_200_with_model_kind(fake_chain, fake_get_blob):
    """Trained requester + overlay candidates → 200 with requester_kind=model."""
    fake_chain.hashes = {1: "0xrequester", 2: "0xcand2", 3: "0xcand3"}
    fake_get_blob["0xrequester"] = _torch_blob()
    fake_get_blob["0xcand2"] = _overlay_blob({"hits_blot": 0.7}, match_count=4)
    fake_get_blob["0xcand3"] = _overlay_blob({"bearoff_efficient": 0.5}, match_count=8)

    resp = client.post("/agents/1/recommend-teammate", json={"candidates": [2, 3]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["requester_kind"] == "model"
    assert body["candidate_kinds"] == {"2": "overlay", "3": "overlay"}
    assert set(body["equities"].keys()) == {"2", "3"}
    assert body["best_teammate_id"] in (2, 3)
    assert body["spread"] >= 0.0


def test_requester_overlay_falls_back_to_fresh_net(fake_chain, fake_get_blob):
    """Untrained requester (overlay only) → 200 with requester_kind=overlay
    and a deterministic fresh per-agent-seeded net under the hood."""
    fake_chain.hashes = {7: "0xreqoverlay", 11: "0xc11", 13: "0xc13"}
    fake_get_blob["0xreqoverlay"] = _overlay_blob({"opening_slot": 0.3}, match_count=2)
    fake_get_blob["0xc11"] = _overlay_blob({"hits_blot": 0.6}, match_count=1)
    fake_get_blob["0xc13"] = _overlay_blob({"phase_holding_game": -0.4}, match_count=1)

    resp = client.post("/agents/7/recommend-teammate", json={"candidates": [11, 13]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["requester_kind"] == "overlay"
    assert body["best_teammate_id"] in (11, 13)


def test_requester_null_returns_422(fake_chain, fake_get_blob):
    """Cold-start requester (zero hash) → 422; chain returned bytes32(0)
    so the resolver returns NullProfile and the endpoint refuses."""
    # No fake_chain.hashes mapping for agent 99 → returns the zero hash.
    fake_chain.hashes = {2: "0xc2"}
    fake_get_blob["0xc2"] = _overlay_blob({"hits_blot": 0.5}, match_count=1)

    resp = client.post("/agents/99/recommend-teammate", json={"candidates": [2]})
    assert resp.status_code == 422
    assert "no weights" in resp.json()["detail"].lower()


def test_empty_candidates_returns_422(fake_chain, fake_get_blob):
    fake_chain.hashes = {1: "0xreq"}
    fake_get_blob["0xreq"] = _torch_blob()
    resp = client.post("/agents/1/recommend-teammate", json={"candidates": []})
    assert resp.status_code == 422
    assert "non-empty" in resp.json()["detail"].lower()


def test_candidate_with_no_weights_marked_null(fake_chain, fake_get_blob):
    """Cold-start *candidate* (no weights) → still scored, but tagged
    `null` in candidate_kinds so the UI can disclose."""
    fake_chain.hashes = {1: "0xreq", 2: "0xc2"}
    fake_get_blob["0xreq"] = _torch_blob()
    fake_get_blob["0xc2"] = _overlay_blob({"hits_blot": 0.5}, match_count=1)
    # Agent 3 has no entry → bytes32(0) → NullProfile.

    resp = client.post(
        "/agents/1/recommend-teammate", json={"candidates": [2, 3]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["candidate_kinds"]["2"] == "overlay"
    assert body["candidate_kinds"]["3"] == "null"
    # All candidates get an equity, including null ones (scored as
    # neutral style).
    assert set(body["equities"].keys()) == {"2", "3"}


def test_argmax_matches_underlying_function(fake_chain, fake_get_blob):
    """End-to-end equality with `recommend_teammate` called directly on
    the same net + style dicts. Locks in that the endpoint isn't doing
    anything funny (filtering, re-ordering, normalization).

    Uses ONE blob throughout — every call to `_torch_blob()` constructs
    a fresh BackgammonNet whose `head` layer is xavier_uniform-initialized
    without a seed, so two calls would produce different nets.
    """
    blob = _torch_blob()
    fake_chain.hashes = {1: "0xreq", 11: "0xc11", 13: "0xc13"}
    fake_get_blob["0xreq"] = blob
    fake_get_blob["0xc11"] = _overlay_blob({"hits_blot": 0.9}, match_count=3)
    fake_get_blob["0xc13"] = _overlay_blob({"hits_blot": -0.9}, match_count=3)

    resp = client.post("/agents/1/recommend-teammate", json={"candidates": [11, 13]})
    body = resp.json()

    # Replay the same call directly using the same blob → same net.
    from agent_profile import ModelProfile
    profile = ModelProfile.from_bytes(blob)
    from teammate_selection import recommend_teammate
    rec = recommend_teammate(profile.net, [
        (11, _pad_overlay_values({"hits_blot": 0.9})),
        (13, _pad_overlay_values({"hits_blot": -0.9})),
    ])
    assert body["best_teammate_id"] == rec.best_teammate_id
    for k, v in rec.equities.items():
        assert body["equities"][str(k)] == pytest.approx(v)
