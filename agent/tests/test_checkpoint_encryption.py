"""Tests for checkpoint_encryption.py.

Run with:  cd agent && uv run pytest tests/test_checkpoint_encryption.py -v

Covers the encrypt → decrypt round-trip, the integrity guarantees that
AES-GCM gives us, and the input-validation errors we raise to keep
callers from shooting themselves in the foot (bad key length,
truncated sealed blob, wrong associated_data).
"""
from __future__ import annotations

import pytest
from cryptography.exceptions import InvalidTag

from checkpoint_encryption import (
    KEY_BYTES,
    NONCE_BYTES,
    TAG_BYTES,
    decrypt_blob,
    encrypt_blob,
    generate_key,
)


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


def test_round_trip_recovers_plaintext():
    key = generate_key()
    plaintext = b"the trained value-net state_dict bytes"
    sealed = encrypt_blob(plaintext, key)
    assert decrypt_blob(sealed, key) == plaintext


def test_round_trip_with_associated_data():
    key = generate_key()
    plaintext = b"agent #42 epoch 17 weights"
    aad = b"inft:42|epoch:17"
    sealed = encrypt_blob(plaintext, key, associated_data=aad)
    assert decrypt_blob(sealed, key, associated_data=aad) == plaintext


def test_round_trip_with_empty_plaintext():
    key = generate_key()
    sealed = encrypt_blob(b"", key)
    assert decrypt_blob(sealed, key) == b""


def test_round_trip_with_large_plaintext():
    """Backgammon nets are tiny but the helper should not impose an
    arbitrary size cap. Round-trip a 1 MiB blob."""
    key = generate_key()
    plaintext = b"x" * (1024 * 1024)
    sealed = encrypt_blob(plaintext, key)
    assert decrypt_blob(sealed, key) == plaintext


# ---------------------------------------------------------------------------
# Sealed-blob layout
# ---------------------------------------------------------------------------


def test_sealed_blob_layout_is_nonce_then_ciphertext_with_tag():
    """Output must be `nonce(12) || ciphertext || tag(16)`. For a
    plaintext of length N, the sealed length is N + 12 + 16."""
    key = generate_key()
    plaintext = b"abc"
    sealed = encrypt_blob(plaintext, key)
    assert len(sealed) == len(plaintext) + NONCE_BYTES + TAG_BYTES


def test_each_encryption_uses_a_fresh_nonce():
    """Two calls with the same (key, plaintext) must produce different
    sealed blobs — otherwise nonce reuse would leak plaintext under
    GCM."""
    key = generate_key()
    plaintext = b"deterministic plaintext"
    a = encrypt_blob(plaintext, key)
    b = encrypt_blob(plaintext, key)
    assert a != b
    # Specifically: the first 12 bytes (the nonce) must differ.
    assert a[:NONCE_BYTES] != b[:NONCE_BYTES]


# ---------------------------------------------------------------------------
# Integrity / authentication guarantees
# ---------------------------------------------------------------------------


def test_wrong_key_fails():
    sealed = encrypt_blob(b"secret", generate_key())
    other_key = generate_key()
    with pytest.raises(InvalidTag):
        decrypt_blob(sealed, other_key)


def test_tampered_ciphertext_fails():
    key = generate_key()
    sealed = bytearray(encrypt_blob(b"some plaintext bytes", key))
    # Flip one bit in the ciphertext region (after the nonce).
    sealed[NONCE_BYTES + 2] ^= 0x01
    with pytest.raises(InvalidTag):
        decrypt_blob(bytes(sealed), key)


def test_mismatched_associated_data_fails():
    key = generate_key()
    sealed = encrypt_blob(b"x", key, associated_data=b"context-A")
    with pytest.raises(InvalidTag):
        decrypt_blob(sealed, key, associated_data=b"context-B")


def test_omitted_associated_data_fails():
    """If encryption used AAD, decryption MUST also pass it — passing
    None must NOT silently ignore the AAD."""
    key = generate_key()
    sealed = encrypt_blob(b"x", key, associated_data=b"context")
    with pytest.raises(InvalidTag):
        decrypt_blob(sealed, key, associated_data=None)


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def test_rejects_short_key_on_encrypt():
    with pytest.raises(ValueError):
        encrypt_blob(b"x", b"short-key")


def test_rejects_short_key_on_decrypt():
    sealed = encrypt_blob(b"x", generate_key())
    with pytest.raises(ValueError):
        decrypt_blob(sealed, b"short-key")


def test_rejects_truncated_sealed_blob():
    """A sealed blob shorter than nonce+tag can't possibly be valid."""
    with pytest.raises(ValueError):
        decrypt_blob(b"too-short", generate_key())


def test_generate_key_returns_32_bytes():
    key = generate_key()
    assert len(key) == KEY_BYTES
    # Two consecutive calls should be different — extremely likely to pass
    # unless os.urandom is broken.
    assert generate_key() != key
