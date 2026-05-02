"""Tests for drand_dice.py.

Run with:  cd agent && uv run pytest tests/test_drand_dice.py -v

Locks in the deterministic-dice contract the README and the per-turn
mermaid sequence diagram make:
  dice = keccak256(round_digest || turn_index_be8) mod 36
"""
from __future__ import annotations

from hashlib import sha3_256

import pytest

from drand_dice import (
    DICE_FACE_COUNT,
    DICE_PAIR_COUNT,
    DiceRoll,
    derive_dice,
    derive_dice_sequence,
)


# A made-up but stable "drand round digest" used across the test suite
# so any change to the hash function or encoding shows up as a diff.
SAMPLE_DIGEST = bytes.fromhex(
    "8b1a9953c4611296a827abf8c47804d7" "8b1a9953c4611296a827abf8c47804d7"
)


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_same_inputs_yield_same_dice():
    a = derive_dice(SAMPLE_DIGEST, turn_index=0)
    b = derive_dice(SAMPLE_DIGEST, turn_index=0)
    assert a == b


def test_different_turn_indices_yield_different_buckets():
    """Across the first 50 turns of one round we should see at least
    several distinct dice pairs — the hash is collision-resistant."""
    rolls = derive_dice_sequence(SAMPLE_DIGEST, n_turns=50)
    distinct = {r.as_tuple() for r in rolls}
    assert len(distinct) >= 10, (
        "expected ≥10 distinct (d1, d2) over 50 turns; got "
        f"{len(distinct)}"
    )


def test_different_round_digests_yield_different_dice():
    """Two different drand rounds should not collide on turn 0."""
    other = bytes.fromhex("00" * 32)
    assert derive_dice(SAMPLE_DIGEST, 0).as_tuple() != \
           derive_dice(other, 0).as_tuple()


# ---------------------------------------------------------------------------
# Range invariants
# ---------------------------------------------------------------------------


def test_dice_faces_always_in_1_to_6():
    """Sweep many turn indices; every face must land in [1, 6]."""
    for t in range(200):
        roll = derive_dice(SAMPLE_DIGEST, turn_index=t)
        assert 1 <= roll.d1 <= DICE_FACE_COUNT
        assert 1 <= roll.d2 <= DICE_FACE_COUNT


def test_dice_distribution_is_roughly_uniform_over_36_buckets():
    """A weak distribution check: over 3600 turns we expect ~100 hits
    per (d1, d2) bucket. Allow a generous tolerance — this isn't a
    hash quality test, just a sanity check on the encoding."""
    counts: dict[tuple[int, int], int] = {}
    for t in range(3600):
        roll = derive_dice(SAMPLE_DIGEST, turn_index=t)
        counts[roll.as_tuple()] = counts.get(roll.as_tuple(), 0) + 1
    assert len(counts) == DICE_PAIR_COUNT, (
        f"every bucket should be hit at least once over 3600 samples; "
        f"got {len(counts)}/{DICE_PAIR_COUNT}"
    )
    # No bucket should be wildly over- or under-represented.
    expected = 3600 / DICE_PAIR_COUNT
    for bucket, count in counts.items():
        assert expected / 3 <= count <= expected * 3, (
            f"bucket {bucket} count {count} is outside the expected band "
            f"[{expected / 3:.0f}, {expected * 3:.0f}]"
        )


# ---------------------------------------------------------------------------
# Encoding spec
# ---------------------------------------------------------------------------


def test_encoding_matches_keccak_then_mod_36():
    """Direct re-implementation of the spec — `keccak256(digest ||
    turn_index_be8) mod 36` mapped to (d1, d2). Locks the contract so
    any future change is a deliberate, breaking decision."""
    turn_index = 7
    h = sha3_256()
    h.update(SAMPLE_DIGEST)
    h.update(turn_index.to_bytes(8, "big"))
    bucket = int.from_bytes(h.digest(), "big") % 36
    expected_d1 = bucket // 6 + 1
    expected_d2 = bucket % 6 + 1

    roll = derive_dice(SAMPLE_DIGEST, turn_index=turn_index)
    assert (roll.d1, roll.d2) == (expected_d1, expected_d2)


# ---------------------------------------------------------------------------
# DiceRoll value semantics
# ---------------------------------------------------------------------------


def test_is_double_detects_doubles():
    # bucket = 0 → d1 = 1, d2 = 1 (a double).
    # We can't directly construct that from the sample digest, so build
    # a DiceRoll by hand to test the property.
    assert DiceRoll(d1=4, d2=4, round_number=0, turn_index=0).is_double
    assert not DiceRoll(d1=3, d2=5, round_number=0, turn_index=0).is_double


def test_invalid_face_raises():
    with pytest.raises(ValueError):
        DiceRoll(d1=0, d2=3, round_number=0, turn_index=0)
    with pytest.raises(ValueError):
        DiceRoll(d1=3, d2=7, round_number=0, turn_index=0)


def test_negative_turn_index_rejected():
    with pytest.raises(ValueError):
        derive_dice(SAMPLE_DIGEST, turn_index=-1)


def test_non_bytes_digest_rejected():
    with pytest.raises(TypeError):
        derive_dice("not-bytes", turn_index=0)  # type: ignore[arg-type]
