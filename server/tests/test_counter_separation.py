"""Locks in the two-counter design:

  * 0G "games trained"   bumped by training only (the trainer writes a
    new checkpoint blob to 0G Storage; the post-training hook calls
    AgentRegistry.updateOverlayHash to pin the new blob's hash). A
    finished single match must NOT touch this.
  * on-chain "matches played"  bumped by match settlement only
    (MatchRegistry.recordMatch / recordMatchAndSplit). A training
    round must NOT touch this.

The agent card surfaces both numbers side-by-side; if either bump
leaks across into the other path the card shows misleading totals,
so we pin the separation here.

Run with:  cd server && uv run pytest tests/test_counter_separation.py -v
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import main as main_module  # noqa: E402
from app import training_service  # noqa: E402


# ─── recording fakes ────────────────────────────────────────────────────────


@dataclass
class _RecordMatchResult:
    match_id: int
    tx_hash: str


class _RecordingChainClient:
    """Records every call so the tests can assert which counter side
    each path actually touched. Returns plausible stub values so the
    handlers don't blow up downstream of the recorded call."""

    def __init__(self) -> None:
        self.agent_registry = object()  # truthy
        self.match_registry = object()
        self.update_overlay_hash_calls: list[tuple[int, str]] = []
        self.record_match_calls: list[dict] = []
        self.record_match_and_split_calls: list[dict] = []

    def update_overlay_hash(self, agent_id: int, root_hash: str) -> str:
        self.update_overlay_hash_calls.append((int(agent_id), str(root_hash)))
        return "0x" + "ab" * 32

    def record_match(self, **kwargs) -> _RecordMatchResult:
        self.record_match_calls.append(dict(kwargs))
        return _RecordMatchResult(match_id=42, tx_hash="0x" + "cd" * 32)

    def record_match_and_split(self, **kwargs) -> _RecordMatchResult:
        self.record_match_and_split_calls.append(dict(kwargs))
        return _RecordMatchResult(match_id=43, tx_hash="0x" + "ef" * 32)


# ─── 0G side: training increments the off-chain counter ────────────────────


def test_training_round_bumps_0g_counter_only_not_match_registry(tmp_path, monkeypatch):
    """One epoch of training should land an updateOverlayHash call per
    agent (pinning the new 0G blob whose embedded match_count is the
    "games trained" value) and zero recordMatch calls (no match was
    actually played — training is self-contained off-chain rollouts)."""
    status_file = tmp_path / "training-status.jsonl"
    # Two `agent_saved` events — what round_robin_trainer emits at the
    # end of a 1-epoch / 2-agent run.
    status_file.write_text(
        json.dumps({
            "event": "agent_saved", "agent_id": 1,
            "root_hash": "0x" + "11" * 32,
        }) + "\n"
        + json.dumps({
            "event": "agent_saved", "agent_id": 2,
            "root_hash": "0x" + "22" * 32,
        }) + "\n"
    )

    fake_chain = _RecordingChainClient()
    # The chain_client module is imported lazily inside
    # _post_training_chain_writes; patch the symbol on whichever module
    # already exposes it.
    from app import chain_client as chain_client_module
    monkeypatch.setattr(
        chain_client_module.ChainClient, "from_env", classmethod(lambda cls: fake_chain)
    )

    # Trainer subprocess "completed cleanly" (returncode 0).
    fake_proc = MagicMock()
    fake_proc.wait.return_value = 0

    training_service._post_training_chain_writes(fake_proc, status_file)

    # 0G side: one updateOverlayHash per agent_saved event. The trainer
    # already uploaded the new blob (whose match_count is the bumped
    # "games trained"); this call pins that blob's root hash.
    assert len(fake_chain.update_overlay_hash_calls) == 2
    assert fake_chain.update_overlay_hash_calls[0] == (1, "0x" + "11" * 32)
    assert fake_chain.update_overlay_hash_calls[1] == (2, "0x" + "22" * 32)

    # MatchRegistry side: untouched — training plays no real matches.
    assert fake_chain.record_match_calls == []
    assert fake_chain.record_match_and_split_calls == []


# ─── on-chain side: match finalize increments MatchRegistry only ───────────


def test_match_finalize_bumps_match_registry_only_not_0g_counter(monkeypatch):
    """One match through /finalize-direct should call recordMatch
    exactly once and never touch updateOverlayHash. The 0G "games
    trained" value lives in the most recent training checkpoint blob;
    a single match doesn't retrain the network, so the count must
    stay put (and no fresh overlay blob gets uploaded)."""
    fake_chain = _RecordingChainClient()
    monkeypatch.setattr(
        main_module.ChainClient, "from_env", classmethod(lambda cls: fake_chain)
    )

    # /finalize-direct uploads the GameRecord blob to 0G Storage and
    # then calls record_match. The GameRecord upload is fine — that's
    # the match audit blob, not the overlay. The overlay path must
    # not run; stub put_blob to confirm we only see the GameRecord.
    upload_calls: list[bytes] = []

    @dataclass
    class _UploadResult:
        root_hash: str = "0x" + "fe" * 32

    def _fake_put_blob(payload: bytes) -> _UploadResult:
        upload_calls.append(payload)
        return _UploadResult()

    monkeypatch.setattr(main_module, "put_blob", _fake_put_blob)

    client = TestClient(main_module.app)
    r = client.post(
        "/finalize-direct",
        json={
            "winner_agent_id": 1,
            "loser_agent_id": 2,
            "match_length": 3,
            "score": [0, 0],
        },
    )
    assert r.status_code == 200, r.text

    # MatchRegistry side: exactly one recordMatch.
    assert len(fake_chain.record_match_calls) == 1
    assert fake_chain.record_match_calls[0]["winner_agent_id"] == 1
    assert fake_chain.record_match_calls[0]["loser_agent_id"] == 2

    # 0G overlay side: untouched. Only the GameRecord blob was
    # uploaded (one put_blob call total — no second call for an
    # overlay), and updateOverlayHash never fired.
    assert fake_chain.update_overlay_hash_calls == []
    assert len(upload_calls) == 1  # GameRecord only
