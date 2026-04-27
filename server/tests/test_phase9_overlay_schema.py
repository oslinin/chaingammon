"""
Phase 9 unit tests for the Overlay dataclass and its 0G Storage envelope.

The bytes produced by `Overlay.to_bytes()` go directly to 0G Storage and
become `dataHashes[1]` on the agent iNFT. Determinism and round-trip
equality are the load-bearing properties — same overlay → same Merkle
root, every time.

No network. Pure data.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.agent_overlay import (  # noqa: E402
    CATEGORIES,
    Overlay,
    OverlayError,
)


# --- defaults and shape -----------------------------------------------------


def test_categories_is_a_concrete_list():
    """CATEGORIES is the canonical column list for the preference vector.
    Order matters (the JSON envelope serializes with sorted keys, but the
    list itself is the schema reference)."""
    assert isinstance(CATEGORIES, tuple) or isinstance(CATEGORIES, list)
    assert len(CATEGORIES) > 0
    # Should include at least the core categories called out in plan.md.
    core = {"opening_slot", "opening_split", "bearoff_efficient", "risk_blot_leaving"}
    assert core.issubset(set(CATEGORIES)), f"missing core categories: {core - set(CATEGORIES)}"


def test_default_overlay_has_zero_for_every_category():
    o = Overlay.default()
    assert o.match_count == 0
    assert o.version == 1
    for c in CATEGORIES:
        assert o.values[c] == 0.0
    assert set(o.values.keys()) == set(CATEGORIES)


def test_overlay_rejects_unknown_category():
    with pytest.raises(OverlayError, match="unknown category"):
        Overlay(version=1, values={"made_up_category": 0.5}, match_count=0)


def test_overlay_rejects_missing_category():
    partial = {c: 0.0 for c in CATEGORIES if c != "opening_slot"}
    with pytest.raises(OverlayError, match="missing categor"):
        Overlay(version=1, values=partial, match_count=0)


# --- serialization round-trip -----------------------------------------------


def test_to_bytes_from_bytes_round_trip():
    o = Overlay.default()
    o.values["opening_slot"] = 0.42
    o.values["bearoff_efficient"] = -0.13
    o = Overlay(version=o.version, values=dict(o.values), match_count=7)
    blob = o.to_bytes()
    rebuilt = Overlay.from_bytes(blob)
    assert rebuilt == o


def test_to_bytes_is_deterministic():
    """Same overlay → same bytes. The bytes' Merkle root is the on-chain
    hash, so non-determinism would make identical overlays produce
    different `dataHashes[1]`."""
    a = Overlay.default()
    a.values["opening_slot"] = 0.1
    b = Overlay(version=a.version, values=dict(a.values), match_count=a.match_count)
    assert a.to_bytes() == b.to_bytes()


def test_to_bytes_is_valid_utf8_json():
    o = Overlay.default()
    blob = o.to_bytes()
    parsed = json.loads(blob.decode("utf-8"))
    assert parsed["version"] == 1
    assert parsed["match_count"] == 0
    assert isinstance(parsed["values"], dict)
    assert set(parsed["values"].keys()) == set(CATEGORIES)


def test_from_bytes_rejects_unknown_version():
    blob = json.dumps(
        {"version": 0xFF, "values": {c: 0.0 for c in CATEGORIES}, "match_count": 0}
    ).encode()
    with pytest.raises(OverlayError, match="unknown overlay version"):
        Overlay.from_bytes(blob)


def test_from_bytes_rejects_malformed_json():
    with pytest.raises(OverlayError):
        Overlay.from_bytes(b"not valid json")


# --- bounds enforcement -----------------------------------------------------


def test_overlay_clips_values_outside_minus_one_one():
    """Values are bounded [-1, 1] by construction. Constructing with
    out-of-range values should clip rather than raise — the `update_overlay`
    function relies on this so it can pass raw deltas through."""
    overshoot = {c: 0.0 for c in CATEGORIES}
    overshoot["opening_slot"] = 5.0
    overshoot["risk_blot_leaving"] = -3.7
    o = Overlay(version=1, values=overshoot, match_count=0)
    assert o.values["opening_slot"] == 1.0
    assert o.values["risk_blot_leaving"] == -1.0


def test_overlay_match_count_must_be_non_negative():
    with pytest.raises(OverlayError, match="match_count"):
        Overlay(version=1, values={c: 0.0 for c in CATEGORIES}, match_count=-1)
