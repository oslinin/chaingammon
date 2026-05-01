"""Tests for agent_profile.py — run with: cd agent && python -m pytest tests/test_agent_profile.py -v

Covers:
  - NullProfile cold-start summary
  - OverlayProfile picks the highest-magnitude biases and ignores noise
  - load_profile dispatch on hash → NullProfile / OverlayProfile / ModelProfile / fallback on bad bytes
  - load_profile uses the injected fetcher and degrades gracefully on errors
  - ModelProfile.from_bytes round-trips a torch checkpoint and rejects garbage
"""
import io
import json
import pytest

from agent_profile import (
    AgentProfile,
    AgentProfileError,
    ModelProfile,
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
    """Random binary content (no overlay-JSON `{`, no torch zip magic)
    should produce NullProfile rather than crashing the coach."""
    p = load_profile("0xdeadbeef", fetch=lambda _h: b"\x00\x01\x02binary")
    assert isinstance(p, NullProfile)


# ─── ModelProfile / load_profile checkpoint dispatch ────────────────────────


def _build_net_and_blob(*, extras_dim: int = 16):
    """Build a `BackgammonNet`, serialize it via the same envelope
    `sample_trainer.save_checkpoint` writes, and return both the source
    net and the bytes. Tests need the source instance for forward-pass
    equality checks because `BackgammonNet.head` is initialized with an
    unseeded `xavier_uniform_` — two freshly-constructed nets diverge
    even with identical seeds."""
    import torch

    from sample_trainer import BackgammonNet

    net = BackgammonNet(extras_dim=extras_dim, core_seed=0xBACC, extras_seed=42)
    state = {
        "model": net.state_dict(),
        "match_count": 7,
        "extras_dim": extras_dim,
        "in_dim": 198,
    }
    buf = io.BytesIO()
    torch.save(state, buf)
    return net, buf.getvalue()


def _torch_checkpoint_bytes(*, extras_dim: int = 16) -> bytes:
    """Bytes-only version for callers that don't need the source net."""
    _, blob = _build_net_and_blob(extras_dim=extras_dim)
    return blob


def test_model_profile_from_bytes_roundtrips():
    """Serialize a BackgammonNet, deserialize via ModelProfile.from_bytes,
    and check that a forward pass on identical input matches the source
    net. Locks in the resolver's correctness."""
    import torch

    src, blob = _build_net_and_blob(extras_dim=16)
    profile = ModelProfile.from_bytes(blob)

    assert isinstance(profile, ModelProfile)
    assert profile.metrics()["kind"] == "model"
    assert profile.metrics()["match_count"] == 7
    assert profile.metrics()["extras_dim"] == 16
    assert profile.net is not None

    src.eval()
    board = torch.zeros(1, 198)
    extras = torch.zeros(1, 16)
    with torch.no_grad():
        src_out = src(board, extras)
        loaded_out = profile.net(board, extras)
    assert torch.allclose(src_out, loaded_out)


def test_model_profile_summarize_uses_match_count():
    blob = _torch_checkpoint_bytes()
    profile = ModelProfile.from_bytes(blob)
    summary = profile.summarize()
    assert "7" in summary  # match_count from _torch_checkpoint_bytes


def test_model_profile_from_bytes_rejects_garbage():
    """Hostile / malformed input must raise `AgentProfileError`, never
    succeed with junk and never execute embedded pickles. The
    `weights_only=True` flag inside from_bytes is what neutralizes the
    pickle-RCE class of attacks."""
    with pytest.raises(AgentProfileError):
        ModelProfile.from_bytes(b"not a torch checkpoint at all")


def test_model_profile_from_bytes_rejects_partial_checkpoint():
    """A checkpoint missing the `extras_dim` key (older format /
    truncated upload) must raise rather than silently load a misshapen
    net."""
    import torch

    bad = {"model": {}, "match_count": 1}  # missing extras_dim
    buf = io.BytesIO()
    torch.save(bad, buf)
    with pytest.raises(AgentProfileError):
        ModelProfile.from_bytes(buf.getvalue())


def test_load_profile_dispatches_on_zip_magic():
    """A torch-saved blob (starts with `PK\\x03\\x04`) must dispatch to
    ModelProfile, not NullProfile or OverlayProfile."""
    blob = _torch_checkpoint_bytes()
    # Sanity-check that the test fixture really starts with zip magic;
    # otherwise this test is silently passing for the wrong reason.
    assert blob[:4] == b"PK\x03\x04"

    profile = load_profile("0xfeedfeed", fetch=lambda _h: blob)
    assert isinstance(profile, ModelProfile)
    assert profile.net is not None


def test_load_profile_returns_null_on_corrupt_torch_blob():
    """Zip magic but unreadable torch state must degrade to NullProfile,
    not raise — the runtime should keep working even if 0G storage
    serves a corrupted blob."""
    # Forge zip magic prefix on garbage: the first 4 bytes route it to
    # ModelProfile.from_bytes, but torch.load will fail.
    forged = b"PK\x03\x04" + b"\x00" * 64
    profile = load_profile("0xbad", fetch=lambda _h: forged)
    assert isinstance(profile, NullProfile)
