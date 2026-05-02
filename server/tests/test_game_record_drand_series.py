"""
Tests for the new MoveEntry.drand_round and GameRecord.series fields.

These additions are backwards-compatible — both fields are Optional and
absent fields don't appear in the canonical JSON envelope (because
`serialize_record` uses `exclude_none=True`). So existing GameRecords
on 0G Storage produce identical bytes after the schema change, and the
Merkle root they hashed to remains stable.

This file pins:
  - drand_round round-trips through MoveEntry construction
  - series envelope round-trips through GameRecord construction
  - SeriesEnvelope rejects malformed values (negative index, zero total)
  - serialized JSON omits these fields entirely when None (preserving
    byte-stable existing records)
  - serialized JSON includes them when present (so audit replayers can
    read them back deterministically)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Make `app` importable when running pytest from server/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app.game_record import (  # noqa: E402
    GameRecord,
    MoveEntry,
    PlayerRef,
    SeriesEnvelope,
    serialize_record,
)


# ---------------------------------------------------------------------------
# MoveEntry.drand_round
# ---------------------------------------------------------------------------


def test_move_entry_accepts_drand_round():
    m = MoveEntry(turn=0, dice=[3, 5], move="13/8 13/10", drand_round=12345)
    assert m.drand_round == 12345


def test_move_entry_default_drand_round_is_none():
    m = MoveEntry(turn=0, dice=[3, 5], move="13/8 13/10")
    assert m.drand_round is None


# ---------------------------------------------------------------------------
# SeriesEnvelope shape
# ---------------------------------------------------------------------------


def test_series_envelope_round_trip():
    s = SeriesEnvelope(series_id="0xabc", series_index=2, series_total=5)
    assert s.series_id == "0xabc"
    assert s.series_index == 2
    assert s.series_total == 5


def test_series_envelope_rejects_negative_index():
    with pytest.raises(ValidationError):
        SeriesEnvelope(series_id="x", series_index=-1, series_total=5)


def test_series_envelope_rejects_zero_total():
    """series_total < 1 is nonsensical — at minimum a series has one match."""
    with pytest.raises(ValidationError):
        SeriesEnvelope(series_id="x", series_index=0, series_total=0)


def test_series_envelope_requires_all_three_fields():
    """All three are required — partial population is a recipe for
    audit-replayer bugs."""
    with pytest.raises(ValidationError):
        SeriesEnvelope(series_id="x", series_index=0)  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# GameRecord with the new fields
# ---------------------------------------------------------------------------


def _record(**overrides) -> GameRecord:
    """Minimal valid GameRecord for tests; pass overrides to mutate."""
    base = dict(
        match_length=1,
        final_score=[1, 0],
        winner=PlayerRef(kind="agent", agent_id=1),
        loser=PlayerRef(kind="human", address="0x" + "11" * 20),
        final_position_id="dummy_pos",
        final_match_id="dummy_match",
    )
    base.update(overrides)
    return GameRecord(**base)


def test_game_record_default_series_is_none():
    r = _record()
    assert r.series is None


def test_game_record_carries_series_envelope():
    r = _record(series=SeriesEnvelope(
        series_id="0xdeadbeef", series_index=1, series_total=3,
    ))
    assert r.series.series_id == "0xdeadbeef"
    assert r.series.series_index == 1


# ---------------------------------------------------------------------------
# Backwards-compatible serialization
# ---------------------------------------------------------------------------


def test_serialized_record_omits_drand_round_when_none():
    """A record with no drand_round must serialize to bytes that
    contain neither the key nor a null value — preserves byte-stable
    archives written before this schema change."""
    r = _record(moves=[MoveEntry(turn=0, dice=[3, 5], move="13/8 13/10")])
    payload = json.loads(serialize_record(r).decode("utf-8"))
    assert "drand_round" not in payload["moves"][0]


def test_serialized_record_omits_series_when_none():
    payload = json.loads(serialize_record(_record()).decode("utf-8"))
    assert "series" not in payload


def test_serialized_record_includes_drand_round_when_present():
    r = _record(moves=[MoveEntry(turn=0, dice=[3, 5], move="13/8 13/10",
                                  drand_round=999)])
    payload = json.loads(serialize_record(r).decode("utf-8"))
    assert payload["moves"][0]["drand_round"] == 999


def test_serialized_record_includes_series_when_present():
    r = _record(series=SeriesEnvelope(series_id="0xabc", series_index=0,
                                       series_total=2))
    payload = json.loads(serialize_record(r).decode("utf-8"))
    assert payload["series"] == {
        "series_id": "0xabc",
        "series_index": 0,
        "series_total": 2,
    }
