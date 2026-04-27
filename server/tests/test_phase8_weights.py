"""
Phase 8 unit tests for the encrypted-weights helper.

These pin down the on-disk envelope used to store gnubg's neural network
weights on 0G Storage. The envelope shape is content-addressed (its bytes
land directly on 0G Storage and become `dataHashes[0]` of every agent
iNFT), so determinism and round-trip equality are the load-bearing
properties tested here.

No network. AES-GCM only.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.weights import (  # noqa: E402
    EncryptedWeights,
    WeightsCryptoError,
    decrypt_weights,
    encrypt_weights,
    generate_key,
)


# --- key generation ---------------------------------------------------------


def test_generate_key_is_32_bytes_for_aes_256():
    key = generate_key()
    assert isinstance(key, bytes)
    assert len(key) == 32, "AES-256-GCM uses a 32-byte key"


def test_generate_key_is_random_each_call():
    a = generate_key()
    b = generate_key()
    assert a != b, "two fresh keys should differ with overwhelming probability"


# --- encrypt/decrypt round-trip ---------------------------------------------


def test_round_trip_recovers_plaintext():
    key = generate_key()
    plaintext = b"gnubg-weights-stub-" + b"A" * 1024
    ct = encrypt_weights(plaintext, key)
    recovered = decrypt_weights(ct, key)
    assert recovered == plaintext


def test_round_trip_handles_large_payload():
    """gnubg.wd is ~400 KB; make sure the AES-GCM helper handles
    realistic sizes without splitting tags or surprising us."""
    key = generate_key()
    plaintext = os.urandom(400 * 1024)
    ct = encrypt_weights(plaintext, key)
    assert decrypt_weights(ct, key) == plaintext


def test_decrypt_with_wrong_key_raises():
    key = generate_key()
    other = generate_key()
    ct = encrypt_weights(b"secret", key)
    with pytest.raises(WeightsCryptoError):
        decrypt_weights(ct, other)


def test_decrypt_rejects_tampered_ciphertext():
    key = generate_key()
    ct_obj = encrypt_weights(b"hello there", key)
    # Flip a byte in the ciphertext body — GCM's auth tag should reject.
    tampered_body = bytearray(ct_obj.ciphertext)
    tampered_body[0] ^= 0xFF
    tampered = EncryptedWeights(
        version=ct_obj.version,
        nonce=ct_obj.nonce,
        ciphertext=bytes(tampered_body),
    )
    with pytest.raises(WeightsCryptoError):
        decrypt_weights(tampered, key)


# --- envelope determinism + serialization -----------------------------------


def test_each_encryption_uses_fresh_nonce():
    """Same plaintext + same key encrypted twice must produce different
    ciphertexts (otherwise the nonce reuse breaks GCM). The on-chain
    Merkle root will therefore differ — uploaders should encrypt once
    and reuse the resulting blob."""
    key = generate_key()
    a = encrypt_weights(b"same input", key)
    b = encrypt_weights(b"same input", key)
    assert a.nonce != b.nonce, "GCM mandates a unique nonce per (key, message)"
    assert a.ciphertext != b.ciphertext


def test_envelope_serializes_to_bytes_round_trip():
    """The full upload flow is `encrypt → to_bytes → put_blob`, then later
    `get_blob → from_bytes → decrypt`. Make sure to_bytes/from_bytes is
    a clean round-trip."""
    key = generate_key()
    ct = encrypt_weights(b"payload", key)
    blob = ct.to_bytes()
    rebuilt = EncryptedWeights.from_bytes(blob)
    assert rebuilt == ct
    assert decrypt_weights(rebuilt, key) == b"payload"


def test_envelope_bytes_carry_a_version_byte():
    """First byte of the envelope is the format version. Reserved so
    we can change the layout in v2 without breaking v1 readers."""
    key = generate_key()
    ct = encrypt_weights(b"x", key)
    blob = ct.to_bytes()
    assert blob[0] == 0x01, "envelope version byte should be 0x01"


def test_from_bytes_rejects_unknown_version():
    bad = bytes([0xFE]) + b"\x00" * 12 + b"x"
    with pytest.raises(WeightsCryptoError):
        EncryptedWeights.from_bytes(bad)


def test_from_bytes_rejects_truncated_blob():
    """An envelope shorter than version+nonce is malformed."""
    with pytest.raises(WeightsCryptoError):
        EncryptedWeights.from_bytes(b"\x01\x00\x00")
