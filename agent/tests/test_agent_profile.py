"""Tests for agent_profile.py — run with: cd agent && python -m pytest tests/test_agent_profile.py -v

Covers:
  - NullProfile cold-start summary
  - OverlayProfile picks the highest-magnitude biases and ignores noise
  - load_profile dispatch on hash → NullProfile / OverlayProfile / fallback on bad bytes
  - load_profile uses the injected fetcher and degrades gracefully on errors
"""
import json
import pytest

from agent_profile import (
    AgentProfile,
    AgentProfileError,
    NullProfile,
    OverlayProfile,
    load_profile,
)


def test_null_profile_summary_is_neutral():
    p = NullProfile()
    summary = p.summarize()
    assert "fresh" in summary.lower() or "neutral" in summary.lower()
    assert p.metrics()["kind"] == "null"


def test_overlay_profile_zero_match_count_is_neutral():
    p = OverlayProfile(values={"build_5_point": 0.5}, match_count=0)
    assert "neutral" in p.summarize().lower()


def test_overlay_profile_picks_top_biases():
    values = {
        "build_5_point": 0.4,        # strongest positive
        "runs_back_checker": -0.3,    # second-strongest, negative
        "phase_blitz": 0.1,           # third
        "opening_split": 0.01,        # below threshold — should be skipped
    }
    p = OverlayProfile(values=values, match_count=12)
    summary = p.summarize()
    assert "12 matches" in summary
    assert "favors building the 5-point" in summary
    assert "avoids running back checkers" in summary
    # noise category must not show up
    assert "split" not in summary


def test_overlay_profile_no_signal_after_matches():
    """All values below threshold → 'no strong style yet' even with match_count > 0."""
    values = {"build_5_point": 0.01, "phase_blitz": -0.02}
    p = OverlayProfile(values=values, match_count=5)
    assert "no strong style" in p.summarize().lower()


def test_overlay_profile_from_bytes_roundtrip():
    blob = json.dumps({
        "version": 1,
        "match_count": 7,
        "values": {"build_5_point": 0.3, "phase_blitz": -0.2},
    }).encode("utf-8")
    p = OverlayProfile.from_bytes(blob)
    assert p.metrics()["match_count"] == 7
    assert "7 matches" in p.summarize()


def test_overlay_profile_from_bytes_rejects_garbage():
    with pytest.raises(AgentProfileError):
        OverlayProfile.from_bytes(b"not json at all")


def test_load_profile_empty_hash_returns_null():
    p = load_profile("")
    assert isinstance(p, NullProfile)


def test_load_profile_overlay_blob():
    blob = json.dumps({
        "version": 1,
        "match_count": 3,
        "values": {"build_5_point": 0.4},
    }).encode("utf-8")

    def fetch(_h: str) -> bytes:
        return blob

    p = load_profile("0xdeadbeef", fetch=fetch)
    assert isinstance(p, OverlayProfile)
    assert "3 matches" in p.summarize()


def test_load_profile_falls_back_on_fetch_error():
    def fetch(_h: str) -> bytes:
        raise RuntimeError("network down")

    p = load_profile("0xdeadbeef", fetch=fetch)
    assert isinstance(p, NullProfile)


def test_load_profile_falls_back_on_non_json_blob():
    """Non-JSON content (e.g. future model checkpoint) without a registered
    handler should produce NullProfile rather than crashing the coach."""
    p = load_profile("0xdeadbeef", fetch=lambda _h: b"\x00\x01\x02binary")
    assert isinstance(p, NullProfile)
