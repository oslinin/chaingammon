"""tests/test_axl_messages.py — Round-trip serialisation for all AXL message types."""

import pytest

from backgammon.axl.messages import (
    Announce,
    Challenge,
    MatchResult,
    WeightsReq,
    WeightsResp,
    from_dict,
)


def _roundtrip(obj):
    d = obj.to_dict()
    return from_dict(d)


def test_announce_roundtrip():
    msg = Announce(agent_id="node-1", checkpoint_hash="0xabc", elo=1650.5, generation=42)
    rt = _roundtrip(msg)
    assert rt.agent_id == msg.agent_id
    assert rt.checkpoint_hash == msg.checkpoint_hash
    assert rt.elo == msg.elo
    assert rt.generation == msg.generation


def test_challenge_roundtrip():
    msg = Challenge(from_id="node-2", n_games=20, seed=12345)
    rt = _roundtrip(msg)
    assert rt.from_id == msg.from_id
    assert rt.n_games == msg.n_games
    assert rt.seed == msg.seed


def test_match_result_roundtrip():
    msg = MatchResult(agent_a="node-1", agent_b="node-2", score_a=14, score_b=6, n_games=20)
    rt = _roundtrip(msg)
    assert rt.agent_a == msg.agent_a
    assert rt.score_a == msg.score_a
    assert rt.score_b == msg.score_b


def test_weights_req_roundtrip():
    msg = WeightsReq(checkpoint_hash="0xdeadbeef")
    rt = _roundtrip(msg)
    assert rt.checkpoint_hash == msg.checkpoint_hash


def test_weights_resp_roundtrip():
    msg = WeightsResp(checkpoint_hash="0xdeadbeef", storage_uri="0g://0x1234")
    rt = _roundtrip(msg)
    assert rt.checkpoint_hash == msg.checkpoint_hash
    assert rt.storage_uri == msg.storage_uri


def test_from_dict_unknown_type_raises():
    with pytest.raises(ValueError, match="Unknown message type"):
        from_dict({"type": "BOGUS", "data": {}})


def test_from_dict_missing_field_raises():
    with pytest.raises(ValueError, match="Missing field"):
        Announce.from_dict({"agent_id": "x"})


def test_type_discriminator_preserved():
    for cls in (Announce, Challenge, MatchResult, WeightsReq, WeightsResp):
        inst = cls()
        assert inst.to_dict()["type"] == cls.__dataclass_fields__["type"].default
