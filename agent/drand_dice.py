"""drand_dice.py — derive backgammon dice from a drand round digest.

Each turn's dice are `keccak256(drand_round_digest || turn_index_be8)
mod 36`, then unpacked into a `(d1, d2)` pair in the range 1..6.

This is the deterministic randomness primitive the README and the
per-turn KeeperHub sequence diagram refer to: anyone replaying a match
can re-fetch the same drand round, re-hash, and recover the same dice
without trusting the server.

Why drand vs. commit-reveal:
  - drand rounds are publicly attested by the League of Entropy and
    timestamped — there's no per-match coordination overhead.
  - The dice for round R cannot be predicted before R is published, and
    cannot be denied or forged after.
  - Commit-reveal still works as a fallback for offline / out-of-band
    matches; drand is just the cleaner primary path.

This module does NOT call out to a drand HTTP endpoint — fetching is the
caller's responsibility (KeeperHub workflow step in production, a test
fixture in unit tests). The helpers here only consume an already-fetched
round digest.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha3_256


# Number of distinct unordered dice rolls = 6 * 6 = 36.
DICE_FACE_COUNT = 6
DICE_PAIR_COUNT = DICE_FACE_COUNT * DICE_FACE_COUNT


@dataclass(frozen=True)
class DiceRoll:
    """One backgammon dice roll. `d1` and `d2` are independent 1..6 faces;
    doubles are detected with `d1 == d2` (a backgammon double-rolls move).

    `round_number` and `turn_index` round-trip the inputs so a match
    record can carry them alongside the resulting `(d1, d2)` for replay
    verification."""
    d1: int
    d2: int
    round_number: int
    turn_index: int

    def __post_init__(self) -> None:
        if not (1 <= self.d1 <= DICE_FACE_COUNT):
            raise ValueError(f"d1 out of range: {self.d1}")
        if not (1 <= self.d2 <= DICE_FACE_COUNT):
            raise ValueError(f"d2 out of range: {self.d2}")

    @property
    def is_double(self) -> bool:
        return self.d1 == self.d2

    def as_tuple(self) -> tuple[int, int]:
        return (self.d1, self.d2)


def _keccak256(*chunks: bytes) -> bytes:
    """SHA3-256 (== keccak256 by spec) of the concatenation of chunks.

    Note: Python's hashlib.sha3_256 implements the FIPS-202 SHA3-256,
    which matches Solidity's `keccak256` — both are Keccak-f[1600] with
    the same rate/capacity and standard padding. So `_keccak256(b)` here
    produces the same 32 bytes as `keccak256(b)` on Sepolia.
    """
    h = sha3_256()
    for chunk in chunks:
        h.update(chunk)
    return h.digest()


def derive_dice(round_digest: bytes, turn_index: int, *,
                round_number: int | None = None) -> DiceRoll:
    """Derive a `(d1, d2)` roll from `round_digest` (the bytes returned
    by drand for round R) and `turn_index` (a per-match counter starting
    at 0).

    Encoding:
      bucket = keccak256(round_digest || turn_index_be8) mod 36
      d1 = bucket // 6 + 1     # 1..6
      d2 = bucket %  6 + 1     # 1..6

    `round_number` is preserved on the returned `DiceRoll` for replay
    verification but is NOT mixed into the hash — the round digest is
    already round-bound, so re-hashing the round number would only
    duplicate that binding.
    """
    if not isinstance(round_digest, (bytes, bytearray)):
        raise TypeError("round_digest must be bytes")
    if turn_index < 0:
        raise ValueError(f"turn_index must be non-negative, got {turn_index}")

    digest = _keccak256(bytes(round_digest), turn_index.to_bytes(8, "big"))
    bucket = int.from_bytes(digest, "big") % DICE_PAIR_COUNT
    d1 = bucket // DICE_FACE_COUNT + 1
    d2 = bucket % DICE_FACE_COUNT + 1
    return DiceRoll(
        d1=d1, d2=d2,
        round_number=round_number if round_number is not None else -1,
        turn_index=turn_index,
    )


def derive_dice_sequence(round_digest: bytes, n_turns: int, *,
                         round_number: int | None = None) -> list[DiceRoll]:
    """Convenience: derive dice for turns 0..n_turns-1 from one round
    digest. Used in tests; production code pulls a fresh drand round per
    turn so KeeperHub can interleave validation between them."""
    if n_turns < 0:
        raise ValueError(f"n_turns must be non-negative, got {n_turns}")
    return [derive_dice(round_digest, t, round_number=round_number)
            for t in range(n_turns)]
